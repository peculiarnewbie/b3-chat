export {
  ChatCompletionsAdapter,
  createChatCompletionsAdapter,
  REASONING_CONTENT_EVENT,
  type ChatCompletionsAdapterConfig,
  type ChatCompletionsUsage,
  type ModelMessage,
  type ContentPart,
  type StreamChunk,
  type ExtendedStreamChunk,
} from "./chat-completions-adapter.js";
export { chat } from "@tanstack/ai";
import { decodeAppEnv, type AppEnv } from "@b3-chat/effect";
import { betterAuth } from "better-auth";
import { dash } from "@better-auth/infra";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  createId,
  type SyncCommandPayloadMap,
  type SyncCommandType,
  type SyncSnapshot,
} from "@b3-chat/domain";

export type { AppEnv } from "@b3-chat/effect";

declare global {
  // Worker entry sets bindings here per request for getRuntimeEnv().
  // eslint-disable-next-line no-var
  var __env__: AppEnv | undefined;
}

const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified").notNull().default(0),
  image: text("image"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: integer("accessTokenExpiresAt", { mode: "timestamp" }),
  refreshTokenExpiresAt: integer("refreshTokenExpiresAt", { mode: "timestamp" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }),
  updatedAt: integer("updatedAt", { mode: "timestamp" }),
});

const authSchema = { user, session, account, verification };
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EXA_RESULTS = 5;
const MIN_EXA_RESULTS = 3;
const MAX_EXA_RESULTS = 8;
/** Max time for a single Exa API HTTP call. Search hangs are the #1 source of
 *  stuck tool loops — a tight timeout here keeps the agent loop moving. */
const EXA_REQUEST_TIMEOUT_MS = 15_000;
/** Max time for the Exa MCP fallback. Slightly larger because MCP does more work
 *  (autoprompt + livecrawl fallback). */
const EXA_MCP_REQUEST_TIMEOUT_MS = 20_000;
/** One quick retry for transient network errors / 5xx. Never retry on 4xx. */
const EXA_MAX_ATTEMPTS = 2;
const EXA_RETRY_BACKOFF_MS = 500;
const encoder = new TextEncoder();

type ExaSearchResult = {
  title?: string;
  url: string;
  highlights?: string[];
  text?: string;
  summary?: string | null;
  publishedDate?: string | null;
  highlightScores?: number[];
  score?: number | null;
};

type ExaSearchResponse = {
  results?: ExaSearchResult[];
  autopromptString?: string | null;
};

type InternalCommandResponse = {
  ok: boolean;
  snapshot?: SyncSnapshot;
  reason?: string;
  code?: string;
};

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function allowedEmail(env: AppEnv) {
  return normalizeEmail(env.ALLOWED_EMAIL);
}

export function getDefaultModelId(env: Pick<AppEnv, "DEFAULT_MODEL_ID">) {
  return env.DEFAULT_MODEL_ID?.trim() || "auto";
}

export function getRuntimeEnv() {
  const env = globalThis.__env__;
  if (!env) throw new Error("Cloudflare env bindings are not available");
  return env;
}

export function setRuntimeEnv(input: unknown) {
  const env = decodeAppEnv(input);
  globalThis.__env__ = env;
  return env;
}

export async function ensureAuthSchema(env: AppEnv) {
  const db = drizzle(env.AUTH_DB);
  const statements = [
    sql`create table if not exists user (id text primary key, name text not null, email text not null unique, emailVerified integer not null default 0, image text, createdAt integer not null, updatedAt integer not null)`,
    sql`create table if not exists session (id text primary key, expiresAt integer not null, token text not null unique, createdAt integer not null, updatedAt integer not null, ipAddress text, userAgent text, userId text not null references user(id) on delete cascade)`,
    sql`create table if not exists account (id text primary key, accountId text not null, providerId text not null, userId text not null references user(id) on delete cascade, accessToken text, refreshToken text, idToken text, accessTokenExpiresAt integer, refreshTokenExpiresAt integer, scope text, password text, createdAt integer not null, updatedAt integer not null)`,
    sql`create unique index if not exists account_provider_account_idx on account(providerId, accountId)`,
    sql`create table if not exists verification (id text primary key, identifier text not null, value text not null, expiresAt integer not null, createdAt integer, updatedAt integer)`,
    sql`create index if not exists verification_identifier_idx on verification(identifier)`,
  ];
  for (const statement of statements) await db.run(statement);
}

export function createAuth(env: AppEnv) {
  const db = drizzle(env.AUTH_DB);
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: authSchema,
    }),
    emailAndPassword: {
      enabled: false,
    },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        prompt: "select_account",
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user: Record<string, unknown>) => {
            const email = normalizeEmail(typeof user.email === "string" ? user.email : "");
            if (email !== allowedEmail(env)) {
              throw new Error("UNAUTHORIZED_EMAIL");
            }
            return {
              data: {
                ...user,
                email,
              },
            };
          },
        },
      },
    } as any,
    plugins: [
      dash({
        apiKey: env.BETTER_AUTH_API_KEY,
      }),
    ],
    advanced: {
      database: {
        generateId: () => createId("usr"),
      },
      cookiePrefix: "b3",
    },
  });
}

export async function getSession(request: Request, env: AppEnv) {
  await ensureAuthSchema(env);
  const auth = createAuth(env);
  const session = await auth.api.getSession({
    headers: request.headers,
  });
  if (!session?.user?.email) return null;
  if (normalizeEmail(session.user.email) !== allowedEmail(env)) return null;
  return session;
}

export async function requireSession(request: Request, env: AppEnv) {
  const session = await getSession(request, env);
  if (!session) throw new Response("Unauthorized", { status: 401 });
  return session;
}

export async function getSyncStub(env: AppEnv) {
  return env.SYNC_ENGINE.get(env.SYNC_ENGINE.idFromName(allowedEmail(env)));
}

export async function sendInternalSyncCommand<T extends SyncCommandType>(
  env: AppEnv,
  commandType: T,
  payload: SyncCommandPayloadMap[T],
  opId = createId("srvop"),
) {
  const stub = await getSyncStub(env);
  const response = await stub.fetch("https://sync.internal/internal/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      opId,
      commandType,
      payload,
    }),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as InternalCommandResponse;
}

export async function fetchModelsCatalog(env: AppEnv, cache: Cache) {
  const url = "https://models.dev/api.json";
  const cacheKey = new Request(url);
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Failed to fetch models catalog: ${response.status}`);
  const json = await response.json();
  await cache.put(
    cacheKey,
    new Response(JSON.stringify(json), {
      headers: {
        "content-type": "application/json",
        "cache-control": `public, max-age=${DAY_MS / 1000}`,
      },
    }),
  );
  return json;
}

export function filterModelsCatalog(raw: any, env: AppEnv) {
  const provider = raw["opencode-go"] ?? {};
  const allowed = new Set(
    (env.OPENCODE_GO_MODEL_ALLOWLIST ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const models = Object.values<any>(provider.models ?? {})
    .filter((model) => allowed.size === 0 || allowed.has(model.id))
    .map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      attachment: !!model.attachment || model.modalities?.input?.includes("image"),
      reasoning:
        !!model.reasoning ||
        (model.interleaved &&
          typeof model.interleaved === "object" &&
          model.interleaved.field === "reasoning_content"),
      toolCall: !!model.tool_call,
      interleaved:
        model.interleaved && typeof model.interleaved === "object"
          ? {
              field: typeof model.interleaved.field === "string" ? model.interleaved.field : null,
            }
          : null,
      context: model.limit?.context ?? null,
      output: model.limit?.output ?? null,
      family: model.family ?? "unknown",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    provider: provider.id ?? "opencode-go",
    api: provider.api ?? env.OPENCODE_GO_BASE_URL,
    models,
  };
}

export function clampExaResults(value: number | null | undefined) {
  if (!Number.isFinite(value)) return DEFAULT_EXA_RESULTS;
  return Math.min(MAX_EXA_RESULTS, Math.max(MIN_EXA_RESULTS, Math.round(Number(value))));
}

/**
 * Custom error that signals we timed out waiting on Exa.
 * The tool handler uses this to return a user-friendly failure to the model
 * instead of a generic "AbortError" that is confusing for both the model
 * and for downstream error normalization.
 */
export class ExaSearchError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  readonly reason: "timeout" | "network" | "http" | "empty" | "auth" | "rate_limited";
  constructor(
    message: string,
    init: {
      status?: number | null;
      retryable: boolean;
      reason: "timeout" | "network" | "http" | "empty" | "auth" | "rate_limited";
    },
  ) {
    super(message);
    this.name = "ExaSearchError";
    this.status = init.status ?? null;
    this.retryable = init.retryable;
    this.reason = init.reason;
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function toExaError(error: unknown, fallbackReason: "timeout" | "network"): ExaSearchError {
  if (error instanceof ExaSearchError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (
    lower.includes("abort") ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("deadline")
  ) {
    return new ExaSearchError("Exa search timed out", {
      status: null,
      retryable: true,
      reason: "timeout",
    });
  }
  return new ExaSearchError(`Exa network error: ${message.slice(0, 200)}`, {
    status: null,
    retryable: true,
    reason: fallbackReason,
  });
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function runExaSearchRequest(
  apiKey: string,
  query: string,
  numResults: number,
): Promise<ExaSearchResponse> {
  let lastError: ExaSearchError | null = null;
  for (let attempt = 1; attempt <= EXA_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetchWithTimeout(
        "https://api.exa.ai/search",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
          },
          body: JSON.stringify({
            query,
            numResults,
            // Let Exa rewrite the raw LLM query into something tuned for its
            // neural index. Without this, Exa receives whatever verbose
            // natural-language phrasing the model came up with and quality
            // drops significantly.
            useAutoprompt: true,
            // "auto" picks between neural and keyword per-query.
            type: "auto",
            contents: {
              // Highlights give us ranked snippets; text is a safety net.
              highlights: {
                numSentences: 3,
                highlightsPerUrl: 1,
                query,
              },
              // A short LLM-generated summary when available produces
              // much better grounding than raw text dumps.
              summary: { query },
              // Hard cap on the text fallback to keep the context small.
              text: { maxCharacters: 1200 },
              livecrawl: "fallback",
            },
          }),
        },
        EXA_REQUEST_TIMEOUT_MS,
      );
      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        const status = response.status;
        const retryable = status >= 500 || status === 429;
        const reason: ExaSearchError["reason"] =
          status === 401 || status === 403 ? "auth" : status === 429 ? "rate_limited" : "http";
        const err = new ExaSearchError(
          `Exa search failed: HTTP ${status}${bodyText ? ` — ${bodyText.slice(0, 160)}` : ""}`,
          { status, retryable, reason },
        );
        if (!retryable || attempt === EXA_MAX_ATTEMPTS) throw err;
        lastError = err;
        await sleep(EXA_RETRY_BACKOFF_MS * attempt);
        continue;
      }
      const json = (await response.json()) as ExaSearchResponse;
      return json;
    } catch (error) {
      const err = toExaError(error, "network");
      if (!err.retryable || attempt === EXA_MAX_ATTEMPTS) throw err;
      lastError = err;
      await sleep(EXA_RETRY_BACKOFF_MS * attempt);
    }
  }
  throw (
    lastError ??
    new ExaSearchError("Exa search failed after retries", {
      retryable: true,
      reason: "network",
    })
  );
}

function extractExaSnippet(result: ExaSearchResult): string {
  const highlight = result.highlights?.[0]?.trim();
  if (highlight) return highlight;
  const summary = result.summary?.trim();
  if (summary) return summary.slice(0, 700);
  const text = result.text?.trim();
  if (text) return text.slice(0, 500);
  return "";
}

function safeDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export async function exaSearch(env: AppEnv, query: string, numResults = DEFAULT_EXA_RESULTS) {
  const apiKey = env.EXA_API_KEY?.trim();
  if (!apiKey) {
    throw new ExaSearchError("Exa API key missing", {
      status: null,
      retryable: false,
      reason: "auth",
    });
  }
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    throw new ExaSearchError("Exa search query is empty", {
      status: null,
      retryable: false,
      reason: "empty",
    });
  }
  const clampedResults = clampExaResults(numResults);
  const json = await runExaSearchRequest(apiKey, trimmedQuery, clampedResults);
  const results = (json.results ?? [])
    .filter((result) => typeof result?.url === "string" && result.url)
    .map((result) => ({
      id: createId("src"),
      title: result.title ?? result.url,
      url: result.url,
      snippet: extractExaSnippet(result),
      publishedAt: result.publishedDate ?? null,
      domain: safeDomain(result.url),
      score: Number(result.score ?? result.highlightScores?.[0] ?? 0),
    }));
  return results;
}

export function extractChatCompletionText(
  content: string | Array<{ type?: string; text?: string }> | undefined,
) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text!.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function coerceTokenCount(value: unknown) {
  const tokens =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(tokens)) return null;
  return Math.max(0, Math.round(tokens));
}

export function extractReasoningTokens(usage: unknown) {
  if (!usage || typeof usage !== "object") return null;

  const queue: Record<string, unknown>[] = [usage as Record<string, unknown>];
  const seen = new Set<Record<string, unknown>>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);

    const direct = coerceTokenCount(current.reasoning_tokens ?? current.reasoningTokens);
    if (direct != null) return direct;

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

export function parseExaMcpTextResponse(responseText: string) {
  for (const line of responseText.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = JSON.parse(line.slice(6));
    const text = payload?.result?.content?.find?.((item: any) => item?.type === "text")?.text;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  return "";
}

export async function exaMcpSearchRawText(query: string, numResults = DEFAULT_EXA_RESULTS) {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    throw new ExaSearchError("Exa MCP query is empty", {
      status: null,
      retryable: false,
      reason: "empty",
    });
  }
  let lastError: ExaSearchError | null = null;
  for (let attempt = 1; attempt <= EXA_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetchWithTimeout(
        "https://mcp.exa.ai/mcp",
        {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "web_search_exa",
              arguments: {
                query: trimmedQuery,
                type: "auto",
                numResults: clampExaResults(numResults),
                livecrawl: "fallback",
                contextMaxCharacters: 3500,
              },
            },
          }),
        },
        EXA_MCP_REQUEST_TIMEOUT_MS,
      );
      if (!response.ok) {
        const status = response.status;
        const retryable = status >= 500 || status === 429;
        const err = new ExaSearchError(`Exa MCP search failed: HTTP ${status}`, {
          status,
          retryable,
          reason: status === 429 ? "rate_limited" : "http",
        });
        if (!retryable || attempt === EXA_MAX_ATTEMPTS) throw err;
        lastError = err;
        await sleep(EXA_RETRY_BACKOFF_MS * attempt);
        continue;
      }
      const text = parseExaMcpTextResponse(await response.text());
      if (!text) {
        throw new ExaSearchError("Exa MCP search returned no content", {
          status: response.status,
          retryable: false,
          reason: "empty",
        });
      }
      return text;
    } catch (error) {
      const err = toExaError(error, "network");
      if (!err.retryable || attempt === EXA_MAX_ATTEMPTS) throw err;
      lastError = err;
      await sleep(EXA_RETRY_BACKOFF_MS * attempt);
    }
  }
  throw (
    lastError ??
    new ExaSearchError("Exa MCP search failed after retries", {
      retryable: true,
      reason: "network",
    })
  );
}

export async function completeTextAttachment(env: AppEnv, objectKey: string) {
  const object = await env.UPLOADS.get(objectKey);
  if (!object) return null;
  return object.text();
}

export async function getSignedAttachmentUrl(env: AppEnv, objectKey: string) {
  const url = new URL(`/api/uploads/blob/${encodeURIComponent(objectKey)}`, env.BETTER_AUTH_URL);
  const token = await signUploadToken(env, {
    action: "read_attachment",
    objectKey,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  url.searchParams.set("token", token);
  return url.toString();
}

export function isInlineTextAttachment(mimeType: string, sizeBytes: number) {
  return sizeBytes <= 100_000 && /^(text\/|application\/json|text\/csv)/.test(mimeType);
}

export function isImageAttachment(mimeType: string) {
  return mimeType.startsWith("image/");
}

export async function createUploadUrl(request: Request, objectKey: string) {
  const url = new URL(request.url);
  url.pathname = `/api/uploads/blob/${encodeURIComponent(objectKey)}`;
  url.search = "";
  return url.toString();
}

export async function signUploadToken(env: AppEnv, payload: Record<string, unknown>) {
  const data = encoder.encode(JSON.stringify(payload));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.BETTER_AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", keyMaterial, data);
  return `${btoa(String.fromCharCode(...data))}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`;
}

export async function verifyUploadToken(env: AppEnv, token: string) {
  const [payloadPart, signaturePart] = token.split(".");
  if (!payloadPart || !signaturePart) return null;
  const payloadBytes = Uint8Array.from(atob(payloadPart), (char) => char.charCodeAt(0));
  const signatureBytes = Uint8Array.from(atob(signaturePart), (char) => char.charCodeAt(0));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.BETTER_AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify("HMAC", keyMaterial, signatureBytes, payloadBytes);
  if (!valid) return null;
  return JSON.parse(new TextDecoder().decode(payloadBytes)) as Record<string, unknown>;
}
