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
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_EXA_RESULTS = 5;
const MIN_EXA_RESULTS = 3;
const MAX_EXA_RESULTS = 8;
/** Max time for a single Exa API HTTP call. Search hangs are a common source of
 *  stuck tool loops, but we'd rather wait a bit longer than kill a slow-but-
 *  working query; 60s gives Exa room on cold-path queries while still bounded. */
const EXA_REQUEST_TIMEOUT_MS = 60_000;
/** Max time for the Exa MCP fallback. Matches the API timeout — MCP does more
 *  work (autoprompt + livecrawl fallback), but 60s is generous for both. */
const EXA_MCP_REQUEST_TIMEOUT_MS = 60_000;
/** One quick retry for transient network errors / 5xx. Never retry on 4xx. */
const EXA_MAX_ATTEMPTS = 2;
const EXA_RETRY_BACKOFF_MS = 500;

/** Browser Rendering extract timeout. A real Chromium render plus navigation
 *  is slower than a plain REST search (seconds vs hundreds of ms), so the
 *  budget is wider. */
const BROWSER_RENDER_TIMEOUT_MS = 30_000;
/** Max chars of extracted content we hand back to the model. Full pages can
 *  easily exceed 50KB; the model rarely benefits from more than ~12k chars
 *  and longer output bloats context for no gain. */
const BROWSER_RENDER_MAX_CHARS = 12_000;
/** One retry on transient errors (session churn, goto aborts). */
const BROWSER_RENDER_MAX_ATTEMPTS = 2;
const BROWSER_RENDER_RETRY_BACKOFF_MS = 600;
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

const MODELS_CATALOG_URL = "https://models.dev/api.json";

export async function purgeModelsCatalogCache(cache: Cache) {
  await cache.delete(new Request(MODELS_CATALOG_URL));
}

export async function fetchModelsCatalog(env: AppEnv, cache: Cache) {
  const cacheKey = new Request(MODELS_CATALOG_URL);
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const response = await fetch(MODELS_CATALOG_URL, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Failed to fetch models catalog: ${response.status}`);
  const json = await response.json();
  await cache.put(
    cacheKey,
    new Response(JSON.stringify(json), {
      headers: {
        "content-type": "application/json",
        "cache-control": `public, max-age=${HOUR_MS / 1000}`,
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
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  // Link an external signal (e.g. the assistant-turn abort) into our
  // internal controller so user-initiated cancel and timeout both abort
  // the same fetch. If the external signal is already aborted, fire
  // synchronously — fetch() will reject before sending a single byte.
  let externalListener: (() => void) | null = null;
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalListener = () => controller.abort(externalSignal.reason);
      externalSignal.addEventListener("abort", externalListener, { once: true });
    }
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (externalSignal && externalListener) {
      externalSignal.removeEventListener("abort", externalListener);
    }
  }
}

async function runExaSearchRequest(
  apiKey: string,
  query: string,
  numResults: number,
  signal?: AbortSignal,
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
        signal,
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
      // If the caller aborted, don't burn a retry cycle — bubble up now.
      if (signal?.aborted) throw err;
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

export async function exaSearch(
  env: AppEnv,
  query: string,
  numResults = DEFAULT_EXA_RESULTS,
  signal?: AbortSignal,
) {
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
  const json = await runExaSearchRequest(apiKey, trimmedQuery, clampedResults, signal);
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

export async function exaMcpSearchRawText(
  query: string,
  numResults = DEFAULT_EXA_RESULTS,
  signal?: AbortSignal,
) {
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
        signal,
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
      // If the caller aborted, stop retrying and bubble the error up.
      if (signal?.aborted) throw err;
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

// ---------------------------------------------------------------------------
// Cloudflare Browser Rendering — /markdown extraction
// ---------------------------------------------------------------------------

/**
 * Structured error surfaced by the extract tool. Mirrors ExaSearchError so the
 * tool handler can map it to a stable `reason` the model can reason about.
 */
export class BrowserRenderError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  readonly reason:
    | "timeout"
    | "network"
    | "http"
    | "auth"
    | "rate_limited"
    | "invalid_url"
    | "empty"
    | "not_configured";
  constructor(
    message: string,
    init: {
      status?: number | null;
      retryable: boolean;
      reason: BrowserRenderError["reason"];
    },
  ) {
    super(message);
    this.name = "BrowserRenderError";
    this.status = init.status ?? null;
    this.retryable = init.retryable;
    this.reason = init.reason;
  }
}

function toBrowserRenderError(
  error: unknown,
  fallbackReason: "timeout" | "network",
): BrowserRenderError {
  if (error instanceof BrowserRenderError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (
    lower.includes("abort") ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("deadline")
  ) {
    return new BrowserRenderError("Browser Rendering timed out", {
      status: null,
      retryable: true,
      reason: "timeout",
    });
  }
  return new BrowserRenderError(`Browser Rendering network error: ${message.slice(0, 200)}`, {
    status: null,
    retryable: true,
    reason: fallbackReason,
  });
}

/**
 * Normalize a user-provided URL string. Rejects non-http(s) schemes and
 * anything that doesn't parse. The model often emits bare domains (`example.com`)
 * — we prepend `https://` to be forgiving.
 */
export function normalizeExtractUrl(input: string): URL | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  // If the caller provided an explicit scheme other than http(s), bail
  // instead of silently coercing it — otherwise `ftp://x.y/z` becomes
  // `https://ftp://x.y/z`, which parses as a valid URL with host `ftp`.
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (schemeMatch && !/^https?$/i.test(schemeMatch[1]!)) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url;
  } catch {
    return null;
  }
}

/** Truncate extracted markdown to keep tool output context-friendly. */
export function truncateExtractedMarkdown(markdown: string) {
  if (markdown.length <= BROWSER_RENDER_MAX_CHARS) {
    return { text: markdown, truncated: false, originalLength: markdown.length };
  }
  return {
    text: `${markdown.slice(0, BROWSER_RENDER_MAX_CHARS)}\n\n[… truncated at ${BROWSER_RENDER_MAX_CHARS} chars of ${markdown.length} total]`,
    truncated: true,
    originalLength: markdown.length,
  };
}

/**
 * In-page HTML → markdown-ish text. Runs inside the headless Chromium tab
 * with full DOM access, so we avoid pulling a turndown-style library into
 * the Worker bundle. The output is close enough to markdown to be useful
 * to an LLM — headings, lists, code, and links are preserved; inline
 * styling isn't.
 *
 * Kept as a stringifiable function because `page.evaluate` serializes it
 * and evaluates it in the page context — closures to module-scope values
 * do NOT work.
 */
function extractMarkdownInPage(): string {
  // Prefer the most specific semantic container the page exposes. Fall back
  // to <body> so we always produce some content.
  const root: Element =
    document.querySelector("article") ||
    document.querySelector("main") ||
    document.querySelector('[role="main"]') ||
    document.body;
  if (!root) return "";
  const clone = root.cloneNode(true) as Element;
  const drop = clone.querySelectorAll(
    "script, style, noscript, nav, footer, header, aside, iframe, form, button, input, " +
      'select, textarea, [aria-hidden="true"], [role="navigation"], [role="banner"], ' +
      '[role="contentinfo"], [role="complementary"]',
  );
  for (const node of Array.from(drop)) node.remove();

  const lines: string[] = [];
  function pushText(text: string) {
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (trimmed) lines.push(trimmed);
  }
  function renderInline(element: Element): string {
    let out = "";
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += (child.textContent ?? "").replace(/\s+/g, " ");
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        const tag = el.tagName.toLowerCase();
        if (tag === "a") {
          const href = (el as HTMLAnchorElement).href?.trim();
          const label = renderInline(el).trim();
          out += href && label && href !== label ? `[${label}](${href})` : label;
        } else if (tag === "code") {
          out += `\`${renderInline(el)}\``;
        } else if (tag === "strong" || tag === "b") {
          out += `**${renderInline(el)}**`;
        } else if (tag === "em" || tag === "i") {
          out += `*${renderInline(el)}*`;
        } else if (tag === "br") {
          out += "\n";
        } else {
          out += renderInline(el);
        }
      }
    }
    return out;
  }
  function walk(element: Element) {
    const tag = element.tagName.toLowerCase();
    if (tag === "pre") {
      const code = element.textContent ?? "";
      if (code.trim()) {
        lines.push("```");
        lines.push(code.trimEnd());
        lines.push("```");
      }
      return;
    }
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1));
      const text = renderInline(element).trim();
      if (text) lines.push(`${"#".repeat(level)} ${text}`);
      return;
    }
    if (tag === "li") {
      const text = renderInline(element).trim();
      if (text) lines.push(`- ${text}`);
      return;
    }
    if (tag === "p" || tag === "blockquote") {
      const text = renderInline(element).trim();
      if (text) lines.push(tag === "blockquote" ? `> ${text}` : text);
      return;
    }
    if (tag === "hr") {
      lines.push("---");
      return;
    }
    // Container — recurse into element children. Leaf text nodes are
    // only captured inside the inline renderers above, so pure-text
    // containers (like lone <span>s) still surface via their parent's
    // renderInline call.
    let onlyText = true;
    for (const child of Array.from(element.children)) {
      const childTag = child.tagName.toLowerCase();
      if (
        /^(h[1-6]|p|pre|ul|ol|li|blockquote|hr|article|section|div|main|header|footer|nav|aside|table|thead|tbody|tr)$/.test(
          childTag,
        )
      ) {
        onlyText = false;
        break;
      }
    }
    if (onlyText) {
      const text = renderInline(element).trim();
      if (text) pushText(text);
      return;
    }
    for (const child of Array.from(element.children)) walk(child);
  }
  walk(clone);
  // Collapse runs of duplicate blank lines and return.
  const joined = lines.join("\n\n").replace(/\n{3,}/g, "\n\n");
  return joined.trim();
}

/**
 * Renders `url` via the Cloudflare Browser Rendering binding and returns
 * markdown-ish text. The binding avoids the round-trip to
 * `api.cloudflare.com` and the associated API token — we're already on
 * Cloudflare, so we talk to the browser service directly.
 *
 * Throws `BrowserRenderError` on failure; the tool handler maps it to a
 * structured result for the model.
 */
export async function cloudflareBrowserMarkdown(
  env: AppEnv,
  rawUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  const binding = env.BROWSER as unknown;
  if (!binding) {
    throw new BrowserRenderError("Browser Rendering binding is not configured", {
      status: null,
      retryable: false,
      reason: "not_configured",
    });
  }

  const parsed = normalizeExtractUrl(rawUrl);
  if (!parsed) {
    throw new BrowserRenderError("URL is not a valid http(s) URL", {
      status: null,
      retryable: false,
      reason: "invalid_url",
    });
  }
  const target = parsed.toString();

  // If the caller's signal is already aborted, bail before spending a
  // concurrent-session slot on a session we'd immediately tear down.
  // Map the abort through `toBrowserRenderError` in the catch block —
  // "aborted" flows into the "timeout" bucket since `BrowserRenderError`
  // doesn't have a dedicated `aborted` reason and the classification is
  // treated as retryable-but-don't-retry at the tool layer.
  if (signal?.aborted) {
    throw toBrowserRenderError(signal.reason ?? new Error("Browser Rendering aborted"), "network");
  }

  let lastError: BrowserRenderError | null = null;
  for (let attempt = 1; attempt <= BROWSER_RENDER_MAX_ATTEMPTS; attempt++) {
    let browser: any = null;
    // Listener that tears down the in-flight browser session when the
    // caller aborts. Closing the browser mid-`page.goto` / `page.evaluate`
    // makes those calls reject, which propagates back into the catch
    // below. Registered per attempt because `browser` is recreated each
    // iteration; removed in `finally` so we don't leak listeners across
    // retries.
    let abortListener: (() => void) | null = null;
    try {
      // `keep_alive` lets Cloudflare reuse this session for up to 10 min if
      // another extract call lands on the same Worker isolate. We still
      // close the browser in `finally` to release the concurrent-session
      // slot — the underlying session stays warm server-side.
      const puppeteer = (await import("@cloudflare/puppeteer")).default;
      browser = await puppeteer.launch(binding as any, {
        keep_alive: 60_000,
      });
      if (signal) {
        // If abort fires while we were awaiting `puppeteer.launch`, the
        // listener will run synchronously after registration and close the
        // browser we just opened. If it fires later, closing rejects the
        // pending `page.goto` / `page.evaluate` promise with an error
        // whose message contains "closed" / "disconnected", which
        // `toBrowserRenderError` maps to a network error.
        abortListener = () => {
          browser?.close().catch(() => {
            // Closing a browser mid-teardown is expected to fail; swallow.
          });
        };
        if (signal.aborted) {
          abortListener();
        } else {
          signal.addEventListener("abort", abortListener, { once: true });
        }
      }
      const page = await browser.newPage();

      // Block heavy resources we don't need for text extraction. This
      // makes rendering 2–3× faster on image-heavy pages and avoids
      // chewing through the page-weight budget.
      await page.setRequestInterception(true);
      page.on("request", (req: { resourceType(): string; abort(): void; continue(): void }) => {
        const type = req.resourceType();
        if (type === "image" || type === "media" || type === "font" || type === "stylesheet") {
          req.abort();
        } else {
          req.continue();
        }
      });

      const response = await page.goto(target, {
        waitUntil: "domcontentloaded",
        timeout: BROWSER_RENDER_TIMEOUT_MS,
      });
      const status = response?.status() ?? 0;
      if (status && status >= 400) {
        const retryable = status >= 500 || status === 429;
        const reason: BrowserRenderError["reason"] =
          status === 401 || status === 403 ? "auth" : status === 429 ? "rate_limited" : "http";
        const err = new BrowserRenderError(`Browser Rendering: target returned HTTP ${status}`, {
          status,
          retryable,
          reason,
        });
        if (!retryable || attempt === BROWSER_RENDER_MAX_ATTEMPTS) throw err;
        lastError = err;
        await sleep(BROWSER_RENDER_RETRY_BACKOFF_MS * attempt);
        continue;
      }

      const markdown = await page.evaluate(extractMarkdownInPage);
      if (!markdown || !markdown.trim()) {
        throw new BrowserRenderError("Browser Rendering returned empty content", {
          status: status || null,
          retryable: false,
          reason: "empty",
        });
      }
      return markdown;
    } catch (error) {
      const err = toBrowserRenderError(error, "network");
      // If the caller aborted, stop immediately — don't sleep through a
      // retry cycle the user already said they don't want. We bubble the
      // (likely "timed out"-classified) error up; the tool layer checks
      // `signal.aborted` and presents it as a cancellation rather than a
      // render failure.
      if (signal?.aborted) throw err;
      if (!err.retryable || attempt === BROWSER_RENDER_MAX_ATTEMPTS) throw err;
      lastError = err;
      await sleep(BROWSER_RENDER_RETRY_BACKOFF_MS * attempt);
    } finally {
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
      if (browser) {
        try {
          await browser.close();
        } catch {
          // Closing a browser that's already gone is fine — session expired
          // or the worker is shutting down.
        }
      }
    }
  }
  throw (
    lastError ??
    new BrowserRenderError("Browser Rendering failed after retries", {
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
