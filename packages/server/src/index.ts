import { betterAuth } from "better-auth";
import { dash } from "@better-auth/infra";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  TABLES,
  createId,
  nowIso,
  type SyncCommandPayloadMap,
  type SyncCommandType,
  type SyncSnapshot,
  type UserProviderSettingsInput,
  type UserProviderSettingsState,
  type UserRuntimeConfig,
} from "@g3-chat/domain";

export type AppEnv = {
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_API_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  OPENCODE_GO_BASE_URL: string;
  OPENCODE_GO_MODEL_ALLOWLIST?: string;
  DEFAULT_MODEL_ID: string;
  USER_SECRET_ENCRYPTION_KEY: string;
  AUTH_DB: D1Database;
  UPLOADS: R2Bucket;
  SYNC_ENGINE: DurableObjectNamespace;
};

export type SessionUser = {
  userId: string;
  email: string;
  name: string | null;
  image: string | null;
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

type InternalCommandResponse = {
  ok: boolean;
  snapshot?: SyncSnapshot;
  reason?: string;
  code?: string;
};

type BetterAuthSession = {
  user?: {
    id?: string;
    email?: string;
    name?: string | null;
    image?: string | null;
  };
};

type EncryptedSecretRecord = {
  version: 1;
  algorithm: "AES-GCM";
  iv: string;
  ciphertext: string;
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
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function getDefaultModelId(env: Pick<AppEnv, "DEFAULT_MODEL_ID">) {
  return env.DEFAULT_MODEL_ID?.trim() || "auto";
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
          before: async (rawUser: Record<string, unknown>) => ({
            data: {
              ...rawUser,
              email: normalizeEmail(typeof rawUser.email === "string" ? rawUser.email : ""),
            },
          }),
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
      cookiePrefix: "g3",
    },
  });
}

export async function getSession(request: Request, env: AppEnv) {
  await ensureAuthSchema(env);
  const auth = createAuth(env);
  const session = (await auth.api.getSession({
    headers: request.headers,
  })) as BetterAuthSession | null;
  if (!session?.user?.id || !session.user.email) return null;
  return session;
}

export async function getSessionUser(request: Request, env: AppEnv): Promise<SessionUser | null> {
  const session = await getSession(request, env);
  if (!session?.user?.id || !session.user.email) return null;
  return {
    userId: session.user.id,
    email: normalizeEmail(session.user.email),
    name: session.user.name ?? null,
    image: session.user.image ?? null,
  };
}

export async function requireSession(request: Request, env: AppEnv) {
  const session = await getSession(request, env);
  if (!session) throw new Response("Unauthorized", { status: 401 });
  return session;
}

export async function requireSessionUser(request: Request, env: AppEnv) {
  const user = await getSessionUser(request, env);
  if (!user) throw new Response("Unauthorized", { status: 401 });
  return user;
}

export function getSyncStubForUser(env: AppEnv, userId: string) {
  return env.SYNC_ENGINE.get(env.SYNC_ENGINE.idFromName(userId));
}

export async function sendInternalSyncCommandForUser<T extends SyncCommandType>(
  env: AppEnv,
  userId: string,
  commandType: T,
  payload: SyncCommandPayloadMap[T],
  opId = createId("srvop"),
) {
  const stub = getSyncStubForUser(env, userId);
  const response = await stub.fetch("https://sync.internal/internal/command", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-g3-user-id": userId,
    },
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

export async function fetchUserProviderSettings(env: AppEnv, userId: string) {
  const stub = getSyncStubForUser(env, userId);
  const response = await stub.fetch("https://sync.internal/settings/providers", {
    headers: {
      "x-g3-user-id": userId,
    },
  });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as UserProviderSettingsState;
}

export async function saveUserProviderSettings(
  env: AppEnv,
  userId: string,
  input: UserProviderSettingsInput,
) {
  const stub = getSyncStubForUser(env, userId);
  const response = await stub.fetch("https://sync.internal/settings/providers", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-g3-user-id": userId,
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as UserProviderSettingsState;
}

export async function fetchUserRuntimeConfig(env: AppEnv, userId: string) {
  const stub = getSyncStubForUser(env, userId);
  const response = await stub.fetch("https://sync.internal/runtime-config", {
    headers: {
      "x-g3-user-id": userId,
    },
  });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as UserRuntimeConfig;
}

export async function fetchModelsCatalog(_env: AppEnv, cache: Cache) {
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

export function filterModelsCatalog(
  raw: any,
  env: Pick<AppEnv, "OPENCODE_GO_MODEL_ALLOWLIST" | "OPENCODE_GO_BASE_URL">,
) {
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

export async function exaSearch(apiKey: string, query: string) {
  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
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

export function parseExaMcpTextResponse(responseText: string) {
  for (const line of responseText.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = JSON.parse(line.slice(6));
    const text = payload?.result?.content?.find?.((item: any) => item?.type === "text")?.text;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  return "";
}

export async function exaMcpSearchContext(apiKey: string, query: string) {
  const response = await fetch("https://mcp.exa.ai/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
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
  return `${bytesToBase64(data)}.${bytesToBase64(new Uint8Array(signature))}`;
}

export async function verifyUploadToken(env: AppEnv, token: string) {
  const [payloadPart, signaturePart] = token.split(".");
  if (!payloadPart || !signaturePart) return null;
  const payloadBytes = base64ToBytes(payloadPart);
  const signatureBytes = base64ToBytes(signaturePart);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.BETTER_AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify("HMAC", keyMaterial, signatureBytes, payloadBytes);
  if (!valid) return null;
  return JSON.parse(decoder.decode(payloadBytes)) as Record<string, unknown>;
}

export async function heartbeat(env: AppEnv) {
  const db = drizzle(env.AUTH_DB);
  await db.run(sql`select 1`);
  return {
    ok: true,
    at: nowIso(),
  };
}

function bytesToBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function deriveSecretKey(secret: string, scope: string) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("g3-chat:user-secret:v1"),
      info: encoder.encode(scope),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptUserSecret(
  env: Pick<AppEnv, "USER_SECRET_ENCRYPTION_KEY">,
  scope: string,
  plaintext: string,
) {
  const key = await deriveSecretKey(env.USER_SECRET_ENCRYPTION_KEY, scope);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encoder.encode(scope),
    },
    key,
    encoder.encode(plaintext),
  );
  return {
    version: 1,
    algorithm: "AES-GCM",
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  } satisfies EncryptedSecretRecord;
}

export async function decryptUserSecret(
  env: Pick<AppEnv, "USER_SECRET_ENCRYPTION_KEY">,
  scope: string,
  record: EncryptedSecretRecord,
) {
  const key = await deriveSecretKey(env.USER_SECRET_ENCRYPTION_KEY, scope);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(record.iv),
      additionalData: encoder.encode(scope),
    },
    key,
    base64ToBytes(record.ciphertext),
  );
  return decoder.decode(plaintext);
}
