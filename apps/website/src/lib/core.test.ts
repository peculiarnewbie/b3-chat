import {
  buildMultiSearchContext,
  createAttachment,
  createMessage,
  createThread,
  createWorkspace,
  mergeAttachmentLink,
  resolveThreadMessagePath,
  sortConversationMessages,
  slugify,
} from "@b3-chat/domain";
import {
  allowedEmail,
  chat,
  clampExaResults,
  createChatCompletionsAdapter,
  extractReasoningTokens,
  extractChatCompletionText,
  filterModelsCatalog,
  getSignedAttachmentUrl,
  isImageAttachment,
  isInlineTextAttachment,
  normalizeEmail,
  parseExaMcpTextResponse,
  verifyUploadToken,
} from "@b3-chat/server";
import { toolDefinition } from "@tanstack/ai";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { explainAssistantError } from "./assistant-errors";
import { editUserMessageAction, retryMessageAction, sendMessageAction } from "./actions";
import {
  applyLocalInsert,
  attachments,
  messages,
  resetCollections,
  threads,
  workspaces,
} from "./collections";
import {
  activateWorkspaceDraftView,
  clearAllDraftState,
  consumePendingDraftAttachmentCleanup,
  ensureWorkspaceDraft,
  getWorkspaceConversationView,
  getWorkspaceDraft,
  reconcileDraftState,
  removeWorkspaceDraftAttachment,
  updateWorkspaceDraft,
} from "./draft-state";
import { resetPendingOps } from "./pending-ops";
import { processEnvelopes } from "./sync-adapter";
import { normalizeAssistantError } from "../server/error-normalization";
import { getProviderModelOptions } from "../server/sync-engine";

beforeEach(() => {
  resetCollections();
  resetPendingOps();
  clearAllDraftState();
  if (typeof localStorage !== "undefined") {
    localStorage.clear();
  }
});

describe("domain helpers", () => {
  it("slugifies workspace names", () => {
    expect(slugify("  My Personal Workspace!! ")).toBe("my-personal-workspace");
  });

  it("creates attachments in a queued state", () => {
    const attachment = createAttachment({
      threadId: "thd_123",
      objectKey: "thd_123/file.txt",
      fileName: "file.txt",
      mimeType: "text/plain",
      sizeBytes: 128,
    });

    expect(attachment.status).toBe("queued");
    expect(attachment.threadId).toBe("thd_123");
  });

  it("preserves an existing attachment message link on later upserts", () => {
    const attachment = createAttachment({
      threadId: "thd_123",
      objectKey: "thd_123/cat.png",
      fileName: "cat.png",
      mimeType: "image/png",
      sizeBytes: 128,
    });

    const merged = mergeAttachmentLink(
      { messageId: "msg_123" },
      {
        ...attachment,
        messageId: null,
        status: "ready",
      },
    );

    expect(merged.messageId).toBe("msg_123");
    expect(merged.status).toBe("ready");
  });

  it("builds grounded search context blocks", () => {
    const context = buildMultiSearchContext({
      runs: [
        {
          query: "current date and time right now",
          rows: [
            {
              title: "Example",
              url: "https://example.com",
              snippet: "hello world",
            },
          ],
        },
      ],
    });

    expect(context).toContain("Tool: exa_web_search");
    expect(context).toContain("Search query: current date and time right now");
    expect(context).toContain("<exa_search_results>");
    expect(context).toContain("do not mention the search tool");
    expect(context).toContain("[1] Example");
    expect(context).toContain("https://example.com");
  });

  it("builds grounded context blocks for multiple searches", () => {
    const context = buildMultiSearchContext({
      runs: [
        {
          query: "time in jakarta right now",
          rows: [
            {
              title: "Clock",
              url: "https://example.com/clock",
              snippet: "09:00",
            },
          ],
        },
        {
          query: "jakarta timezone",
          rawText: "Source 1\nhttps://example.com/tz\nUTC+7",
        },
      ],
    });

    expect(context).toContain("One or more web search tools have already been executed");
    expect(context).toContain("Search run 1");
    expect(context).toContain("Search run 2");
    expect(context).toContain("Search query: time in jakarta right now");
    expect(context).toContain("Search query: jakarta timezone");
    expect(context).toContain("https://example.com/tz");
  });

  it("sorts same-timestamp turns deterministically with the user before the assistant", () => {
    const createdAt = "2026-04-09T12:00:00.000Z";
    const sorted = sortConversationMessages([
      {
        id: "msg_assistant",
        role: "assistant",
        createdAt,
      },
      {
        id: "msg_user",
        role: "user",
        createdAt,
      },
    ]);

    expect(sorted.map((message) => message.id)).toEqual(["msg_user", "msg_assistant"]);
  });

  it("resolves the active thread path from the thread head", () => {
    const baseThread = createThread({ workspaceId: "wrk_123" });
    const firstUser = createMessage({
      threadId: baseThread.id,
      role: "user",
      modelId: "openai/gpt-4.1",
      text: "original",
    });
    const firstAssistant = createMessage({
      threadId: baseThread.id,
      parentMessageId: firstUser.id,
      role: "assistant",
      modelId: "openai/gpt-4.1",
      text: "first answer",
    });
    const revisedUser = createMessage({
      threadId: baseThread.id,
      parentMessageId: firstUser.parentMessageId ?? null,
      sourceMessageId: firstUser.id,
      role: "user",
      modelId: "openai/gpt-4.1",
      text: "revised",
    });
    const revisedAssistant = createMessage({
      threadId: baseThread.id,
      parentMessageId: revisedUser.id,
      role: "assistant",
      modelId: "openai/gpt-4.1",
      text: "revised answer",
    });

    const visible = resolveThreadMessagePath(
      [firstUser, firstAssistant, revisedUser, revisedAssistant],
      revisedAssistant.id,
    );

    expect(visible.map((message) => message.id)).toEqual([revisedUser.id, revisedAssistant.id]);
  });

  it("optimistically sends a message without direct collection mutations", () => {
    const workspace = createWorkspace({
      name: "Writing",
      defaultModelId: "openai/gpt-4.1",
    });
    const thread = createThread({ workspaceId: workspace.id });

    applyLocalInsert("workspaces", workspace);
    applyLocalInsert("threads", thread);

    expect(() =>
      sendMessageAction({
        thread,
        text: "hello",
        modelId: workspace.defaultModelId,
        reasoningLevel: "medium",
        search: false,
      }),
    ).not.toThrow();

    const persistedThread = threads.get(thread.id);
    const optimisticMessages = [...messages.state.values()].filter(
      (message) => message.threadId === thread.id,
    );

    expect(workspaces.get(workspace.id)).toBeTruthy();
    expect(persistedThread?.title).toBe("hello");
    expect(persistedThread?.headMessageId).toBeTruthy();
    expect(optimisticMessages).toHaveLength(2);
    expect(optimisticMessages.map((message) => message.role).sort()).toEqual(["assistant", "user"]);
    expect(optimisticMessages.map((message) => message.reasoningLevel)).toEqual([
      "medium",
      "medium",
    ]);
    const userMessage = optimisticMessages.find((message) => message.role === "user");
    const assistantMessage = optimisticMessages.find((message) => message.role === "assistant");
    expect(userMessage?.parentMessageId).toBeNull();
    expect(assistantMessage?.parentMessageId).toBe(userMessage?.id);
    expect(assistantMessage?.id).toBe(persistedThread?.headMessageId);
  });

  it("materializes a draft thread on first send", () => {
    const workspace = createWorkspace({
      name: "Writing",
      defaultModelId: "openai/gpt-4.1",
    });
    const draftThread = createThread({ workspaceId: workspace.id });

    applyLocalInsert("workspaces", workspace);

    expect(threads.get(draftThread.id)).toBeUndefined();

    sendMessageAction({
      thread: draftThread,
      text: "draft hello",
      modelId: workspace.defaultModelId,
      reasoningLevel: "off",
      search: false,
    });

    expect(threads.get(draftThread.id)?.title).toBe("draft hello");
    expect(
      [...messages.state.values()].filter((message) => message.threadId === draftThread.id),
    ).toHaveLength(2);
  });

  it("retries from an existing user turn by only appending a new assistant branch", () => {
    const workspace = createWorkspace({
      name: "Writing",
      defaultModelId: "openai/gpt-4.1",
    });
    const thread = createThread({ workspaceId: workspace.id });
    const userMessage = createMessage({
      threadId: thread.id,
      role: "user",
      modelId: workspace.defaultModelId,
      text: "hello",
    });
    const assistantMessage = createMessage({
      threadId: thread.id,
      parentMessageId: userMessage.id,
      role: "assistant",
      modelId: workspace.defaultModelId,
      text: "world",
    });

    applyLocalInsert("workspaces", workspace);
    applyLocalInsert("threads", { ...thread, headMessageId: assistantMessage.id });
    applyLocalInsert("messages", userMessage);
    applyLocalInsert("messages", assistantMessage);

    retryMessageAction({
      thread: { ...thread, headMessageId: assistantMessage.id },
      userMessage,
      modelId: workspace.defaultModelId,
      reasoningLevel: "off",
      search: false,
    });

    const threadAfterRetry = threads.get(thread.id);
    const threadMessages = [...messages.state.values()].filter(
      (message) => message.threadId === thread.id,
    );
    const assistantMessages = threadMessages.filter((message) => message.role === "assistant");
    const retriedAssistant = assistantMessages.find(
      (message) => message.id !== assistantMessage.id,
    );

    expect(threadMessages).toHaveLength(3);
    expect(retriedAssistant?.parentMessageId).toBe(userMessage.id);
    expect(retriedAssistant?.status).toBe("pending");
    expect(threadAfterRetry?.headMessageId).toBe(retriedAssistant?.id);
  });

  it("edits a user turn by creating a new user branch and cloned attachments", () => {
    const workspace = createWorkspace({
      name: "Writing",
      defaultModelId: "openai/gpt-4.1",
    });
    const thread = createThread({ workspaceId: workspace.id });
    const originalUser = createMessage({
      threadId: thread.id,
      role: "user",
      modelId: workspace.defaultModelId,
      text: "draft",
    });
    const originalAssistant = createMessage({
      threadId: thread.id,
      parentMessageId: originalUser.id,
      role: "assistant",
      modelId: workspace.defaultModelId,
      text: "answer",
    });
    const originalAttachment = createAttachment({
      threadId: thread.id,
      messageId: originalUser.id,
      objectKey: `${thread.id}/note.txt`,
      fileName: "note.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      status: "ready",
    });

    applyLocalInsert("workspaces", workspace);
    applyLocalInsert("threads", { ...thread, headMessageId: originalAssistant.id });
    applyLocalInsert("messages", originalUser);
    applyLocalInsert("messages", originalAssistant);
    applyLocalInsert("attachments", originalAttachment);

    editUserMessageAction({
      thread: { ...thread, headMessageId: originalAssistant.id },
      sourceMessage: originalUser,
      text: "revised draft",
      modelId: workspace.defaultModelId,
      reasoningLevel: "off",
      search: false,
      attachmentIds: [originalAttachment.id],
    });

    const threadAfterEdit = threads.get(thread.id);
    const threadMessages = [...messages.state.values()].filter(
      (message) => message.threadId === thread.id,
    );
    const editedUser = threadMessages.find(
      (message) => message.role === "user" && message.id !== originalUser.id,
    );
    const editedAssistant = threadMessages.find(
      (message) => message.role === "assistant" && message.id !== originalAssistant.id,
    );
    const clonedAttachments = [...attachments.state.values()].filter(
      (attachment) => attachment.threadId === thread.id && attachment.id !== originalAttachment.id,
    );

    expect(editedUser?.sourceMessageId).toBe(originalUser.id);
    expect(editedAssistant?.parentMessageId).toBe(editedUser?.id);
    expect(threadAfterEdit?.headMessageId).toBe(editedAssistant?.id);
    expect(clonedAttachments).toHaveLength(1);
    expect(clonedAttachments[0]?.messageId).toBe(editedUser?.id);
    expect(clonedAttachments[0]?.objectKey).toBe(originalAttachment.objectKey);
  });

  it("applies authoritative upserts over optimistic rows without duplicate-key errors", () => {
    const workspace = createWorkspace({
      name: "Writing",
      defaultModelId: "openai/gpt-4.1",
    });
    const originalThread = createThread({ workspaceId: workspace.id, title: "New Chat" });

    applyLocalInsert("workspaces", workspace);
    applyLocalInsert("threads", originalThread);

    const updatedThread = {
      ...originalThread,
      title: "what time is it?",
    };

    expect(() =>
      processEnvelopes([
        {
          type: "event",
          serverSeq: 1,
          eventId: "evt_workspace",
          eventType: "workspace_upserted",
          payload: { row: workspace },
          causedByOpId: "op_workspace",
        },
        {
          type: "event",
          serverSeq: 2,
          eventId: "evt_thread",
          eventType: "thread_upserted",
          payload: { row: updatedThread },
          causedByOpId: "op_thread",
        },
      ]),
    ).not.toThrow();

    expect(workspaces.get(workspace.id)?.id).toBe(workspace.id);
    expect(threads.get(originalThread.id)?.title).toBe("what time is it?");
  });

  it("reuses the same draft for a workspace", () => {
    const workspace = createWorkspace({
      name: "Writing",
      defaultModelId: "openai/gpt-4.1",
    });

    const first = ensureWorkspaceDraft({
      workspace,
      modelId: workspace.defaultModelId,
      reasoningLevel: "low",
      search: true,
    });
    const second = ensureWorkspaceDraft({
      workspace,
      modelId: "other-model",
      reasoningLevel: "high",
      search: false,
    });

    expect(second.thread.id).toBe(first.thread.id);
    expect(getWorkspaceDraft(workspace.id)?.search).toBe(true);
  });

  it("removes invalid workspace drafts during reconciliation", () => {
    const workspace = createWorkspace({
      name: "Writing",
      defaultModelId: "openai/gpt-4.1",
    });

    ensureWorkspaceDraft({
      workspace,
      modelId: workspace.defaultModelId,
      reasoningLevel: "off",
      search: false,
    });
    activateWorkspaceDraftView(workspace.id);

    reconcileDraftState([], []);

    expect(getWorkspaceDraft(workspace.id)).toBeNull();
    expect(getWorkspaceConversationView(workspace.id)).toBe("thread");
  });

  it("drops a draft when the workspace is archived by sync", () => {
    const workspace = createWorkspace({
      name: "Writing",
      defaultModelId: "openai/gpt-4.1",
    });
    const thread = createThread({ workspaceId: workspace.id });

    applyLocalInsert("workspaces", workspace);
    applyLocalInsert("threads", thread);
    ensureWorkspaceDraft({
      workspace,
      modelId: workspace.defaultModelId,
      reasoningLevel: "off",
      search: false,
    });
    activateWorkspaceDraftView(workspace.id);

    processEnvelopes([
      {
        type: "event",
        serverSeq: 1,
        eventId: "evt_workspace_archived",
        eventType: "workspace_archived",
        payload: {
          id: workspace.id,
          archivedAt: "2026-04-16T00:00:00.000Z",
          updatedAt: "2026-04-16T00:00:00.000Z",
        },
        causedByOpId: "op_workspace_archived",
      },
    ]);

    expect(getWorkspaceDraft(workspace.id)).toBeNull();
  });

  it("removes ready attachments from a draft before first send", () => {
    const workspace = createWorkspace({
      name: "Writing",
      defaultModelId: "openai/gpt-4.1",
    });
    const draft = ensureWorkspaceDraft({
      workspace,
      modelId: workspace.defaultModelId,
      reasoningLevel: "off",
      search: false,
    });

    updateWorkspaceDraft(workspace.id, (current) => ({
      ...current,
      attachments: [
        {
          localId: "local_att",
          attachmentId: "att_ready",
          threadId: draft.thread.id,
          fileName: "cat.png",
          mimeType: "image/png",
          sizeBytes: 10,
          status: "ready",
        },
      ],
    }));

    const removed = removeWorkspaceDraftAttachment(workspace.id, "local_att");

    expect(removed?.attachmentId).toBe("att_ready");
    expect(getWorkspaceDraft(workspace.id)?.attachments).toHaveLength(0);
    expect(consumePendingDraftAttachmentCleanup()).toHaveLength(0);
  });
});

describe("server helpers", () => {
  const env = {
    ALLOWED_EMAIL: "owner@example.com",
    BETTER_AUTH_SECRET: "test-secret",
    BETTER_AUTH_URL: "https://chat.example.com",
    BETTER_AUTH_API_KEY: "better-auth-key",
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "google-secret",
    OPENCODE_GO_BASE_URL: "https://api.example.com",
    OPENCODE_GO_API_KEY: "opencode-key",
    OPENCODE_GO_MODEL_ALLOWLIST: "openai/gpt-4.1,anthropic/claude-sonnet-4",
    DEFAULT_MODEL_ID: "openai/gpt-4.1",
    EXA_API_KEY: "exa-key",
    AUTH_DB: {} as D1Database,
    UPLOADS: {} as R2Bucket,
    SYNC_ENGINE: {} as DurableObjectNamespace,
  };

  it("normalizes and checks the allowed email", () => {
    expect(normalizeEmail(" Owner@Example.com ")).toBe("owner@example.com");
    expect(allowedEmail(env)).toBe("owner@example.com");
  });

  it("filters models.dev data to the allowlist", () => {
    const result = filterModelsCatalog(
      {
        "opencode-go": {
          id: "opencode-go",
          api: "https://api.example.com",
          models: {
            a: {
              id: "openai/gpt-4.1",
              name: "GPT 4.1",
              tool_call: true,
              interleaved: { field: "reasoning_content" },
            },
            b: { id: "openai/o3-mini", name: "o3-mini" },
          },
        },
      },
      env,
    );

    expect(result.models).toHaveLength(1);
    expect(result.models[0]?.id).toBe("openai/gpt-4.1");
    expect(result.models[0]?.reasoning).toBe(true);
    expect(result.models[0]?.toolCall).toBe(true);
    expect(result.models[0]?.interleaved?.field).toBe("reasoning_content");
    expect(result.models[0]?.family).toBe("unknown");
  });

  it("returns all opencode-go models when allowlist is omitted", () => {
    const { OPENCODE_GO_MODEL_ALLOWLIST: _, ...envNoAllowlist } = env;
    const result = filterModelsCatalog(
      {
        "opencode-go": {
          id: "opencode-go",
          api: "https://api.example.com",
          models: {
            a: { id: "openai/gpt-4.1", name: "GPT 4.1" },
            b: { id: "openai/o3-mini", name: "o3-mini" },
          },
        },
      },
      envNoAllowlist as any,
    );

    expect(result.models).toHaveLength(2);
  });

  it("classifies supported attachment types", () => {
    expect(isImageAttachment("image/png")).toBe(true);
    expect(isInlineTextAttachment("text/plain", 100)).toBe(true);
    expect(isInlineTextAttachment("application/pdf", 100)).toBe(false);
    expect(isInlineTextAttachment("text/plain", 200_000)).toBe(false);
  });

  it("preserves workspace defaults", () => {
    const workspace = createWorkspace({
      name: "Writing",
      defaultModelId: "openai/gpt-4.1",
      defaultReasoningLevel: "high",
      defaultSearchMode: true,
    });

    expect(workspace.defaultSearchMode).toBe(true);
    expect(workspace.defaultModelId).toBe("openai/gpt-4.1");
    expect(workspace.defaultReasoningLevel).toBe("high");
  });

  it("explains Kimi reasoning/tool incompatibility errors for the UI", () => {
    const explained = explainAssistantError({
      errorCode: "stream_error",
      errorMessage:
        'HTTP 400: {"error":{"message":"thinking is enabled but reasoning_content is missing"}}',
    });

    expect(explained.summary).toContain("thinking mode is incompatible");
    expect(explained.explanation).toContain("does attempt to preserve that field now");
  });

  it("normalizes provider reasoning incompatibility on the server", () => {
    const normalized = normalizeAssistantError({
      errorCode: "stream_error",
      errorMessage:
        'HTTP 400: {"error":{"message":"reasoning_content is missing for continuation"}}',
      modelId: "moonshot/kimi-k2.5",
    });

    expect(normalized.errorCode).toBe("provider_reasoning_incompatible");
    expect(normalized.retryable).toBe(false);
    expect(normalized.providerName).toBe("moonshot");
  });

  it("extracts fallback Exa MCP search text", () => {
    const text = parseExaMcpTextResponse(
      [
        "event: message",
        'data: {"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"Source 1\\nhttps://example.com\\nSnippet"}]}}',
        "",
      ].join("\n"),
    );

    expect(text).toContain("https://example.com");
    expect(text).toContain("Snippet");
  });

  it("extracts text from chat completion content arrays", () => {
    const text = extractChatCompletionText([
      { type: "text", text: "what time is it right now" },
      { type: "ignored", text: "nope" },
    ]);

    expect(text).toBe("what time is it right now");
  });

  it("extracts reasoning token counts from nested usage payloads", () => {
    expect(
      extractReasoningTokens({
        completion_tokens_details: {
          reasoning_tokens: 128,
        },
      }),
    ).toBe(128);

    expect(
      extractReasoningTokens({
        outputTokensDetails: {
          reasoningTokens: "64",
        },
      }),
    ).toBe(64);

    expect(extractReasoningTokens({ completion_tokens: 42 })).toBe(null);
  });

  it("completes provider tool calls and omits null assistant content on continuation", async () => {
    const requests: Array<Record<string, any>> = [];
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    const encoder = new TextEncoder();

    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const rawBody = typeof init?.body === "string" ? init.body : "";
      requests.push(JSON.parse(rawBody));
      callCount += 1;

      const sse =
        callCount === 1
          ? [
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"exa_web_search","arguments":"{\\"query\\":\\"current f1 standings\\"}"}}]}}]}\n\n',
              'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":5}}\n\n',
              "data: [DONE]\n\n",
            ]
          : [
              'data: {"choices":[{"delta":{"content":"Oscar Piastri leads."}}]}\n\n',
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":7}}\n\n',
              "data: [DONE]\n\n",
            ];

      const body = new ReadableStream({
        start(controller) {
          for (const chunk of sse) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });

      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const adapter = createChatCompletionsAdapter(
        {
          baseUrl: "https://api.example.com",
          apiKey: "test-key",
        },
        "openai/gpt-4.1",
      );

      const searchTool = toolDefinition({
        name: "exa_web_search",
        description: "Search the web",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      }).server(async () => "Search grounding");

      const chunks = [];
      for await (const chunk of chat({
        adapter,
        messages: [{ role: "user", content: "who leads the 2026 f1 wdc?" }],
        tools: [searchTool],
      })) {
        chunks.push(chunk);
      }

      expect(requests).toHaveLength(2);
      expect(chunks.some((chunk: any) => chunk.type === "TOOL_CALL_END")).toBe(true);

      const continuationMessages = requests[1]?.messages ?? [];
      const assistantToolCall = continuationMessages.find(
        (message: any) => message.role === "assistant" && Array.isArray(message.tool_calls),
      );
      expect(assistantToolCall).toBeTruthy();
      expect("content" in assistantToolCall).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("replays interleaved reasoning content on tool call continuation", async () => {
    const requests: Array<Record<string, any>> = [];
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    const encoder = new TextEncoder();

    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const rawBody = typeof init?.body === "string" ? init.body : "";
      requests.push(JSON.parse(rawBody));
      callCount += 1;

      const sse =
        callCount === 1
          ? [
              'data: {"choices":[{"delta":{"reasoningContent":"Need current standings. "}}]}\n\n',
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"exa_web_search","arguments":"{\\"query\\":\\"current f1 standings\\"}"}}]}}]}\n\n',
              'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":5,"completion_tokens_details":{"reasoning_tokens":63}}}\n\n',
              "data: [DONE]\n\n",
            ]
          : [
              'data: {"choices":[{"delta":{"content":"Oscar Piastri leads."}}]}\n\n',
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":7}}\n\n',
              "data: [DONE]\n\n",
            ];

      const body = new ReadableStream({
        start(controller) {
          for (const chunk of sse) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });

      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const adapter = createChatCompletionsAdapter(
        {
          baseUrl: "https://api.example.com",
          apiKey: "test-key",
        },
        "moonshot/kimi-k2.5",
      );

      const searchTool = toolDefinition({
        name: "exa_web_search",
        description: "Search the web",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      }).server(async () => "Search grounding");

      for await (const _chunk of chat({
        adapter,
        messages: [{ role: "user", content: "who leads the 2026 f1 wdc?" }],
        modelOptions: {
          thinking: { type: "enabled" },
        },
        tools: [searchTool],
      })) {
      }

      expect(requests).toHaveLength(2);
      const continuationMessages = requests[1]?.messages ?? [];
      const assistantToolCall = continuationMessages.find(
        (message: any) => message.role === "assistant" && Array.isArray(message.tool_calls),
      );

      expect(assistantToolCall?.reasoning_content).toBe("Need current standings. ");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("disables interleaved reasoning for tool-enabled turns on reasoning_content models", () => {
    expect(
      getProviderModelOptions("moonshot/kimi-k2.5", 1, "high", "reasoning_content"),
    ).toMatchObject({
      effectiveReasoningLevel: "off",
      overrideReason: "tool_turn_disables_interleaved_reasoning",
      modelOptions: {
        thinking: {
          type: "disabled",
        },
      },
    });

    expect(
      getProviderModelOptions("moonshot/kimi-k2.5", 0, "high", "reasoning_content"),
    ).toMatchObject({
      effectiveReasoningLevel: "high",
      overrideReason: null,
      modelOptions: {
        thinking: {
          type: "enabled",
        },
      },
    });
  });

  it("clamps exa result counts", () => {
    expect(clampExaResults(1)).toBe(3);
    expect(clampExaResults(5)).toBe(5);
    expect(clampExaResults(99)).toBe(8);
  });

  it("signs attachment URLs for authenticated model fetches", async () => {
    const signedUrl = await getSignedAttachmentUrl(env as any, "thd_123/cat.png");
    const url = new URL(signedUrl);
    const token = url.searchParams.get("token");

    expect(url.origin).toBe("https://chat.example.com");
    expect(url.pathname).toBe("/api/uploads/blob/thd_123%2Fcat.png");
    expect(token).toBeTruthy();

    const payload = await verifyUploadToken(env as any, token!);

    expect(payload?.action).toBe("read_attachment");
    expect(payload?.objectKey).toBe("thd_123/cat.png");
    expect(Number(payload?.expiresAt)).toBeGreaterThan(Date.now());
  });
});
