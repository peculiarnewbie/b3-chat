import {
  buildSearchPlanningContext,
  buildSearchContext,
  createAttachment,
  createWorkspace,
  slugify,
} from "@b3-chat/domain";
import {
  allowedEmail,
  clampExaResults,
  extractChatCompletionText,
  filterModelsCatalog,
  getSignedAttachmentUrl,
  isImageAttachment,
  isInlineTextAttachment,
  normalizeEmail,
  parseExaMcpTextResponse,
  parseSearchPlan,
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

  it("builds bounded planning context from recent conversation", () => {
    const query = buildSearchPlanningContext({
      promptText: "what about now?",
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

    expect(query).toContain("Latest user request:\nwhat about now?");
    expect(query).toContain("Recent conversation:");
    expect(query).toContain("user: what day is it?");
    expect(query).toContain("assistant: I don't have access to the current date.");
    expect(query).toContain("Task:");
    expect(query).toContain("Decide whether web search is needed.");
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

  it("parses a planner response into a normalized search plan", () => {
    const plan = parseSearchPlan(
      '{"needsSearch": true, "summary": "User wants the current date and time.", "query": "current date and time right now", "numResults": 9}',
    );

    expect(plan.needsSearch).toBe(true);
    expect(plan.summary).toBe("User wants the current date and time.");
    expect(plan.query).toBe("current date and time right now");
    expect(plan.numResults).toBe(8);
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

  it("fails closed when a search plan is missing the summary", () => {
    const plan = parseSearchPlan(
      '{"needsSearch": true, "summary": "", "query": "current time right now", "numResults": 3}',
    );

    expect(plan).toEqual({
      needsSearch: false,
      summary: "",
      query: "",
      numResults: 0,
    });
  });

  it("fails closed when a search plan is missing numResults", () => {
    const plan = parseSearchPlan(
      '{"needsSearch": true, "summary": "User wants the current time.", "query": "current time right now"}',
    );

    expect(plan).toEqual({
      needsSearch: false,
      summary: "",
      query: "",
      numResults: 0,
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
