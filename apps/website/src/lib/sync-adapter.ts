import {
  mergeAttachmentLink,
  SYNC_PROTOCOL_VERSION,
  type SyncEventPayloadMap,
  type SyncServerEnvelope,
} from "@b3-chat/domain";
import type { Workspace, Thread, Message, Attachment } from "@b3-chat/domain";
import * as conn from "./ws-connection";
import * as pendingOps from "./pending-ops";
import { activeThreadId, activeWorkspaceId, ensureActiveSelection } from "./ui-state";
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
import { reconcileDraftState } from "./draft-state";
import { confirmOp, rollbackOp } from "./actions";
import { createClientLogger } from "./debug-log";

// ---------------------------------------------------------------------------
// Delta coalescing
// ---------------------------------------------------------------------------

type EventEnvelope = Extract<SyncServerEnvelope, { type: "event" }>;
const logger = createClientLogger("sync-adapter");

function summarizeEvent(envelope: EventEnvelope) {
  const payload = envelope.payload as Record<string, unknown>;
  return {
    serverSeq: envelope.serverSeq,
    eventId: envelope.eventId,
    eventType: envelope.eventType,
    causedByOpId: envelope.causedByOpId ?? null,
    rowId:
      payload.row && typeof payload.row === "object" && "id" in payload.row
        ? ((payload.row as { id?: string }).id ?? null)
        : null,
    messageId:
      (typeof payload.messageId === "string" && payload.messageId) ||
      (typeof payload.id === "string" && payload.id) ||
      null,
  };
}

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
  const baseDetails = {
    eventType,
    payloadKeys: payload && typeof payload === "object" ? Object.keys(payload as object) : [],
  };
  switch (eventType) {
    case "workspace_upserted": {
      const event = payload as SyncEventPayloadMap["workspace_upserted"];
      logger.log("apply_event", {
        ...baseDetails,
        workspaceId: event.row.id,
        updatedAt: event.row.updatedAt,
      });
      syncUpsert("workspaces", event.row.id, event.row);
      break;
    }
    case "workspace_archived": {
      const event = payload as SyncEventPayloadMap["workspace_archived"];
      logger.log("apply_event", {
        ...baseDetails,
        workspaceId: event.id,
        archivedAt: event.archivedAt,
      });
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
      logger.log("apply_event", {
        ...baseDetails,
        threadId: event.row.id,
        workspaceId: event.row.workspaceId,
        headMessageId: event.row.headMessageId ?? null,
      });
      syncUpsert("threads", event.row.id, event.row);
      break;
    }
    case "thread_archived": {
      const event = payload as SyncEventPayloadMap["thread_archived"];
      logger.log("apply_event", {
        ...baseDetails,
        threadId: event.id,
        archivedAt: event.archivedAt,
      });
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
      logger.log("apply_event", {
        ...baseDetails,
        messageId: event.row.id,
        threadId: event.row.threadId,
        role: event.row.role,
        status: event.row.status,
      });
      syncUpsert("messages", event.row.id, event.row);
      break;
    }
    case "message_delta": {
      const event = payload as SyncEventPayloadMap["message_delta"];
      logger.log("apply_event", {
        ...baseDetails,
        messageId: event.messageId,
        deltaLength: event.delta.length,
      });
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
      logger.log("apply_event", {
        ...baseDetails,
        messageId: event.messageId,
        textLength: event.text.length,
        durationMs: event.durationMs ?? null,
        ttftMs: event.ttftMs ?? null,
      });
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
      logger.warn("apply_event", {
        ...baseDetails,
        messageId: event.messageId,
        errorCode: event.errorCode,
        errorMessage: event.errorMessage,
      });
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
      logger.log("apply_event", {
        ...baseDetails,
        partId: event.row.id,
        messageId: event.row.messageId,
        seq: event.row.seq,
        kind: event.row.kind,
        textLength: event.row.text.length,
      });
      syncUpsert("messageParts", event.row.id, event.row);
      break;
    }
    case "attachment_upserted": {
      const event = payload as SyncEventPayloadMap["attachment_upserted"];
      logger.log("apply_event", {
        ...baseDetails,
        attachmentId: event.row.id,
        threadId: event.row.threadId,
        messageId: event.row.messageId ?? null,
        status: event.row.status,
      });
      const existing = attachments.get(event.row.id) as Attachment | undefined;
      const merged = mergeAttachmentLink(existing ?? null, event.row);
      syncUpsert("attachments", event.row.id, merged);
      break;
    }
    case "attachment_deleted": {
      const event = payload as SyncEventPayloadMap["attachment_deleted"];
      logger.log("apply_event", {
        ...baseDetails,
        attachmentId: event.id,
      });
      syncDelete("attachments", event.id);
      break;
    }
    case "search_runs_replaced": {
      const event = payload as SyncEventPayloadMap["search_runs_replaced"];
      logger.log("apply_event", {
        ...baseDetails,
        messageId: event.messageId,
        runCount: event.rows.length,
      });
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
      logger.log("apply_event", {
        ...baseDetails,
        messageId: event.messageId,
        resultCount: event.rows.length,
      });
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
      logger.log("apply_event", {
        ...baseDetails,
        traceRunId: event.row.id,
        messageId: event.row.messageId ?? null,
        status: event.row.status,
      });
      syncUpsert("traceRuns", event.row.id, event.row);
      break;
    }
    case "trace_span_upserted": {
      const event = payload as SyncEventPayloadMap["trace_span_upserted"];
      logger.log("apply_event", {
        ...baseDetails,
        traceSpanId: event.row.id,
        traceRunId: event.row.traceRunId ?? null,
        messageId: event.row.messageId ?? null,
        status: event.row.status,
      });
      syncUpsert("traceSpans", event.row.id, event.row);
      break;
    }
    case "server_state_rebased": {
      const event = payload as SyncEventPayloadMap["server_state_rebased"];
      logger.warn("apply_event", {
        ...baseDetails,
        tableNames: Object.keys(event.snapshot.tables ?? {}),
      });
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
  logger.warn("apply_snapshot", {
    tableNames: Object.keys(tables),
    counts: Object.fromEntries(
      Object.entries(tables).map(([tableName, rows]) => [
        tableName,
        Object.keys(rows ?? {}).length,
      ]),
    ),
  });
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
  logger.log("process_envelopes_start", {
    count: envelopes.length,
    types: envelopes.map((envelope) =>
      envelope.type === "event" ? `${envelope.type}:${envelope.eventType}` : envelope.type,
    ),
  });

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
      logger.log("apply_event_batch", {
        eventCount: events.length,
        coalescedCount: coalesced.length,
        lastSeq,
        events: coalesced.map(summarizeEvent),
      });
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
        logger.log("hello_ack", {
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
        logger.log("ack", {
          opId: envelope.opId,
          commandType: envelope.commandType,
          serverSeq: envelope.serverSeq,
        });
        confirmOp(envelope.opId);
        pendingOps.resolve(envelope.opId);
        break;

      case "reject":
        logger.warn("reject", {
          opId: envelope.opId,
          reason: envelope.reason,
        });
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
        logger.warn("sync_reset", {
          reason: envelope.reason,
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
        logger.log("pong", {
          at: envelope.at,
        });
        break;
    }
    index += 1;
  }

  if (needsSelectionCheck) {
    const { workspaces: ws, threads: ts } = collectWorkspacesAndThreads();
    reconcileDraftState(ws, ts);
    console.log("[sync] ensureActiveSelection", {
      workspaceCount: ws.length,
      threadCount: ts.length,
      workspaceIds: ws.map((w) => w.id),
    });
    logger.log("ensure_active_selection", {
      workspaceCount: ws.length,
      threadCount: ts.length,
      workspaceIds: ws.map((w) => w.id),
      threadIds: ts.map((thread) => thread.id),
      currentWorkspaceId: ws.find((w) => w.id === activeWorkspaceId())?.id ?? activeWorkspaceId(),
      currentThreadId: activeThreadId(),
    });
    ensureActiveSelection(ws, ts);
  }
}

// ---------------------------------------------------------------------------
// Initialization — wire up the ws-connection callback
// ---------------------------------------------------------------------------

export function init() {
  conn.setOnEnvelopes(processEnvelopes);
  logger.log("init");
  // Mark all collections as ready (they start empty and get populated on sync_reset)
  for (const [, collectionId] of Object.entries(TABLE_TO_COLLECTION)) {
    const writer = getSyncWriter(collectionId);
    writer?.markReady();
    logger.log("mark_collection_ready", { collectionId });
  }
}
