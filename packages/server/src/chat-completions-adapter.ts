/**
 * Custom adapter for OpenAI-compatible /chat/completions endpoints.
 *
 * This adapter speaks the chat/completions SSE protocol (not the Responses API)
 * and emits AG-UI compatible events that can be consumed by stream consumers.
 *
 * Note: This is a standalone implementation that doesn't extend TanStack AI's
 * BaseTextAdapter due to the complexity of its generic type parameters.
 * It provides the same interface shape for our specific use case.
 */

export type ChatCompletionsAdapterConfig = {
  baseUrl: string;
  apiKey: string;
};

export type ChatCompletionsUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
};

/**
 * Simplified model message format compatible with TanStack AI's ModelMessage.
 */
export type SimpleModelMessage = {
  role: "user" | "assistant" | "system";
  content: string | ContentPart[];
};

export type ContentPart =
  | string
  | { type: "text"; content: string }
  | { type: "image"; source: { type: "url"; value: string } };

/**
 * Options for text/chat operations.
 */
export type SimpleChatOptions = {
  messages: SimpleModelMessage[];
  systemPrompts?: string[];
  temperature?: number;
  maxTokens?: number;
  abortController?: AbortController;
};

/**
 * AG-UI compatible stream events.
 */
export type StreamEvent =
  | { type: "RUN_STARTED"; runId: string }
  | {
      type: "RUN_FINISHED";
      runId: string;
      finishReason: "stop" | "length" | "tool_calls" | null;
      usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        reasoningTokens?: number;
      };
    }
  | { type: "RUN_ERROR"; runId?: string; error: { message: string; code?: string } }
  | { type: "TEXT_MESSAGE_START"; messageId: string; role: "assistant" }
  | { type: "TEXT_MESSAGE_CONTENT"; messageId: string; delta: string }
  | { type: "TEXT_MESSAGE_END"; messageId: string }
  | { type: "STEP_STARTED"; runId: string; stepId: string; stepType: string }
  | {
      type: "STEP_FINISHED";
      runId: string;
      stepId: string;
      stepType: string;
      metadata?: { reasoningTokens?: number };
    };

/**
 * Extracts reasoning tokens from a usage object by performing a deep search.
 * Handles multiple naming conventions (snake_case, camelCase) and nested structures.
 */
function extractReasoningTokens(usage: unknown): number | null {
  if (!usage || typeof usage !== "object") return null;

  const queue: Record<string, unknown>[] = [usage as Record<string, unknown>];
  const seen = new Set<Record<string, unknown>>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);

    const value = current.reasoning_tokens ?? current.reasoningTokens;
    if (value !== undefined) {
      const tokens =
        typeof value === "number"
          ? value
          : typeof value === "string" && value.trim()
            ? Number(value)
            : NaN;
      if (Number.isFinite(tokens)) {
        return Math.max(0, Math.round(tokens));
      }
    }

    for (const key of [
      "completion_tokens_details",
      "completionTokensDetails",
      "output_tokens_details",
      "outputTokensDetails",
      "details",
      "usage",
    ]) {
      const nested = current[key];
      if (nested && typeof nested === "object") {
        queue.push(nested as Record<string, unknown>);
      }
    }
  }

  return null;
}

/**
 * Converts SimpleModelMessage format to OpenAI chat/completions message format.
 */
function convertToOpenAIMessages(
  messages: SimpleModelMessage[],
  systemPrompts: string[] = [],
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];

  // Add system prompts first
  for (const systemPrompt of systemPrompts) {
    if (systemPrompt.trim()) {
      result.push({
        role: "system",
        content: systemPrompt,
      });
    }
  }

  // Convert each message
  for (const message of messages) {
    const content = convertMessageContent(message.content);
    if (content === null) continue;

    result.push({
      role: message.role,
      content,
    });
  }

  return result;
}

/**
 * Converts message content to OpenAI format.
 */
function convertMessageContent(
  content: SimpleModelMessage["content"],
): string | Array<Record<string, unknown>> | null {
  // String content passes through
  if (typeof content === "string") {
    return content;
  }

  // Array content needs conversion
  if (Array.isArray(content)) {
    const parts: Array<Record<string, unknown>> = [];

    for (const part of content) {
      if (typeof part === "string") {
        parts.push({ type: "text", text: part });
        continue;
      }

      if (part.type === "text") {
        parts.push({ type: "text", text: part.content });
        continue;
      }

      if (part.type === "image") {
        // Handle image parts - source is URL-based
        const source = part.source;
        if (source.type === "url") {
          parts.push({
            type: "image_url",
            image_url: { url: source.value },
          });
        }
        continue;
      }
    }

    // If only one text part, return as string for compatibility
    if (parts.length === 1 && parts[0].type === "text") {
      return parts[0].text as string;
    }

    return parts.length > 0 ? parts : null;
  }

  return null;
}

/**
 * Extracts text content from a chat completion response.
 */
function extractChatCompletionText(
  content: string | Array<{ type?: string; text?: string }> | undefined,
): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text!.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

export class ChatCompletionsAdapter {
  private readonly config: ChatCompletionsAdapterConfig;
  private readonly modelId: string;

  constructor(config: ChatCompletionsAdapterConfig, modelId: string) {
    this.config = config;
    this.modelId = modelId;
  }

  /**
   * Streaming chat completion that yields AG-UI events.
   */
  async *chatStream(options: SimpleChatOptions): AsyncIterable<StreamEvent> {
    const messages = convertToOpenAIMessages(options.messages, options.systemPrompts);

    const runId = crypto.randomUUID();
    const messageId = crypto.randomUUID();

    // Emit RUN_STARTED
    yield {
      type: "RUN_STARTED",
      runId,
    };

    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.modelId,
        stream: true,
        stream_options: { include_usage: true },
        messages,
        ...(options.temperature !== undefined && {
          temperature: options.temperature,
        }),
        ...(options.maxTokens !== undefined && {
          max_tokens: options.maxTokens,
        }),
      }),
      signal: options.abortController?.signal,
    });

    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => "Unknown error");
      yield {
        type: "RUN_ERROR",
        runId,
        error: {
          message: `HTTP ${response.status}: ${errorText.slice(0, 500)}`,
          code: String(response.status),
        },
      };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let messageStarted = false;
    let thinkingStepId: string | null = null;
    let usage: ChatCompletionsUsage = {
      promptTokens: null,
      completionTokens: null,
      reasoningTokens: null,
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE blocks (delimited by \n\n)
        while (buffer.includes("\n\n")) {
          const idx = buffer.indexOf("\n\n");
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          // Extract data lines
          const dataLines = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim());

          if (dataLines.length === 0) continue;

          const payloadJson = dataLines.join("\n");
          if (payloadJson === "[DONE]") continue;

          let parsed: any;
          try {
            parsed = JSON.parse(payloadJson);
          } catch {
            continue;
          }

          // Extract usage information
          if (parsed.usage) {
            usage.promptTokens = parsed.usage.prompt_tokens ?? null;
            usage.completionTokens = parsed.usage.completion_tokens ?? null;
            const reasoningTokens = extractReasoningTokens(parsed.usage);
            if (reasoningTokens !== null) {
              usage.reasoningTokens = reasoningTokens;

              // Emit thinking step for reasoning tokens
              if (thinkingStepId === null) {
                thinkingStepId = crypto.randomUUID();
                yield {
                  type: "STEP_STARTED",
                  runId,
                  stepId: thinkingStepId,
                  stepType: "thinking",
                };
              }
            }
          }

          // Extract content delta
          const delta = parsed.choices?.[0]?.delta?.content ?? "";
          if (!delta) continue;

          // Emit TEXT_MESSAGE_START on first content
          if (!messageStarted) {
            messageStarted = true;
            yield {
              type: "TEXT_MESSAGE_START",
              messageId,
              role: "assistant",
            };
          }

          // Emit TEXT_MESSAGE_CONTENT for each delta
          yield {
            type: "TEXT_MESSAGE_CONTENT",
            messageId,
            delta,
          };
        }
      }

      // Finish thinking step if started
      if (thinkingStepId !== null) {
        yield {
          type: "STEP_FINISHED",
          runId,
          stepId: thinkingStepId,
          stepType: "thinking",
          metadata: {
            reasoningTokens: usage.reasoningTokens ?? undefined,
          },
        };
      }

      // Emit TEXT_MESSAGE_END if message was started
      if (messageStarted) {
        yield {
          type: "TEXT_MESSAGE_END",
          messageId,
        };
      }

      // Emit RUN_FINISHED with usage
      yield {
        type: "RUN_FINISHED",
        runId,
        finishReason: "stop",
        usage:
          usage.promptTokens !== null || usage.completionTokens !== null
            ? {
                promptTokens: usage.promptTokens ?? 0,
                completionTokens: usage.completionTokens ?? 0,
                totalTokens: (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0),
                reasoningTokens: usage.reasoningTokens ?? undefined,
              }
            : undefined,
      };
    } catch (error) {
      yield {
        type: "RUN_ERROR",
        runId,
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: "stream_error",
        },
      };
    }
  }

  /**
   * Non-streaming text completion.
   */
  async text(options: SimpleChatOptions): Promise<string> {
    const messages = convertToOpenAIMessages(options.messages, options.systemPrompts);

    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.modelId,
        stream: false,
        messages,
        ...(options.temperature !== undefined && {
          temperature: options.temperature,
        }),
        ...(options.maxTokens !== undefined && {
          max_tokens: options.maxTokens,
        }),
      }),
      signal: options.abortController?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 500)}`);
    }

    const json = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | Array<{ type?: string; text?: string }>;
        };
      }>;
    };

    return extractChatCompletionText(json.choices?.[0]?.message?.content);
  }
}

/**
 * Factory function to create a ChatCompletionsAdapter instance.
 */
export function createChatCompletionsAdapter(
  config: ChatCompletionsAdapterConfig,
  modelId: string,
): ChatCompletionsAdapter {
  return new ChatCompletionsAdapter(config, modelId);
}
