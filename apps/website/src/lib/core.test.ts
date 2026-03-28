import { buildSearchContext, createAttachment, createWorkspace, slugify } from "@g3-chat/domain";
import {
  allowedEmail,
  filterModelsCatalog,
  isImageAttachment,
  isInlineTextAttachment,
  normalizeEmail,
  parseExaMcpTextResponse,
} from "@g3-chat/server";
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
    const context = buildSearchContext([
      {
        title: "Example",
        url: "https://example.com",
        snippet: "hello world",
      },
    ]);

    expect(context).toContain("[1] Example");
    expect(context).toContain("https://example.com");
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
});
