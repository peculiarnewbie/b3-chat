import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";
import {
  createId,
  createThread,
  createWorkspace,
  nowIso,
  TABLES,
  VALUES,
  type SyncMutation,
} from "@g3-chat/domain";

export type AppEnv = {
  ALLOWED_EMAIL: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
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

const DAY_MS = 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();

type SyncSnapshot = {
  tables?: Record<string, Record<string, any>>;
};

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

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function allowedEmail(env: AppEnv) {
  return normalizeEmail(env.ALLOWED_EMAIL);
}

export function getRuntimeEnv() {
  const env = globalThis.__env__;
  if (!env) throw new Error("Cloudflare env bindings are not available");
  return env;
}

export async function ensureAuthSchema(env: AppEnv) {
  const statements = [
    `create table if not exists user (
      id text primary key,
      name text not null,
      email text not null unique,
      emailVerified integer not null default 0,
      image text,
      createdAt integer not null,
      updatedAt integer not null
    )`,
    `create table if not exists session (
      id text primary key,
      expiresAt integer not null,
      token text not null unique,
      createdAt integer not null,
      updatedAt integer not null,
      ipAddress text,
      userAgent text,
      userId text not null references user(id) on delete cascade
    )`,
    `create table if not exists account (
      id text primary key,
      accountId text not null,
      providerId text not null,
      userId text not null references user(id) on delete cascade,
      accessToken text,
      refreshToken text,
      idToken text,
      accessTokenExpiresAt integer,
      refreshTokenExpiresAt integer,
      scope text,
      password text,
      createdAt integer not null,
      updatedAt integer not null
    )`,
    `create unique index if not exists account_provider_account_idx on account(providerId, accountId)`,
    `create table if not exists verification (
      id text primary key,
      identifier text not null,
      value text not null,
      expiresAt integer not null,
      createdAt integer,
      updatedAt integer
    )`,
    `create index if not exists verification_identifier_idx on verification(identifier)`,
  ];
  for (const statement of statements) await env.AUTH_DB.exec(statement);
}

export function createAuth(env: AppEnv) {
  const db = drizzle(env.AUTH_DB);
  const auth = betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    database: drizzleAdapter(db, {
      provider: "sqlite",
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
    advanced: {
      database: {
        generateId: () => createId("usr"),
      },
      cookiePrefix: "g3",
    },
  });
  return auth;
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

export async function getSyncSnapshot(env: AppEnv) {
  const stub = await getSyncStub(env);
  const response = await stub.fetch("https://sync.internal/snapshot");
  return (await response.json()) as SyncSnapshot;
}

export async function syncMutate(env: AppEnv, mutation: SyncMutation) {
  const stub = await getSyncStub(env);
  const response = await stub.fetch("https://sync.internal/mutate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(mutation),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

export async function bootstrapSyncStore(env: AppEnv) {
  return syncMutate(env, {
    type: "bootstrap",
    defaultModelId: env.DEFAULT_MODEL_ID,
  });
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

export async function exaSearch(env: AppEnv, query: string) {
  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.EXA_API_KEY,
    },
    body: JSON.stringify({
      query,
      numResults: 5,
      contents: {
        highlights: {
          maxCharacters: 700,
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`Exa search failed: ${response.status}`);
  const json = (await response.json()) as ExaSearchResponse;
  return (json.results ?? []).map((result: any, index: number) => ({
    id: createId(`src${index}`),
    title: result.title ?? result.url,
    url: result.url,
    snippet: result.highlights?.[0] ?? result.text?.slice(0, 500) ?? "",
    publishedAt: result.publishedDate ?? null,
    domain: new URL(result.url).hostname,
    score: Number(result.highlightScores?.[0] ?? 0),
  }));
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

export async function exaMcpSearchContext(query: string) {
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
          numResults: 5,
          livecrawl: "fallback",
          contextMaxCharacters: 3500,
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`Exa MCP search failed: ${response.status}`);
  const text = parseExaMcpTextResponse(await response.text());
  if (!text) throw new Error("Exa MCP search returned no content");
  return [
    "Use these web search results as grounding. Cite the relevant sources inline when relevant.",
    text,
  ].join("\n\n");
}

export async function completeTextAttachment(env: AppEnv, objectKey: string) {
  const object = await env.UPLOADS.get(objectKey);
  if (!object) return null;
  return object.text();
}

export async function getSignedAttachmentUrl(env: AppEnv, objectKey: string) {
  const url = new URL(`/api/uploads/blob/${encodeURIComponent(objectKey)}`, env.BETTER_AUTH_URL);
  return url.toString();
}

export function isInlineTextAttachment(mimeType: string, sizeBytes: number) {
  return sizeBytes <= 100_000 && /^(text\/|application\/json|text\/csv)/.test(mimeType);
}

export function isImageAttachment(mimeType: string) {
  return mimeType.startsWith("image/");
}

export async function collectChatHistory(snapshot: any, threadId: string) {
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

export async function ensureSeedData(env: AppEnv) {
  const snapshot = await getSyncSnapshot(env);
  const workspaces = Object.values<any>(snapshot.tables?.[TABLES.workspaces] ?? {});
  if (workspaces.length > 0) return snapshot;

  const workspace = createWorkspace({
    name: "Default Workspace",
    defaultModelId: env.DEFAULT_MODEL_ID,
    defaultSearchMode: false,
    systemPrompt: "",
  });
  const thread = createThread({
    workspaceId: workspace.id,
    title: "New Chat",
  });
  await syncMutate(env, { type: "upsert-workspace", row: workspace });
  await syncMutate(env, { type: "upsert-thread", row: thread });
  await syncMutate(env, { type: "set-value", key: VALUES.activeWorkspaceId, value: workspace.id });
  await syncMutate(env, { type: "set-value", key: VALUES.activeThreadId, value: thread.id });
  return getSyncSnapshot(env);
}

export async function heartbeat(env: AppEnv) {
  const db = drizzle(env.AUTH_DB);
  await db.run(sql`select 1`);
  return {
    ok: true,
    at: nowIso(),
  };
}
