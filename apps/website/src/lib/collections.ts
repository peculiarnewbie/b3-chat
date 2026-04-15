import { createCollection, type ChangeMessageOrDeleteKeyMessage } from "@tanstack/db";
import type {
  Workspace,
  Thread,
  Message,
  MessagePart,
  Attachment,
  SearchRun,
  SearchResult,
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

const channels = new Map<string, SyncWriter<any, any>>();

export function getSyncWriter<T extends object>(
  collectionId: string,
): SyncWriter<T, string> | undefined {
  return channels.get(collectionId);
}

function createSyncedCollection<T extends object>(id: string, getKey: (item: T) => string) {
  return createCollection<T, string>({
    id,
    getKey,
    sync: {
      sync: ({ begin, write, commit, markReady, truncate }) => {
        channels.set(id, { begin, write, commit, markReady, truncate } as SyncWriter<any, any>);
        return () => channels.delete(id);
      },
    },
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

// All collections for bulk operations (sync_reset, etc.)
export const allCollections = [
  workspaces,
  threads,
  messages,
  messageParts,
  attachments,
  searchRuns,
  searchResults,
] as const;

// Map from server table names (used in SyncSnapshot) to collection ids
export const TABLE_TO_COLLECTION: Record<string, string> = {
  workspaces: "workspaces",
  threads: "threads",
  messages: "messages",
  message_parts: "messageParts",
  attachments: "attachments",
  search_runs: "searchRuns",
  search_results: "searchResults",
};
