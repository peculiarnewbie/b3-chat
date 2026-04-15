/**
 * Stream consumer for AG-UI compatible stream events.
 *
 * Consumes AsyncIterable<StreamEvent> from the adapter and drives the existing
 * event pipeline (broadcast, delta batching, activity reporting, etc.).
 */

import type { StreamEvent } from "@b3-chat/server";
import { nowIso, type MessagePart } from "@b3-chat/domain";
import type { SearchProgressEvent } from "./search";

/** Threshold for flushing accumulated deltas to the client */
const DELTA_FLUSH_THRESHOLD = 96;

/** Interval for reporting thinking tokens progress */
const THINKING_TOKEN_REPORT_INTERVAL = 32;

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
    kind: string,
    input: { text?: string; json?: string | null },
  ) => Promise<MessagePart>;
  /** Reports activity progress events */
  reportActivity: (event: SearchProgressEvent) => Promise<void>;
  /** The assistant message ID being streamed */
  messageId: string;
  /** Logging function */
  log?: (message: string, details?: Record<string, unknown>) => void;
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
 * Consumes an AG-UI event stream and maps events to the existing event system.
 *
 * This function maintains delta batching behavior (96 chars or newline threshold)
 * and timing metrics (TTFT, duration).
 */
export async function consumeAssistantStream(
  stream: AsyncIterable<StreamEvent>,
  deps: StreamConsumerDeps,
): Promise<StreamConsumerResult> {
  const { appendServerEvent, broadcast, appendMessagePart, reportActivity, messageId, log } = deps;

  const streamStartedAt = Date.now();
  let firstTokenAt: number | null = null;
  let accumulated = "";
  let pendingDelta = "";
  let chunkCount = 0;
  let deltaCount = 0;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let reasoningTokens: number | null = null;
  let lastReportedReasoningTokens: number | null = null;
  let responseStartedReported = false;

  const flushDelta = async () => {
    if (!pendingDelta) return;
    deltaCount += 1;
    accumulated += pendingDelta;
    const deltaEvent = await appendServerEvent(null, "message_delta", {
      messageId,
      delta: pendingDelta,
      updatedAt: nowIso(),
    });
    broadcast(deltaEvent);
    log?.("assistant_turn_delta", {
      assistantMessageId: messageId,
      chars: pendingDelta.length,
      totalChars: accumulated.length,
    });
    pendingDelta = "";
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
          const delta = chunk.delta;
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

        case "STEP_FINISHED": {
          // Handle thinking step completion with reasoning tokens
          if (chunk.stepType === "thinking" && chunk.metadata?.reasoningTokens != null) {
            const tokens = chunk.metadata.reasoningTokens;
            reasoningTokens = tokens;
            if (
              lastReportedReasoningTokens === null ||
              tokens - lastReportedReasoningTokens >= THINKING_TOKEN_REPORT_INTERVAL
            ) {
              await flushThinkingTokens(tokens);
            }
          }
          break;
        }

        case "RUN_FINISHED": {
          // Extract usage from the event
          const usage = chunk.usage;

          if (usage) {
            promptTokens = usage.promptTokens ?? null;
            completionTokens = usage.completionTokens ?? null;
            if (usage.reasoningTokens != null) {
              reasoningTokens = usage.reasoningTokens;
            }
          }

          // Flush final delta if any
          await flushDelta();

          // Report final reasoning tokens if not yet reported
          if (reasoningTokens != null && reasoningTokens !== lastReportedReasoningTokens) {
            await flushThinkingTokens(reasoningTokens);
          }

          const durationMs = Date.now() - streamStartedAt;
          const ttftMs = firstTokenAt !== null ? firstTokenAt - streamStartedAt : null;

          // Emit message_completed event
          const completed = await appendServerEvent(null, "message_completed", {
            messageId,
            text: accumulated,
            updatedAt: nowIso(),
            durationMs,
            ttftMs,
            promptTokens,
            completionTokens,
          });
          broadcast(completed);

          await reportActivity({
            label: "Response complete",
            state: "completed",
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
            promptTokens,
            completionTokens,
            reasoningTokens,
            success: true,
          };
        }

        case "RUN_ERROR": {
          const errorMessage = chunk.error?.message ?? "Unknown error";

          // Emit message_failed event
          const failed = await appendServerEvent(null, "message_failed", {
            messageId,
            errorCode: chunk.error?.code ?? "stream_error",
            errorMessage,
            updatedAt: nowIso(),
          });
          broadcast(failed);

          await reportActivity({
            label: "Response failed",
            state: "failed",
            detail: errorMessage,
          });

          log?.("assistant_turn_failed", {
            assistantMessageId: messageId,
            chunkCount,
            deltaCount,
            error: errorMessage,
          });

          return {
            text: accumulated,
            durationMs: Date.now() - streamStartedAt,
            ttftMs: firstTokenAt !== null ? firstTokenAt - streamStartedAt : null,
            promptTokens,
            completionTokens,
            reasoningTokens,
            success: false,
            errorMessage,
          };
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
      const completed = await appendServerEvent(null, "message_completed", {
        messageId,
        text: accumulated,
        updatedAt: nowIso(),
        durationMs,
        ttftMs,
        promptTokens,
        completionTokens,
      });
      broadcast(completed);
    }

    return {
      text: accumulated,
      durationMs,
      ttftMs,
      promptTokens,
      completionTokens,
      reasoningTokens,
      success: true,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Emit message_failed event
    const failed = await appendServerEvent(null, "message_failed", {
      messageId,
      errorCode: "stream_error",
      errorMessage,
      updatedAt: nowIso(),
    });
    broadcast(failed);

    await reportActivity({
      label: "Response failed",
      state: "failed",
      detail: errorMessage,
    });

    log?.("assistant_turn_failed", {
      assistantMessageId: messageId,
      chunkCount,
      deltaCount,
      error: errorMessage,
    });

    return {
      text: accumulated,
      durationMs: Date.now() - streamStartedAt,
      ttftMs: firstTokenAt !== null ? firstTokenAt - streamStartedAt : null,
      promptTokens,
      completionTokens,
      reasoningTokens,
      success: false,
      errorMessage,
    };
  }
}
