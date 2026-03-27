import * as Schema from "effect/Schema";
import { createEffectSchematizer } from "tinybase/schematizers/schematizer-effect";

export const TABLES = {
  workspaces: "workspaces",
  threads: "threads",
  messages: "messages",
  messageParts: "message_parts",
  attachments: "attachments",
  searchResults: "search_results",
} as const;

export const VALUES = {
  activeWorkspaceId: "ui.activeWorkspaceId",
  activeThreadId: "ui.activeThreadId",
  sidebarQuery: "ui.sidebarQuery",
  schemaVersion: "meta.schemaVersion",
  lastCatalogRefreshAt: "meta.lastCatalogRefreshAt",
} as const;

const NullableString = Schema.NullOr(Schema.String);
const NullableNumber = Schema.NullOr(Schema.Number);

export const WorkspaceRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  systemPrompt: Schema.String,
  defaultModelId: Schema.String,
  defaultSearchMode: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  archivedAt: NullableString,
  sortKey: Schema.Number,
});

export const ThreadRow = Schema.Struct({
  id: Schema.String,
  workspaceId: Schema.String,
  title: Schema.String,
  pinned: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastMessageAt: Schema.String,
  archivedAt: NullableString,
});

export const MessageRow = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  role: Schema.String,
  status: Schema.String,
  modelId: Schema.String,
  text: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  errorCode: NullableString,
  errorMessage: NullableString,
  searchEnabled: Schema.Boolean,
});

export const MessagePartRow = Schema.Struct({
  id: Schema.String,
  messageId: Schema.String,
  seq: Schema.Number,
  kind: Schema.String,
  text: Schema.String,
  json: NullableString,
});

export const AttachmentRow = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  messageId: NullableString,
  objectKey: Schema.String,
  fileName: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  sha256: NullableString,
  width: NullableNumber,
  height: NullableNumber,
  status: Schema.String,
  createdAt: Schema.String,
});

export const SearchResultRow = Schema.Struct({
  id: Schema.String,
  messageId: Schema.String,
  url: Schema.String,
  title: Schema.String,
  snippet: Schema.String,
  publishedAt: NullableString,
  domain: Schema.String,
  score: Schema.Number,
});

export const tablesSchema = createEffectSchematizer().toTablesSchema({
  [TABLES.workspaces]: WorkspaceRow,
  [TABLES.threads]: ThreadRow,
  [TABLES.messages]: MessageRow,
  [TABLES.messageParts]: MessagePartRow,
  [TABLES.attachments]: AttachmentRow,
  [TABLES.searchResults]: SearchResultRow,
});

export const valuesSchema = createEffectSchematizer().toValuesSchema({
  [VALUES.activeWorkspaceId]: Schema.String,
  [VALUES.activeThreadId]: Schema.String,
  [VALUES.sidebarQuery]: Schema.String,
  [VALUES.schemaVersion]: Schema.Number,
  [VALUES.lastCatalogRefreshAt]: Schema.String,
});

export const decodeWorkspaceRow = Schema.decodeUnknownSync(WorkspaceRow);
export const decodeThreadRow = Schema.decodeUnknownSync(ThreadRow);
export const decodeMessageRow = Schema.decodeUnknownSync(MessageRow);
export const decodeMessagePartRow = Schema.decodeUnknownSync(MessagePartRow);
export const decodeAttachmentRow = Schema.decodeUnknownSync(AttachmentRow);
export const decodeSearchResultRow = Schema.decodeUnknownSync(SearchResultRow);

export type SyncMutation =
  | { type: "bootstrap"; defaultModelId: string }
  | { type: "set-value"; key: string; value: string | number | boolean | null }
  | { type: "upsert-workspace"; row: unknown }
  | { type: "upsert-thread"; row: unknown }
  | { type: "upsert-message"; row: unknown }
  | { type: "upsert-message-part"; row: unknown }
  | { type: "upsert-attachment"; row: unknown }
  | { type: "replace-search-results"; messageId: string; rows: unknown[] }
  | { type: "archive-thread"; id: string; archivedAt: string | null }
  | { type: "archive-workspace"; id: string; archivedAt: string | null }
  | { type: "delete-attachment"; id: string };

export const nowIso = () => new Date().toISOString();

export const createId = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

export function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function createWorkspace(input: {
  name: string;
  defaultModelId: string;
  systemPrompt?: string;
  defaultSearchMode?: boolean;
}) {
  const now = nowIso();
  return decodeWorkspaceRow({
    id: createId("wrk"),
    name: input.name,
    slug: slugify(input.name) || createId("space"),
    systemPrompt: input.systemPrompt ?? "",
    defaultModelId: input.defaultModelId,
    defaultSearchMode: input.defaultSearchMode ?? false,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    sortKey: Date.now(),
  });
}

export function createThread(input: { workspaceId: string; title?: string }) {
  const now = nowIso();
  return decodeThreadRow({
    id: createId("thd"),
    workspaceId: input.workspaceId,
    title: input.title ?? "New Chat",
    pinned: false,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
    archivedAt: null,
  });
}

export function createMessage(input: {
  threadId: string;
  role: "user" | "assistant" | "system";
  modelId: string;
  text?: string;
  status?: "pending" | "streaming" | "completed" | "failed";
  searchEnabled?: boolean;
}) {
  const now = nowIso();
  return decodeMessageRow({
    id: createId("msg"),
    threadId: input.threadId,
    role: input.role,
    status: input.status ?? "completed",
    modelId: input.modelId,
    text: input.text ?? "",
    createdAt: now,
    updatedAt: now,
    errorCode: null,
    errorMessage: null,
    searchEnabled: input.searchEnabled ?? false,
  });
}

export function createMessagePart(input: {
  messageId: string;
  seq: number;
  kind: string;
  text?: string;
  json?: string | null;
}) {
  return decodeMessagePartRow({
    id: createId("part"),
    messageId: input.messageId,
    seq: input.seq,
    kind: input.kind,
    text: input.text ?? "",
    json: input.json ?? null,
  });
}

export function createAttachment(input: {
  threadId: string;
  messageId?: string | null;
  objectKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256?: string | null;
}) {
  return decodeAttachmentRow({
    id: createId("att"),
    threadId: input.threadId,
    messageId: input.messageId ?? null,
    objectKey: input.objectKey,
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    sha256: input.sha256 ?? null,
    width: null,
    height: null,
    status: "pending",
    createdAt: nowIso(),
  });
}

export function buildSearchContext(rows: Array<{ title: string; url: string; snippet: string }>) {
  if (rows.length === 0) return "";
  return [
    "Use these web search results as grounding. Cite them inline by source number when relevant.",
    ...rows.map(
      (row, index) => `[${index + 1}] ${row.title}\nURL: ${row.url}\nSnippet: ${row.snippet}`,
    ),
  ].join("\n\n");
}

export function summarizeThreadTitle(text: string) {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.slice(0, 48) || "New Chat";
}
