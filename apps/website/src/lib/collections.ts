import { createCollection, type ChangeMessageOrDeleteKeyMessage } from "@tanstack/db";
import type {
  Workspace,
  Thread,
  Message,
  MessagePart,
  Attachment,
  SearchRun,
  SearchResult,
  TraceRun,
  TraceSpan,
} from "@b3-chat/domain";

// ---------------------------------------------------------------------------
// Sync channel – the push API that sync-adapter uses to feed server data
// into each collection.
// ---------------------------------------------------------------------------

export type SyncWriter<T extends object, TKey extends string | number = string> = {
  begin: (options?: { immediate?: boolean }) => void;
  write: (msg: ChangeMessageOrDeleteKeyMessage<T, TKey>) => void;
  commit: () => void;
  markReady: () => void;
  truncate: () => void;
};

export const COLLECTION_IDS = [
  "workspaces",
  "threads",
  "messages",
  "messageParts",
  "attachments",
  "searchRuns",
  "searchResults",
  "traceRuns",
  "traceSpans",
] as const;

export type CollectionId = (typeof COLLECTION_IDS)[number];

const channels = new Map<string, SyncWriter<any, any>>();

export function getSyncWriter<T extends object>(
  collectionId: string,
): SyncWriter<T, string> | undefined {
  return channels.get(collectionId);
}

function requireSyncWriter<T extends object>(collectionId: CollectionId): SyncWriter<T, string> {
  const writer = getSyncWriter<T>(collectionId);
  if (!writer) {
    throw new Error(`Sync writer not ready for collection "${collectionId}"`);
  }
  return writer;
}

function commitImmediateWrite<T extends object>(
  collectionId: CollectionId,
  message: ChangeMessageOrDeleteKeyMessage<T, string>,
) {
  const writer = requireSyncWriter<T>(collectionId);
  writer.begin({ immediate: true });
  writer.write(message);
  writer.commit();
}

function createSyncedCollection<T extends object>(id: string, getKey: (item: T) => string) {
  return createCollection<T, string>({
    id,
    getKey,
    startSync: true,
    utils: {},
    sync: {
      sync: ({ begin, write, commit, markReady, truncate }) => {
        channels.set(id, { begin, write, commit, markReady, truncate } as SyncWriter<any, any>);
        return () => channels.delete(id);
      },
    },
    // Mutation handlers for optimistic updates (actual persistence goes through WS dispatch)
    onInsert: () => Promise.resolve(),
    onUpdate: () => Promise.resolve(),
    onDelete: () => Promise.resolve(),
  });
}

// ---------------------------------------------------------------------------
// Collection definitions
// ---------------------------------------------------------------------------

export const workspaces = createSyncedCollection<Workspace>("workspaces", (w) => w.id);
export const threads = createSyncedCollection<Thread>("threads", (t) => t.id);
export const messages = createSyncedCollection<Message>("messages", (m) => m.id);
export const messageParts = createSyncedCollection<MessagePart>("messageParts", (mp) => mp.id);
export const attachments = createSyncedCollection<Attachment>("attachments", (a) => a.id);
export const searchRuns = createSyncedCollection<SearchRun>("searchRuns", (sr) => sr.id);
export const searchResults = createSyncedCollection<SearchResult>("searchResults", (sr) => sr.id);
export const traceRuns = createSyncedCollection<TraceRun>("traceRuns", (run) => run.id);
export const traceSpans = createSyncedCollection<TraceSpan>("traceSpans", (span) => span.id);

export function applyLocalInsert<T extends object>(collectionId: CollectionId, value: T) {
  commitImmediateWrite(collectionId, { type: "insert", value });
}

export function applyLocalUpdate<T extends object>(collectionId: CollectionId, value: T) {
  commitImmediateWrite(collectionId, { type: "update", value });
}

export function applyLocalDelete(collectionId: CollectionId, key: string) {
  commitImmediateWrite(collectionId, { key, type: "delete" });
}

export function resetCollections(collectionIds: readonly CollectionId[] = COLLECTION_IDS) {
  for (const collectionId of collectionIds) {
    const writer = getSyncWriter(collectionId);
    if (!writer) continue;
    writer.begin({ immediate: true });
    writer.truncate();
    writer.commit();
    writer.markReady();
  }
}

// Map from server table names (used in SyncSnapshot) to collection ids
export const TABLE_TO_COLLECTION: Record<string, string> = {
  workspaces: "workspaces",
  threads: "threads",
  messages: "messages",
  message_parts: "messageParts",
  attachments: "attachments",
  search_runs: "searchRuns",
  search_results: "searchResults",
  trace_runs: "traceRuns",
  trace_spans: "traceSpans",
};
