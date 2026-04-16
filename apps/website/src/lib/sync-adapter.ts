import {
  mergeAttachmentLink,
  SYNC_PROTOCOL_VERSION,
  type SyncEventPayloadMap,
  type SyncServerEnvelope,
} from "@b3-chat/domain";
import type { Workspace, Thread, Message, Attachment } from "@b3-chat/domain";
import * as conn from "./ws-connection";
import * as pendingOps from "./pending-ops";
import { ensureActiveSelection } from "./ui-state";
import {
  workspaces,
  threads,
  messages,
  messageParts,
  attachments,
  searchRuns,
  searchResults,
  traceRuns,
  traceSpans,
  getSyncWriter,
  resetCollections,
  TABLE_TO_COLLECTION,
} from "./collections";
import { confirmOp, rollbackOp } from "./actions";

// ---------------------------------------------------------------------------
// Delta coalescing
// ---------------------------------------------------------------------------

type EventEnvelope = Extract<SyncServerEnvelope, { type: "event" }>;

function coalesceDeltas(envelopes: EventEnvelope[]): EventEnvelope[] {
  const merged: EventEnvelope[] = [];
  for (const envelope of envelopes) {
    const previous = merged.at(-1);
    if (
      previous?.eventType === "message_delta" &&
      envelope.eventType === "message_delta" &&
      (previous.payload as SyncEventPayloadMap["message_delta"]).messageId ===
        (envelope.payload as SyncEventPayloadMap["message_delta"]).messageId
    ) {
      const prev = previous.payload as SyncEventPayloadMap["message_delta"];
      const next = envelope.payload as SyncEventPayloadMap["message_delta"];
      previous.serverSeq = envelope.serverSeq;
      previous.eventId = envelope.eventId;
      previous.causedByOpId = envelope.causedByOpId;
      previous.payload = {
        ...prev,
        delta: `${prev.delta}${next.delta}`,
        updatedAt: next.updatedAt,
      } as SyncEventPayloadMap[typeof previous.eventType];
      continue;
    }
    merged.push(envelope);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Helpers to push data through the sync writer (server-authoritative data)
// ---------------------------------------------------------------------------

function hasRow(collectionId: string, key: string) {
  switch (collectionId) {
    case "workspaces":
      return Boolean(workspaces.get(key));
    case "threads":
      return Boolean(threads.get(key));
    case "messages":
      return Boolean(messages.get(key));
    case "messageParts":
      return Boolean(messageParts.get(key));
    case "attachments":
      return Boolean(attachments.get(key));
    case "searchRuns":
      return Boolean(searchRuns.get(key));
    case "searchResults":
      return Boolean(searchResults.get(key));
    case "traceRuns":
      return Boolean(traceRuns.get(key));
    case "traceSpans":
      return Boolean(traceSpans.get(key));
    default:
      return false;
  }
}

function syncUpsert<T extends object>(collectionId: string, _key: string, value: T) {
  const writer = getSyncWriter<T>(collectionId);
  if (!writer) return;
  writer.begin();
  // Key is derived from getKey(value) by the collection; no key field for insert/update
  writer.write({ type: hasRow(collectionId, _key) ? "update" : "insert", value });
  writer.commit();
}

function syncUpdate<T extends object>(collectionId: string, _key: string, value: T) {
  const writer = getSyncWriter<T>(collectionId);
  if (!writer) return;
  writer.begin();
  writer.write({ type: "update", value });
  writer.commit();
}

function syncDelete(collectionId: string, key: string) {
  const writer = getSyncWriter(collectionId);
  if (!writer) return;
  writer.begin();
  // Delete uses key directly since there's no value to derive it from
  writer.write({ key, type: "delete" });
  writer.commit();
}

// ---------------------------------------------------------------------------
// Event handlers — server events → collection mutations
// ---------------------------------------------------------------------------

function applyEvent(eventType: string, payload: unknown) {
  switch (eventType) {
    case "workspace_upserted": {
      const event = payload as SyncEventPayloadMap["workspace_upserted"];
      syncUpsert("workspaces", event.row.id, event.row);
      break;
    }
    case "workspace_archived": {
      const event = payload as SyncEventPayloadMap["workspace_archived"];
      const existing = workspaces.get(event.id) as Workspace | undefined;
      if (existing) {
        syncUpdate("workspaces", event.id, {
          ...existing,
          archivedAt: event.archivedAt,
          updatedAt: event.updatedAt,
        });
      }
      break;
    }
    case "thread_upserted": {
      const event = payload as SyncEventPayloadMap["thread_upserted"];
      syncUpsert("threads", event.row.id, event.row);
      break;
    }
    case "thread_archived": {
      const event = payload as SyncEventPayloadMap["thread_archived"];
      const existing = threads.get(event.id) as Thread | undefined;
      if (existing) {
        syncUpdate("threads", event.id, {
          ...existing,
          archivedAt: event.archivedAt,
          updatedAt: event.updatedAt,
        });
      }
      break;
    }
    case "message_upserted": {
      const event = payload as SyncEventPayloadMap["message_upserted"];
      syncUpsert("messages", event.row.id, event.row);
      break;
    }
    case "message_delta": {
      const event = payload as SyncEventPayloadMap["message_delta"];
      const existing = messages.get(event.messageId) as Message | undefined;
      if (existing) {
        // Guard: don't regress completed → streaming
        if (existing.status === "completed") break;
        syncUpdate("messages", event.messageId, {
          ...existing,
          text: `${existing.text}${event.delta}`,
          status: "streaming",
          updatedAt: event.updatedAt,
        });
      }
      break;
    }
    case "message_completed": {
      const event = payload as SyncEventPayloadMap["message_completed"];
      const existing = messages.get(event.messageId) as Message | undefined;
      if (existing) {
        syncUpdate("messages", event.messageId, {
          ...existing,
          text: event.text,
          status: "completed",
          updatedAt: event.updatedAt,
          durationMs: event.durationMs ?? null,
          ttftMs: event.ttftMs ?? null,
          promptTokens: event.promptTokens ?? null,
          completionTokens: event.completionTokens ?? null,
        });
      }
      break;
    }
    case "message_failed": {
      const event = payload as SyncEventPayloadMap["message_failed"];
      const existing = messages.get(event.messageId) as Message | undefined;
      if (existing) {
        syncUpdate("messages", event.messageId, {
          ...existing,
          status: "failed",
          errorCode: event.errorCode,
          errorMessage: event.errorMessage,
          updatedAt: event.updatedAt,
        });
      }
      break;
    }
    case "message_part_appended": {
      const event = payload as SyncEventPayloadMap["message_part_appended"];
      syncUpsert("messageParts", event.row.id, event.row);
      break;
    }
    case "attachment_upserted": {
      const event = payload as SyncEventPayloadMap["attachment_upserted"];
      const existing = attachments.get(event.row.id) as Attachment | undefined;
      const merged = mergeAttachmentLink(existing ?? null, event.row);
      syncUpsert("attachments", event.row.id, merged);
      break;
    }
    case "attachment_deleted": {
      const event = payload as SyncEventPayloadMap["attachment_deleted"];
      syncDelete("attachments", event.id);
      break;
    }
    case "search_runs_replaced": {
      const event = payload as SyncEventPayloadMap["search_runs_replaced"];
      // Delete existing runs for this message, then insert new ones
      const srWriter = getSyncWriter("searchRuns");
      if (srWriter) {
        srWriter.begin();
        for (const [key, row] of searchRuns.state.entries()) {
          if ((row as any).messageId === event.messageId) {
            srWriter.write({ key: key as string, type: "delete" });
          }
        }
        for (const row of event.rows) {
          srWriter.write({ type: "insert", value: row });
        }
        srWriter.commit();
      }
      break;
    }
    case "search_results_replaced": {
      const event = payload as SyncEventPayloadMap["search_results_replaced"];
      const resWriter = getSyncWriter("searchResults");
      if (resWriter) {
        resWriter.begin();
        for (const [key, row] of searchResults.state.entries()) {
          if ((row as any).messageId === event.messageId) {
            resWriter.write({ key: key as string, type: "delete" });
          }
        }
        for (const row of event.rows) {
          resWriter.write({ type: "insert", value: row });
        }
        resWriter.commit();
      }
      break;
    }
    case "trace_run_upserted": {
      const event = payload as SyncEventPayloadMap["trace_run_upserted"];
      syncUpsert("traceRuns", event.row.id, event.row);
      break;
    }
    case "trace_span_upserted": {
      const event = payload as SyncEventPayloadMap["trace_span_upserted"];
      syncUpsert("traceSpans", event.row.id, event.row);
      break;
    }
    case "server_state_rebased": {
      const event = payload as SyncEventPayloadMap["server_state_rebased"];
      applySnapshot(event.snapshot.tables);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Snapshot replacement — sync_reset and server_state_rebased
// ---------------------------------------------------------------------------

function applySnapshot(tables: Record<string, Record<string, any>> | undefined) {
  if (!tables) return;
  for (const [tableName, collectionId] of Object.entries(TABLE_TO_COLLECTION)) {
    const writer = getSyncWriter(collectionId);
    if (!writer) continue;
    // Truncate and insert in one transaction
    writer.begin();
    writer.truncate();
    const rows = tables[tableName];
    if (rows) {
      for (const [_key, value] of Object.entries(rows)) {
        writer.write({ type: "insert", value });
      }
    }
    writer.commit();
    writer.markReady();
  }
}

// ---------------------------------------------------------------------------
// Envelope processor — called by ws-connection with batched envelopes
// ---------------------------------------------------------------------------

function collectWorkspacesAndThreads(): { workspaces: Workspace[]; threads: Thread[] } {
  return {
    workspaces: [...workspaces.state.values()] as Workspace[],
    threads: [...threads.state.values()] as Thread[],
  };
}

export function processEnvelopes(envelopes: SyncServerEnvelope[]) {
  let index = 0;
  let needsSelectionCheck = false;

  while (index < envelopes.length) {
    const envelope = envelopes[index]!;

    if (envelope.type === "event") {
      // Collect consecutive events, coalesce deltas, apply
      const events: EventEnvelope[] = [];
      while (envelopes[index]?.type === "event") {
        events.push(envelopes[index] as EventEnvelope);
        index += 1;
      }
      const lastSeq = events.at(-1)!.serverSeq;
      conn.setLastServerSeq(lastSeq);

      const coalesced = coalesceDeltas(events);
      for (const evt of coalesced) {
        applyEvent(evt.eventType, evt.payload);
      }
      needsSelectionCheck = true;
      continue;
    }

    switch (envelope.type) {
      case "hello_ack":
        console.log("[sync] hello_ack", {
          protocolVersion: envelope.protocolVersion,
          serverSeq: envelope.lastServerSeq,
          localSeq: conn.getLastServerSeq(),
        });
        if (envelope.protocolVersion !== SYNC_PROTOCOL_VERSION) {
          pendingOps.clear();
          resetCollections();
          conn.setLastServerSeq(0);
          window.location.reload();
          break;
        }
        if (envelope.lastServerSeq > conn.getLastServerSeq()) {
          conn.setLastServerSeq(envelope.lastServerSeq);
        }
        pendingOps.flushAll();
        break;

      case "ack":
        confirmOp(envelope.opId);
        pendingOps.resolve(envelope.opId);
        break;

      case "reject":
        rollbackOp(envelope.opId);
        pendingOps.reject(envelope.opId, envelope.reason);
        needsSelectionCheck = true;
        break;

      case "sync_reset":
        console.log(`[sync] sync_reset reason=${envelope.reason}`, {
          protocolVersion: envelope.protocolVersion,
          tables: Object.keys(envelope.snapshot.tables ?? {}),
          workspaceCount: Object.keys(envelope.snapshot.tables?.workspaces ?? {}).length,
          threadCount: Object.keys(envelope.snapshot.tables?.threads ?? {}).length,
        });
        if (envelope.reason !== "initial_sync") {
          pendingOps.clear();
        }
        applySnapshot(envelope.snapshot.tables);
        needsSelectionCheck = true;
        break;

      case "pong":
        break;
    }
    index += 1;
  }

  if (needsSelectionCheck) {
    const { workspaces: ws, threads: ts } = collectWorkspacesAndThreads();
    console.log("[sync] ensureActiveSelection", {
      workspaceCount: ws.length,
      threadCount: ts.length,
      workspaceIds: ws.map((w) => w.id),
    });
    ensureActiveSelection(ws, ts);
  }
}

// ---------------------------------------------------------------------------
// Initialization — wire up the ws-connection callback
// ---------------------------------------------------------------------------

export function init() {
  conn.setOnEnvelopes(processEnvelopes);
  // Mark all collections as ready (they start empty and get populated on sync_reset)
  for (const [, collectionId] of Object.entries(TABLE_TO_COLLECTION)) {
    const writer = getSyncWriter(collectionId);
    writer?.markReady();
  }
}
