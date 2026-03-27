import {
  createThread,
  createWorkspace,
  decodeAttachmentRow,
  decodeMessagePartRow,
  decodeMessageRow,
  decodeSearchResultRow,
  decodeThreadRow,
  decodeWorkspaceRow,
  nowIso,
  TABLES,
  VALUES,
  tablesSchema,
  valuesSchema,
  type SyncMutation,
} from "@g3-chat/domain";
import type { AppEnv } from "@g3-chat/server";
import { createMergeableStore } from "tinybase";
import { createDurableObjectSqlStoragePersister } from "tinybase/persisters/persister-durable-object-sql-storage";
import { WsServerDurableObject } from "tinybase/synchronizers/synchronizer-ws-server-durable-object";

type Snapshot = {
  tables: ReturnType<SyncEngineDurableObject["store"]["getTables"]>;
  values: ReturnType<SyncEngineDurableObject["store"]["getValues"]>;
};

export class SyncEngineDurableObject extends WsServerDurableObject<AppEnv> {
  store = createMergeableStore("g3-chat-sync")
    .setTablesSchema(tablesSchema)
    .setValuesSchema(valuesSchema);

  createPersister() {
    return createDurableObjectSqlStoragePersister(this.store as any, this.ctx.storage.sql, {
      mode: "fragmented",
      storagePrefix: "g3_chat_",
    });
  }

  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/snapshot") {
      this.ensureDefaults();
      return Response.json(this.snapshot());
    }

    if (url.pathname === "/mutate" && request.method === "POST") {
      const mutation = (await request.json()) as SyncMutation;
      this.applyMutation(mutation);
      return Response.json(this.snapshot());
    }

    const baseFetch = Object.getPrototypeOf(SyncEngineDurableObject.prototype).fetch as (
      this: SyncEngineDurableObject,
      request: Request,
    ) => Response;
    return baseFetch.call(this, request);
  }

  private snapshot(): Snapshot {
    return {
      tables: this.store.getTables(),
      values: this.store.getValues(),
    };
  }

  private ensureDefaults() {
    if (this.store.hasValue(VALUES.schemaVersion)) return;
    this.store.transaction(() => {
      this.store.setValue(VALUES.schemaVersion, 1);
      this.store.setValue(VALUES.sidebarQuery, "");
      this.store.setValue(VALUES.lastCatalogRefreshAt, nowIso());
    });
  }

  private applyMutation(mutation: SyncMutation) {
    this.ensureDefaults();
    this.store.transaction(() => {
      switch (mutation.type) {
        case "bootstrap": {
          this.store.setValue(VALUES.schemaVersion, 1);
          this.store.setValue(VALUES.sidebarQuery, "");
          this.store.setValue(VALUES.lastCatalogRefreshAt, nowIso());
          if (this.store.getTable(TABLES.workspaces)) return;
          const workspace = createWorkspace({
            name: "Default Workspace",
            defaultModelId: mutation.defaultModelId,
          });
          const thread = createThread({
            workspaceId: workspace.id,
            title: "New Chat",
          });
          this.store.setRow(TABLES.workspaces, workspace.id, workspace);
          this.store.setRow(TABLES.threads, thread.id, thread);
          this.store.setValue(VALUES.activeWorkspaceId, workspace.id);
          this.store.setValue(VALUES.activeThreadId, thread.id);
          return;
        }
        case "set-value":
          this.store.setValue(mutation.key, mutation.value as any);
          return;
        case "upsert-workspace": {
          const row = decodeWorkspaceRow(mutation.row);
          this.store.setRow(TABLES.workspaces, row.id, row as any);
          return;
        }
        case "upsert-thread": {
          const row = decodeThreadRow(mutation.row);
          this.store.setRow(TABLES.threads, row.id, row as any);
          return;
        }
        case "upsert-message": {
          const row = decodeMessageRow(mutation.row);
          this.store.setRow(TABLES.messages, row.id, row as any);
          const thread = this.store.getRow(TABLES.threads, row.threadId) as
            | Record<string, unknown>
            | undefined;
          if (thread) {
            this.store.setRow(TABLES.threads, row.threadId, {
              ...thread,
              updatedAt: row.updatedAt,
              lastMessageAt: row.updatedAt,
            });
          }
          return;
        }
        case "upsert-message-part": {
          const row = decodeMessagePartRow(mutation.row);
          this.store.setRow(TABLES.messageParts, row.id, row as any);
          return;
        }
        case "upsert-attachment": {
          const row = decodeAttachmentRow(mutation.row);
          this.store.setRow(TABLES.attachments, row.id, row as any);
          return;
        }
        case "replace-search-results": {
          for (const existingId of this.store.getRowIds(TABLES.searchResults)) {
            const row = this.store.getRow(TABLES.searchResults, existingId) as Record<
              string,
              unknown
            >;
            if (row.messageId === mutation.messageId) {
              this.store.delRow(TABLES.searchResults, existingId);
            }
          }
          for (const raw of mutation.rows) {
            const row = decodeSearchResultRow(raw);
            this.store.setRow(TABLES.searchResults, row.id, row as any);
          }
          return;
        }
        case "archive-thread":
          this.store.setPartialRow(TABLES.threads, mutation.id, {
            archivedAt: mutation.archivedAt,
            updatedAt: nowIso(),
          });
          return;
        case "archive-workspace":
          this.store.setPartialRow(TABLES.workspaces, mutation.id, {
            archivedAt: mutation.archivedAt,
            updatedAt: nowIso(),
          });
          return;
        case "delete-attachment":
          this.store.delRow(TABLES.attachments, mutation.id);
          return;
        default:
          return;
      }
    });
  }
}
