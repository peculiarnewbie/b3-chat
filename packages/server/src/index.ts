export {
  ChatCompletionsAdapter,
  createChatCompletionsAdapter,
  type ChatCompletionsAdapterConfig,
  type ChatCompletionsUsage,
  type SimpleModelMessage,
  type ContentPart,
  type SimpleChatOptions,
  type StreamEvent,
} from "./chat-completions-adapter.js";
import { createChatCompletionsAdapter } from "./chat-completions-adapter.js";
import { betterAuth } from "better-auth";
import { dash } from "@better-auth/infra";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  TABLES,
  buildMultiSearchContext,
  createId,
  nowIso,
  type SyncCommandPayloadMap,
  type SyncCommandType,
  type SyncSnapshot,
} from "@b3-chat/domain";

export type AppEnv = {
  ALLOWED_EMAIL: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_API_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  OPENCODE_GO_BASE_URL: string;
  OPENCODE_GO_API_KEY: string;
  OPENCODE_GO_MODEL_ALLOWLIST?: string;
  DEFAULT_MODEL_ID: string;
  EXA_API_KEY: string;
  AUTH_DB: D1Database;
  UPLOADS: R2Bucket;
  SYNC_ENGINE: DurableObjectNamespace;
};

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
const SEARCH_PLANNER_MODEL_ID = "minimax-m2.5";
const encoder = new TextEncoder();

type ExaSearchResult = {
  title?: string;
  url: string;
  highlights?: string[];
  text?: string;
  publishedDate?: string | null;
  highlightScores?: number[];
};

type ExaSearchResponse = {
  results?: ExaSearchResult[];
};

export type SearchQueryDecision = {
  shouldSearch: boolean;
  query: string;
};

function normalizeSearchPrompt(text: string) {
  return text.trim().replace(/\s+/g, " ");
}

function isSearchCapabilityQuestion(text: string) {
  const normalized = normalizeSearchPrompt(text).toLowerCase();
  if (!normalized) return false;

  return [
    /^(can|could|would|will)\s+you\s+(do\s+)?(a\s+)?(web\s+)?(search|searches|browse|look up)(\s+the\s+web)?(\s+for\s+me)?\??$/,
    /^(do|does)\s+you\s+(have|support|use)\s+(web\s+)?(search|searches|browsing)(\s+capabilit(?:y|ies))?\??$/,
    /^are\s+you\s+(able|capable)\s+to\s+(search|browse|look up)(\s+the\s+web)?\??$/,
  ].some((pattern) => pattern.test(normalized));
}

function isDeicticLookupPrompt(text: string) {
  const normalized = normalizeSearchPrompt(text).toLowerCase().replace(/[?]+$/g, "");
  if (!normalized) return false;

  return [
    /^(please\s+)?use\s+(your\s+)?(web\s+)?search(\s+for)?\s+(this|that|it)$/,
    /^(now\s+)?you\s+can\s+(search( for)?|look up|check( online)?|find out|google|browse)\s+(this|that|it)$/,
    /^(please\s+)?(search( for)?|look up|check( online)?|find out|google|browse)\s+(this|that|it)$/,
    /^(please\s+)?look\s+(this|that|it)\s+up$/,
    /^(please\s+)?(look it up|search for it|search it|check it|find out|google it|browse it)$/,
    /^(now\s+)?(you\s+can\s+)?(this|that|it)$/,
  ].some((pattern) => pattern.test(normalized));
}

export function inferForcedSearchQuery(promptText: string) {
  const normalized = normalizeSearchPrompt(promptText).toLowerCase();
  if (!normalized) return null;
  if (isSearchCapabilityQuestion(promptText)) return null;
  if (isDeicticLookupPrompt(promptText)) return null;

  const asksForLookup =
    /\b(look up|lookup|search( for)?|google|browse|check online|find online|find out|verify online)\b/.test(
      normalized,
    ) || /\bcan you look up\b/.test(normalized);
  const asksRealtime =
    /\bwhat('?s| is) (the )?time\b/.test(normalized) ||
    /\bwhat time is it\b/.test(normalized) ||
    /\bwhat('?s| is) (the )?date\b/.test(normalized) ||
    /\btoday'?s date\b/.test(normalized) ||
    /\b(current|latest|today|tonight|right now|currently|recent|live|real[- ]?time)\b/.test(
      normalized,
    ) ||
    /\b(weather|forecast|score|scores|standings|price|stock price|exchange rate|who won|winner|results?)\b/.test(
      normalized,
    );

  if (!asksForLookup && !asksRealtime) return null;

  if (/\bwhat('?s| is) (the )?time\b|\bwhat time is it\b/.test(normalized)) {
    return "current local time now";
  }

  if (/\bwhat('?s| is) (the )?date\b|\btoday'?s date\b/.test(normalized)) {
    return "today's date now";
  }

  const stripped = normalizeSearchPrompt(
    promptText
      .replace(/^\s*(so+|hey|hi|please)\b[:,]?\s*/i, "")
      .replace(/^\s*(can|could|would|will)\s+you\s+/i, "")
      .replace(
        /\b(look up|lookup|search( for)?|google|browse|check online|find online|find out|verify online)\b/gi,
        "",
      )
      .replace(/[?]+$/g, ""),
  );

  if (isDeicticLookupPrompt(stripped)) return null;

  return stripped || normalizeSearchPrompt(promptText);
}

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

export function getSearchPlannerModelId() {
  return SEARCH_PLANNER_MODEL_ID;
}

export function getRuntimeEnv() {
  const env = globalThis.__env__;
  if (!env) throw new Error("Cloudflare env bindings are not available");
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
      reasoning: !!model.reasoning,
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

export async function exaSearch(env: AppEnv, query: string, numResults = DEFAULT_EXA_RESULTS) {
  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.EXA_API_KEY,
    },
    body: JSON.stringify({
      query,
      numResults: clampExaResults(numResults),
      contents: {
        highlights: {
          maxCharacters: 700,
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`Exa search failed: ${response.status}`);
  const json = (await response.json()) as ExaSearchResponse;
  return (json.results ?? []).map((result: any) => ({
    id: createId("src"),
    title: result.title ?? result.url,
    url: result.url,
    snippet: result.highlights?.[0] ?? result.text?.slice(0, 500) ?? "",
    publishedAt: result.publishedDate ?? null,
    domain: new URL(result.url).hostname,
    score: Number(result.highlightScores?.[0] ?? 0),
  }));
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

function noSearchQueryDecision(): SearchQueryDecision {
  return {
    shouldSearch: false,
    query: "",
  };
}

export function parseSearchQueryDecision(text: string): SearchQueryDecision {
  const jsonSlice = text.trim().match(/\{[\s\S]*\}/)?.[0];
  if (!jsonSlice) return noSearchQueryDecision();

  let parsed: any;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch {
    return noSearchQueryDecision();
  }

  if (typeof parsed?.shouldSearch !== "boolean") {
    return noSearchQueryDecision();
  }
  if (parsed.shouldSearch === false) {
    return noSearchQueryDecision();
  }

  const query = typeof parsed?.query === "string" ? parsed.query.trim() : "";
  if (!query) return noSearchQueryDecision();

  return {
    shouldSearch: true,
    query,
  };
}

const searchPlannerSystemPrompt = [
  "Decide whether the assistant should perform a web search before answering.",
  `Today's date is ${new Date().toISOString().slice(0, 10)}.`,
  "Return JSON only with this exact shape:",
  '{"shouldSearch":boolean,"query":string}',
  "Read the recent raw conversation and resolve follow-ups, references, dates, and timeframe from that context.",
  "If the latest user message depends on current or external information, set shouldSearch=true and rewrite it into one clean search query.",
  'Examples of contextual follow-ups include "what about now?", "now you can search for it", "look it up", "search that", and bare follow-ups like "2026".',
  'If the user can be answered from conversation alone, set shouldSearch=false and query="".',
  'If the user is asking whether search is available or supported, set shouldSearch=false and query="".',
  "Do not search casual chat, rewriting, summarization of provided text, or repo-local coding questions.",
  "Do not return a literal deictic query containing unresolved words like this, that, it, now, or only a year if the conversation provides the missing referent.",
  'If search is not needed, return exactly {"shouldSearch":false,"query":""}.',
  "Return no prose, no markdown, no explanation.",
].join("\n");

export async function decideSearchQuery(
  env: AppEnv,
  input: {
    modelId: string;
    planningContext: string;
  },
) {
  const adapter = createChatCompletionsAdapter(
    {
      baseUrl: env.OPENCODE_GO_BASE_URL,
      apiKey: env.OPENCODE_GO_API_KEY,
    },
    getSearchPlannerModelId(),
  );

  const rawText = await adapter.text({
    messages: [{ role: "user", content: input.planningContext }],
    systemPrompts: [searchPlannerSystemPrompt],
    temperature: 0,
    maxTokens: 180,
  });

  const decision = parseSearchQueryDecision(rawText);
  console.log("[decideSearchQuery]", JSON.stringify({ rawText, decision }));
  return decision;
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
  const response = await fetch("https://mcp.exa.ai/mcp", {
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
          query,
          type: "auto",
          numResults: clampExaResults(numResults),
          livecrawl: "fallback",
          contextMaxCharacters: 3500,
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`Exa MCP search failed: ${response.status}`);
  const text = parseExaMcpTextResponse(await response.text());
  if (!text) throw new Error("Exa MCP search returned no content");
  return text;
}

export async function exaMcpSearchContext(query: string, numResults = DEFAULT_EXA_RESULTS) {
  const text = await exaMcpSearchRawText(query, numResults);
  return buildMultiSearchContext({
    runs: [
      {
        query,
        rawText: text,
      },
    ],
  });
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

export async function collectChatHistory(snapshot: SyncSnapshot, threadId: string) {
  const tables = snapshot.tables ?? {};
  const messages = Object.values<any>(tables[TABLES.messages] ?? {})
    .filter((message) => message.threadId === threadId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const partsByMessage = Object.values<any>(tables[TABLES.messageParts] ?? {}).reduce(
    (acc, part) => {
      (acc[part.messageId] ??= []).push(part);
      return acc;
    },
    {} as Record<string, any[]>,
  );
  Object.values<any[]>(partsByMessage).forEach((parts) =>
    parts.sort((a: any, b: any) => a.seq - b.seq),
  );
  return messages.map((message) => ({
    ...message,
    parts: partsByMessage[message.id] ?? [],
  }));
}

export function makeThreadTitle(messages: any[]) {
  const first = messages.find((message) => message.role === "user" && message.text?.trim());
  if (!first) return "New Chat";
  return String(first.text).trim().replace(/\s+/g, " ").slice(0, 48) || "New Chat";
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

export async function heartbeat(env: AppEnv) {
  const db = drizzle(env.AUTH_DB);
  await db.run(sql`select 1`);
  return {
    ok: true,
    at: nowIso(),
  };
}
