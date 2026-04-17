/**
 * Stream consumer for TanStack AI AG-UI stream events.
 *
 * Consumes AsyncIterable<ExtendedStreamChunk> from TanStack AI's chat() function
 * and drives the existing event pipeline (broadcast, delta batching,
 * activity reporting, etc.).
 */

import type { ExtendedStreamChunk } from "@b3-chat/server";
import { nowIso, type MessagePart, type TraceSpanKind } from "@b3-chat/domain";
import type { SearchProgressEvent } from "./search";
import { normalizeAssistantError } from "./error-normalization";

/** Threshold for flushing accumulated deltas to the client */
const DELTA_FLUSH_THRESHOLD = 96;

export type StreamConsumerDeps = {
  /** Appends a server event to the event log and returns the event */
  appendServerEvent: <T extends string>(
    opId: string | null,
    eventType: T,
    payload: Record<string, unknown>,
  ) => Promise<{
    type: string;
    serverSeq: number;
    eventId: string;
    eventType: T;
    payload: Record<string, unknown>;
  }>;
  /** Broadcasts an event to all connected clients */
  broadcast: (envelope: Record<string, unknown>) => void;
  /**
   * Appends a message part (activity, thinking tokens, text).
   *
   * When `kind !== "text"`, this will first flush any buffered text deltas
   * and commit a `text` part covering text accumulated since the last
   * commit — so activity chips interleave with text in seq order.
   */
  appendMessagePart: (
    kind: "activity" | "thinking_tokens" | "text",
    input: { text?: string; json?: string | null },
  ) => Promise<MessagePart>;
  /**
   * Raw append that bypasses the auto-commit wrapper. Used internally by
   * the stream consumer's own text-commit helper to avoid recursion.
   */
  rawAppendMessagePart?: (
    kind: "activity" | "thinking_tokens" | "text",
    input: { text?: string; json?: string | null },
  ) => Promise<MessagePart>;
  /**
   * Registers the consumer's commitPendingText function with the caller.
   * The caller invokes this before appending any non-text message_part so
   * that buffered text is flushed and committed as a text part first,
   * preserving seq ordering between text and activities.
   */
  setCommitPendingText?: (commit: () => Promise<void>) => void;
  /** Reports activity progress events */
  reportActivity: (event: SearchProgressEvent) => Promise<void>;
  /** The assistant message ID being streamed */
  messageId: string;
  /** Logging function */
  log?: (message: string, details?: Record<string, unknown>) => void;
  /** Optional tracing wrapper for stream sub-operations */
  trace?: <A>(
    name: string,
    kind: TraceSpanKind,
    attrs: Record<string, unknown>,
    run: () => Promise<A>,
  ) => Promise<A>;
};

export type StreamConsumerResult = {
  /** Total accumulated text from the stream */
  text: string;
  /** Duration from stream start to completion in ms */
  durationMs: number;
  /** Time to first token in ms, or null if no tokens received */
  ttftMs: number | null;
  /** Number of prompt tokens used */
  promptTokens: number | null;
  /** Number of completion tokens generated */
  completionTokens: number | null;
  /** Number of reasoning tokens used (for extended thinking models) */
  reasoningTokens: number | null;
  /** Whether the stream completed successfully */
  success: boolean;
  /** Error message if the stream failed */
  errorMessage?: string;
  /** Number of tool-call iterations observed in this turn (0 if no tools used) */
  toolCallIterations: number;
  /** Tool names actually invoked this turn */
  toolNamesUsed: string[];
};

/**
 * Consumes a TanStack AI stream and maps AG-UI events to the existing event system.
 *
 * This function maintains delta batching behavior (96 chars or newline threshold)
 * and timing metrics (TTFT, duration).
 */
export async function consumeAssistantStream(
  stream: AsyncIterable<ExtendedStreamChunk>,
  deps: StreamConsumerDeps,
): Promise<StreamConsumerResult> {
  const { appendServerEvent, broadcast, appendMessagePart, reportActivity, messageId, log } = deps;
  /**
   * Raw append bypasses the auto-commit wrapper. When our commitPendingText
   * helper emits a `text` part, it must not recurse. If the caller did not
   * supply a raw variant, fall back to appendMessagePart (safe because the
   * wrapper skips commit for `kind === "text"`).
   */
  const rawAppendMessagePart = deps.rawAppendMessagePart ?? appendMessagePart;
  const trace =
    deps.trace ??
    ((_: string, __: TraceSpanKind, ___: Record<string, unknown>, run: () => Promise<any>) =>
      run());

  const streamStartedAt = Date.now();
  let firstTokenAt: number | null = null;
  let accumulated = "";
  let pendingDelta = "";
  /** Number of accumulated chars already committed as `text` message_parts. */
  let committedTextLength = 0;
  let chunkCount = 0;
  let deltaCount = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let reasoningTokens = 0;
  let sawUsage = false;
  let sawReasoningTokens = false;
  let lastReportedReasoningTokens: number | null = null;
  let responseStartedReported = false;
  /**
   * Count of completed tool-call iterations observed from the adapter.
   * We bump this on each RUN_FINISHED with finishReason "tool_calls".
   * This is our primary observability signal for "stuck" agent loops —
   * if a user reports a hang, the log will show how many iterations ran
   * and with which tools.
   */
  let toolCallIterations = 0;
  /** Track tool calls started / ended per iteration, to spot adapter-level
   *  issues (e.g., stream ended without TOOL_CALL_END).
   *
   *  TanStack AI emits TOOL_CALL_END *twice* per logical tool call:
   *  - Once by the adapter when the model finishes emitting args
   *    (shape: { toolCallId, toolName, input? } — no `result` field).
   *  - Once by the engine after local tool execution during the continuation
   *    pass (shape: { toolCallId, toolName, result } — no `input` field).
   *  We count these separately so the log ratio (started : emissionEnded)
   *  should stay 1:1 while resultEnded tracks actual execution. */
  let toolCallsStarted = 0;
  let toolCallEmissionsEnded = 0;
  let toolCallResultsEnded = 0;
  const toolNamesSeen = new Set<string>();

  const flushDelta = async () => {
    if (!pendingDelta) return;
    const delta = pendingDelta;
    pendingDelta = "";
    await trace(
      "assistant.stream.delta.flush",
      "io",
      { messageId, chars: delta.length },
      async () => {
        deltaCount += 1;
        accumulated += delta;
        const deltaEvent = await appendServerEvent(null, "message_delta", {
          messageId,
          delta,
          updatedAt: nowIso(),
        });
        broadcast(deltaEvent);
        log?.("assistant_turn_delta", {
          assistantMessageId: messageId,
          chars: delta.length,
          totalChars: accumulated.length,
        });
      },
    );
  };

  /**
   * Commits any text accumulated since the last commit as a `text`
   * message_part. Called automatically before each non-text part is
   * appended (via the sync-engine wrapper) so that text and activity
   * chips interleave in the correct seq order in the UI.
   *
   * Uses `rawAppendMessagePart` to skip the auto-commit wrapper and
   * avoid infinite recursion.
   */
  const commitPendingText = async () => {
    await flushDelta();
    if (accumulated.length <= committedTextLength) return;
    const chunk = accumulated.slice(committedTextLength);
    committedTextLength = accumulated.length;
    await rawAppendMessagePart("text", { text: chunk });
  };

  deps.setCommitPendingText?.(commitPendingText);

  const completeMessage = async () => {
    // Commit any remaining text as a final text part before emitting the
    // terminal `message_completed` event, so the interleaved-layout client
    // sees all text persisted as parts by the time the message is marked
    // completed.
    await commitPendingText();

    const durationMs = Date.now() - streamStartedAt;
    const ttftMs = firstTokenAt !== null ? firstTokenAt - streamStartedAt : null;

    await trace("assistant.message.complete", "sync", { messageId, durationMs }, async () => {
      const completed = await appendServerEvent(null, "message_completed", {
        messageId,
        text: accumulated,
        updatedAt: nowIso(),
        durationMs,
        ttftMs,
        promptTokens: sawUsage ? promptTokens : null,
        completionTokens: sawUsage ? completionTokens : null,
      });
      broadcast(completed);
      await reportActivity({
        label: "Response complete",
        state: "completed",
      });
    });

    log?.("assistant_turn_completed", {
      assistantMessageId: messageId,
      chunkCount,
      deltaCount,
      totalChars: accumulated.length,
      toolCallIterations,
      toolNamesUsed: [...toolNamesSeen],
      preview: accumulated.replace(/\s+/g, " ").trim().slice(0, 160),
    });

    return {
      text: accumulated,
      durationMs,
      ttftMs,
      promptTokens: sawUsage ? promptTokens : null,
      completionTokens: sawUsage ? completionTokens : null,
      reasoningTokens: sawReasoningTokens ? reasoningTokens : null,
      success: true,
      toolCallIterations,
      toolNamesUsed: [...toolNamesSeen],
    } satisfies StreamConsumerResult;
  };

  const failMessage = async (normalizedError: ReturnType<typeof normalizeAssistantError>) => {
    // Commit any partial text so it renders before the failure chip in
    // the interleaved layout.
    await commitPendingText();
    return trace(
      "assistant.message.fail",
      "sync",
      { messageId, errorCode: normalizedError.errorCode },
      async () => {
        const failed = await appendServerEvent(null, "message_failed", {
          messageId,
          errorCode: normalizedError.errorCode,
          errorMessage: normalizedError.errorMessage,
          updatedAt: nowIso(),
        });
        broadcast(failed);

        await reportActivity({
          label: "Response failed",
          state: "failed",
          detail: normalizedError.errorMessage,
        });

        log?.("assistant_turn_failed", {
          assistantMessageId: messageId,
          chunkCount,
          deltaCount,
          toolCallIterations,
          toolNamesUsed: [...toolNamesSeen],
          error: normalizedError.errorMessage,
          normalizedErrorCode: normalizedError.errorCode,
          providerName: normalizedError.providerName,
          retryable: normalizedError.retryable,
        });

        return {
          text: accumulated,
          durationMs: Date.now() - streamStartedAt,
          ttftMs: firstTokenAt !== null ? firstTokenAt - streamStartedAt : null,
          promptTokens: sawUsage ? promptTokens : null,
          completionTokens: sawUsage ? completionTokens : null,
          reasoningTokens: sawReasoningTokens ? reasoningTokens : null,
          success: false,
          errorMessage: normalizedError.errorMessage,
          toolCallIterations,
          toolNamesUsed: [...toolNamesSeen],
        } satisfies StreamConsumerResult;
      },
    );
  };

  const flushThinkingTokens = async (tokens: number) => {
    if (lastReportedReasoningTokens != null && tokens <= lastReportedReasoningTokens) {
      return;
    }
    lastReportedReasoningTokens = tokens;
    const part = await appendMessagePart("thinking_tokens", {
      text: String(tokens),
      json: JSON.stringify({ tokens }),
    });
    log?.("assistant_turn_thinking_tokens", {
      assistantMessageId: messageId,
      seq: part.seq,
      thinkingTokens: tokens,
    });
  };

  try {
    /**
     * Emit an empty `text` message_part up front so the client can detect
     * new-format (interleaved) messages immediately, even before the first
     * token arrives. Pre-existing messages never have this part and fall
     * through to the legacy grouped-activity layout.
     */
    await rawAppendMessagePart("text", { text: "" });

    for await (const chunk of stream) {
      chunkCount += 1;

      switch (chunk.type) {
        case "TEXT_MESSAGE_START": {
          // First content is about to arrive
          break;
        }

        case "TEXT_MESSAGE_CONTENT": {
          const delta = (chunk as { delta?: string }).delta;
          if (!delta) continue;

          // Track time to first token
          if (firstTokenAt === null) {
            firstTokenAt = Date.now();
          }

          // Report streaming started once
          if (!responseStartedReported) {
            responseStartedReported = true;
            await reportActivity({
              label: "Response streaming",
              state: "completed",
            });
          }

          // Batch deltas and flush at threshold
          pendingDelta += delta;
          if (pendingDelta.length >= DELTA_FLUSH_THRESHOLD || /\n/.test(pendingDelta)) {
            await flushDelta();
          }
          break;
        }

        case "TEXT_MESSAGE_END": {
          // Flush any remaining delta
          await flushDelta();
          break;
        }

        case "TOOL_CALL_START": {
          toolCallsStarted += 1;
          const toolName = (chunk as { toolName?: string }).toolName;
          if (toolName) toolNamesSeen.add(toolName);
          log?.("assistant_turn_tool_call_start", {
            assistantMessageId: messageId,
            toolName: toolName ?? null,
            iteration: toolCallIterations + 1,
            started: toolCallsStarted,
          });
          break;
        }

        case "TOOL_CALL_END": {
          const endChunk = chunk as { toolName?: string; result?: unknown };
          // Distinguish adapter-emitted (args done) vs engine-emitted (result available).
          // The engine's TOOL_CALL_END includes a `result` field, the adapter's does not.
          const hasResult = "result" in endChunk && endChunk.result !== undefined;
          const phase: "emission" | "result" = hasResult ? "result" : "emission";
          if (phase === "emission") {
            toolCallEmissionsEnded += 1;
          } else {
            toolCallResultsEnded += 1;
          }
          log?.("assistant_turn_tool_call_end", {
            assistantMessageId: messageId,
            toolName: endChunk.toolName ?? null,
            iteration: toolCallIterations + 1,
            phase,
            emissionsEnded: toolCallEmissionsEnded,
            resultsEnded: toolCallResultsEnded,
          });
          break;
        }

        case "RUN_FINISHED": {
          // Extract usage from the event
          const finishedChunk = chunk as {
            finishReason?: string | null;
            usage?: { promptTokens: number; completionTokens: number };
            _reasoningTokens?: number;
          };

          if (finishedChunk.usage) {
            sawUsage = true;
            promptTokens += finishedChunk.usage.promptTokens ?? 0;
            completionTokens += finishedChunk.usage.completionTokens ?? 0;
          }

          // Check for custom reasoning tokens field
          if (finishedChunk._reasoningTokens != null) {
            sawReasoningTokens = true;
            reasoningTokens += finishedChunk._reasoningTokens;
          }

          if (finishedChunk.finishReason === "tool_calls") {
            toolCallIterations += 1;
            log?.("assistant_turn_tool_iteration_finished", {
              assistantMessageId: messageId,
              iteration: toolCallIterations,
              toolNames: [...toolNamesSeen],
              toolCallsStarted,
              toolCallEmissionsEnded,
              toolCallResultsEnded,
              elapsedMs: Date.now() - streamStartedAt,
            });
            await flushDelta();
            if (sawReasoningTokens && reasoningTokens !== lastReportedReasoningTokens) {
              await flushThinkingTokens(reasoningTokens);
            }
            break;
          }

          // Flush final delta if any
          await flushDelta();

          // Report final reasoning tokens if not yet reported
          if (reasoningTokens != null && reasoningTokens !== lastReportedReasoningTokens) {
            await flushThinkingTokens(reasoningTokens);
          }

          log?.("assistant_turn_run_finished", {
            assistantMessageId: messageId,
            finishReason: finishedChunk.finishReason ?? null,
            toolCallIterations,
            toolNames: [...toolNamesSeen],
            elapsedMs: Date.now() - streamStartedAt,
          });

          return completeMessage();
        }

        case "RUN_ERROR": {
          const errorChunk = chunk as { error?: { message?: string; code?: string } };
          const normalizedError = normalizeAssistantError({
            errorCode: errorChunk.error?.code,
            errorMessage: errorChunk.error?.message ?? "Unknown error",
          });

          return failMessage(normalizedError);
        }

        // Ignore other event types (RUN_STARTED, STEP_STARTED, etc.)
        default:
          break;
      }
    }

    // Stream ended without RUN_FINISHED or RUN_ERROR - treat as unexpected completion
    await flushDelta();
    // Commit any remaining uncommitted text as a final text part so the
    // interleaved-layout client renders the complete response.
    await commitPendingText();
    const durationMs = Date.now() - streamStartedAt;
    const ttftMs = firstTokenAt !== null ? firstTokenAt - streamStartedAt : null;

    // Still emit completion since we have accumulated text
    if (accumulated) {
      await trace("assistant.message.complete", "sync", { messageId, durationMs }, async () => {
        const completed = await appendServerEvent(null, "message_completed", {
          messageId,
          text: accumulated,
          updatedAt: nowIso(),
          durationMs,
          ttftMs,
          promptTokens: sawUsage ? promptTokens : null,
          completionTokens: sawUsage ? completionTokens : null,
        });
        broadcast(completed);
      });
    }

    log?.("assistant_turn_stream_ended_without_finish", {
      assistantMessageId: messageId,
      chunkCount,
      deltaCount,
      toolCallIterations,
      toolNamesUsed: [...toolNamesSeen],
      totalChars: accumulated.length,
      durationMs,
    });

    return {
      text: accumulated,
      durationMs,
      ttftMs,
      promptTokens: sawUsage ? promptTokens : null,
      completionTokens: sawUsage ? completionTokens : null,
      reasoningTokens: sawReasoningTokens ? reasoningTokens : null,
      success: true,
      toolCallIterations,
      toolNamesUsed: [...toolNamesSeen],
    };
  } catch (error) {
    const normalizedError = normalizeAssistantError({
      errorCode: "stream_error",
      errorMessage: error instanceof Error ? error.message : String(error),
    });

    return failMessage(normalizedError);
  }
}
