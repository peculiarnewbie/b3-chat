import {
  buildMultiSearchContext,
  buildSearchPlanningContext,
  buildSearchContext,
  createSearchRun,
  createAttachment,
  createWorkspace,
  mergeAttachmentLink,
  slugify,
} from "@b3-chat/domain";
import {
  allowedEmail,
  clampExaResults,
  extractReasoningTokens,
  extractChatCompletionText,
  filterModelsCatalog,
  getSignedAttachmentUrl,
  getSearchPlannerModelId,
  inferForcedSearchQuery,
  isImageAttachment,
  isInlineTextAttachment,
  normalizeEmail,
  parseExaMcpTextResponse,
  parseSearchPlan,
  parseSearchStepDecision,
  verifyUploadToken,
} from "@b3-chat/server";
import { inferContextualFollowUpSearchQuery } from "../server/search";
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
    const context = buildSearchContext({
      query: "current date and time right now",
      rows: [
        {
          title: "Example",
          url: "https://example.com",
          snippet: "hello world",
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
      priorSearches: [
        createSearchRun({
          messageId: "msg_1",
          query: "current date and time",
          status: "completed",
          step: 1,
          numResults: 5,
          resultCount: 3,
          previewText: "Clock result",
        }),
      ],
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
    expect(query).toContain("Latest user request:\nwhat about now?");
    expect(query).toContain("Recent conversation:");
    expect(query).toContain("Searches already attempted this turn:");
    expect(query).toContain("current date and time");
    expect(query).toContain("user: what day is it?");
    expect(query).toContain("assistant: I don't have access to the current date.");
    expect(query).toContain("Task:");
    expect(query).toContain("Decide whether to answer now or perform another web search.");
    expect(query).not.toContain("user: what about now?");
    expect(query).not.toContain("message 0 should be dropped");
    expect(query).not.toContain("message 1 should be dropped");
    expect(query).not.toContain("x".repeat(501));
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

  it("uses the dedicated search planner model", () => {
    expect(getSearchPlannerModelId()).toBe("minimax-m2.5");
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

  it("parses a planner response into a normalized search plan", () => {
    const plan = parseSearchPlan(
      '{"needsSearch": true, "summary": "User wants the current date and time.", "query": "current date and time right now", "numResults": 9}',
    );

    expect(plan.needsSearch).toBe(true);
    expect(plan.summary).toBe("User wants the current date and time.");
    expect(plan.query).toBe("current date and time right now");
    expect(plan.numResults).toBe(8);
  });

  it("parses a search-step response into a normalized decision", () => {
    const decision = parseSearchStepDecision(
      '{"action":"search","summary":"User needs the current time.","query":"current time in jakarta","numResults":9}',
    );

    expect(decision).toEqual({
      action: "search",
      summary: "User needs the current time.",
      query: "current time in jakarta",
      numResults: 8,
    });
  });

  it("parses an answer-now search-step response", () => {
    const decision = parseSearchStepDecision(
      '{"action":"answer","summary":"","query":"","numResults":0}',
    );

    expect(decision).toEqual({
      action: "answer",
      summary: "",
      query: "",
      numResults: 0,
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
  });

  it("rewrites ambiguous realtime follow-ups from recent user context", () => {
    const query = inferContextualFollowUpSearchQuery("what about now?", [
      {
        role: "user",
        text: "what model are you?",
        status: "completed",
      },
      {
        role: "assistant",
        text: "I'm an AI assistant.",
        status: "completed",
      },
      {
        role: "user",
        text: "what time is it?",
        status: "completed",
      },
      {
        role: "assistant",
        text: "I don't have access to the current time.",
        status: "completed",
      },
      {
        role: "user",
        text: "what about now?",
        status: "completed",
      },
    ]);

    expect(query).toBe("current local time now");
  });

  it("does not invent context for ambiguous follow-ups without a prior realtime ask", () => {
    const query = inferContextualFollowUpSearchQuery("what about now?", [
      {
        role: "user",
        text: "what model are you?",
        status: "completed",
      },
      {
        role: "assistant",
        text: "I'm an AI assistant.",
        status: "completed",
      },
      {
        role: "user",
        text: "what about now?",
        status: "completed",
      },
    ]);

    expect(query).toBe(null);
  });

  it("parses a no-search planner response", () => {
    const plan = parseSearchPlan(
      '{"needsSearch": false, "summary": "", "query": "", "numResults": 0}',
    );

    expect(plan).toEqual({
      needsSearch: false,
      summary: "",
      query: "",
      numResults: 0,
    });
  });

  it("fails closed on malformed planner output", () => {
    const plan = parseSearchPlan("needsSearch: true\nquery: current time right now\nnumResults: 3");

    expect(plan).toEqual({
      needsSearch: false,
      summary: "",
      query: "",
      numResults: 0,
    });
  });

  it("clamps exa result counts", () => {
    expect(clampExaResults(1)).toBe(3);
    expect(clampExaResults(5)).toBe(5);
    expect(clampExaResults(99)).toBe(8);
  });

  it("fails closed when a search plan is missing the rewritten query", () => {
    const plan = parseSearchPlan(
      '{"needsSearch": true, "summary": "User wants the current time.", "query": "", "numResults": 3}',
    );

    expect(plan).toEqual({
      needsSearch: false,
      summary: "",
      query: "",
      numResults: 0,
    });
  });

  it("falls back summary to query when summary is empty", () => {
    const plan = parseSearchPlan(
      '{"needsSearch": true, "summary": "", "query": "current time right now", "numResults": 3}',
    );

    expect(plan).toEqual({
      needsSearch: true,
      summary: "current time right now",
      query: "current time right now",
      numResults: 3,
    });
  });

  it("defaults numResults when missing from search plan", () => {
    const plan = parseSearchPlan(
      '{"needsSearch": true, "summary": "User wants the current time.", "query": "current time right now"}',
    );

    expect(plan).toEqual({
      needsSearch: true,
      summary: "User wants the current time.",
      query: "current time right now",
      numResults: 5,
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
