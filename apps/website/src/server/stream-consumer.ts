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
  /** Appends a message part (activity, thinking tokens, etc.) */
  appendMessagePart: (
    kind: "activity" | "thinking_tokens",
    input: { text?: string; json?: string | null },
  ) => Promise<MessagePart>;
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
  const trace =
    deps.trace ??
    ((_: string, __: TraceSpanKind, ___: Record<string, unknown>, run: () => Promise<any>) =>
      run());

  const streamStartedAt = Date.now();
  let firstTokenAt: number | null = null;
  let accumulated = "";
  let pendingDelta = "";
  let chunkCount = 0;
  let deltaCount = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let reasoningTokens = 0;
  let sawUsage = false;
  let sawReasoningTokens = false;
  let lastReportedReasoningTokens: number | null = null;
  let responseStartedReported = false;

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

  const completeMessage = async () => {
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
    } satisfies StreamConsumerResult;
  };

  const failMessage = async (normalizedError: ReturnType<typeof normalizeAssistantError>) => {
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

    return {
      text: accumulated,
      durationMs,
      ttftMs,
      promptTokens: sawUsage ? promptTokens : null,
      completionTokens: sawUsage ? completionTokens : null,
      reasoningTokens: sawReasoningTokens ? reasoningTokens : null,
      success: true,
    };
  } catch (error) {
    const normalizedError = normalizeAssistantError({
      errorCode: "stream_error",
      errorMessage: error instanceof Error ? error.message : String(error),
    });

    return failMessage(normalizedError);
  }
}
