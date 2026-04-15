import {
  buildMultiSearchContext,
  buildSearchPlanningContext,
  createAttachment,
  createWorkspace,
  mergeAttachmentLink,
  sortConversationMessages,
  slugify,
} from "@b3-chat/domain";
import {
  allowedEmail,
  clampExaResults,
  extractReasoningTokens,
  extractChatCompletionText,
  filterModelsCatalog,
  getSignedAttachmentUrl,
  inferForcedSearchQuery,
  isImageAttachment,
  isInlineTextAttachment,
  normalizeEmail,
  parseExaMcpTextResponse,
  parseSearchQueryDecision,
  verifyUploadToken,
} from "@b3-chat/server";
import { describe, expect, it } from "vite-plus/test";

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

  it("builds bounded planning context from recent conversation", () => {
    const query = buildSearchPlanningContext({
      promptText: "what about now?",
      systemPrompt: "Answer crisply.",
      messages: [
        {
          role: "user",
          text: "message 0 should be dropped once the recent window is applied",
          status: "completed",
        },
        {
          role: "assistant",
          text: "message 1 should be dropped once the recent window is applied",
          status: "completed",
        },
        {
          role: "user",
          text: "message 2 should be dropped once the recent window is applied",
          status: "completed",
        },
        {
          role: "assistant",
          text: "message 3 should be dropped once the recent window is applied",
          status: "completed",
        },
        {
          role: "user",
          text: "message 4 should stay inside the recent window",
          status: "completed",
        },
        {
          role: "assistant",
          text: "message 5 should stay inside the recent window",
          status: "completed",
        },
        {
          role: "user",
          text: "when is your training data cutoff?",
          status: "completed",
        },
        {
          role: "assistant",
          text: "My training data runs through June 2025.",
          status: "completed",
        },
        {
          role: "user",
          text: "what day is it?",
          status: "completed",
        },
        {
          role: "assistant",
          text: `I don't have access to the current date. ${"x".repeat(600)}`,
          status: "completed",
        },
        {
          role: "user",
          text: "what about now?",
          status: "completed",
        },
      ],
    });

    expect(query).toContain("Today's date is ");
    expect(query).toContain("Workspace system prompt:");
    expect(query).toContain("Answer crisply.");
    expect(query).toContain("Latest user message:\nwhat about now?");
    expect(query).toContain("Recent raw conversation:");
    expect(query).toContain("user: what day is it?");
    expect(query).toContain("assistant: I don't have access to the current date.");
    expect(query).toContain("user: what about now?");
    expect(query).toContain("message 0 should be dropped");
    expect(query).toContain("message 1 should be dropped");
    expect(query).not.toContain("x".repeat(501));
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
            a: { id: "openai/gpt-4.1", name: "GPT 4.1" },
            b: { id: "openai/o3-mini", name: "o3-mini" },
          },
        },
      },
      env,
    );

    expect(result.models).toHaveLength(1);
    expect(result.models[0]?.id).toBe("openai/gpt-4.1");
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
      defaultSearchMode: true,
    });

    expect(workspace.defaultSearchMode).toBe(true);
    expect(workspace.defaultModelId).toBe("openai/gpt-4.1");
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

  it("parses a planner response into a normalized search decision", () => {
    const decision = parseSearchQueryDecision(
      '{"shouldSearch": true, "query": "current date and time right now"}',
    );

    expect(decision).toEqual({
      shouldSearch: true,
      query: "current date and time right now",
    });
  });

  it("parses a no-search planner response", () => {
    const decision = parseSearchQueryDecision('{"shouldSearch": false, "query": ""}');
    expect(decision).toEqual({
      shouldSearch: false,
      query: "",
    });
  });

  it("infers forced search queries for explicit lookup and realtime prompts", () => {
    expect(inferForcedSearchQuery("can you look up who won f1 suzuka race in 2026?")).toBe(
      "who won f1 suzuka race in 2026",
    );
    expect(inferForcedSearchQuery("what time is it?")).toBe("current local time now");
    expect(inferForcedSearchQuery("rewrite this paragraph")).toBe(null);
    expect(inferForcedSearchQuery("can you do search?")).toBe(null);
    expect(inferForcedSearchQuery("what about now?")).toBe(null);
    expect(inferForcedSearchQuery("now you can search for it")).toBe(null);
  });

  it("fails closed on malformed planner output", () => {
    const decision = parseSearchQueryDecision("shouldSearch: true\nquery: current time right now");

    expect(decision).toEqual({
      shouldSearch: false,
      query: "",
    });
  });

  it("clamps exa result counts", () => {
    expect(clampExaResults(1)).toBe(3);
    expect(clampExaResults(5)).toBe(5);
    expect(clampExaResults(99)).toBe(8);
  });

  it("fails closed when a search decision is missing the rewritten query", () => {
    const decision = parseSearchQueryDecision('{"shouldSearch": true, "query": ""}');

    expect(decision).toEqual({
      shouldSearch: false,
      query: "",
    });
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
