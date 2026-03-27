import { tablesSchema, valuesSchema, type SyncMutation } from "@g3-chat/domain";
import { createMergeableStore } from "tinybase";
import { createLocalPersister } from "tinybase/persisters/persister-browser";
import { createWsSynchronizer } from "tinybase/synchronizers/synchronizer-ws-client";

class SyncClient {
  store = createMergeableStore("g3-chat-client")
    .setTablesSchema(tablesSchema)
    .setValuesSchema(valuesSchema);
  persister = createLocalPersister(this.store as any, "g3-chat.local");
  synchronizer?: Awaited<ReturnType<typeof createWsSynchronizer>>;
  connected = false;
  started = false;

  async start() {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    await this.persister.startAutoPersisting();
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/api/sync/ws`);
    this.synchronizer = await createWsSynchronizer(this.store as any, socket);
    await this.synchronizer.startSync();
    this.connected = true;
  }

  async mutate(mutation: SyncMutation) {
    const response = await fetch("/api/state/mutate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mutation),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }

  get tables() {
    return this.store.getTables();
  }

  get values() {
    return this.store.getValues();
  }
}

export const syncClient = new SyncClient();
