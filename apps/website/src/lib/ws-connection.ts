import { SYNC_PROTOCOL_VERSION, createId, type SyncServerEnvelope } from "@b3-chat/domain";
import * as pendingOps from "./pending-ops";
import { createClientLogger, serializeError } from "./debug-log";

// ---------------------------------------------------------------------------
// Persistent client identity & sync cursor
// ---------------------------------------------------------------------------

const CLIENT_ID_KEY = "b3.clientId";
const logger = createClientLogger("ws-connection");

function readJson<T>(key: string, fallback: T): T {
  if (typeof localStorage === "undefined") return fallback;
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const clientId = readJson(CLIENT_ID_KEY, createId("client"));
if (typeof localStorage !== "undefined") {
  localStorage.setItem(CLIENT_ID_KEY, JSON.stringify(clientId));
}
logger.log("hydrate_client_id", { clientId });

let lastServerSeq = 0;

export function getLastServerSeq() {
  return lastServerSeq;
}

export function setLastServerSeq(seq: number) {
  logger.log("set_last_server_seq", {
    previous: lastServerSeq,
    next: seq,
  });
  lastServerSeq = seq;
}

// ---------------------------------------------------------------------------
// Envelope callback — set by sync-adapter
// ---------------------------------------------------------------------------

let onEnvelopes: ((envelopes: SyncServerEnvelope[]) => void) | null = null;

export function setOnEnvelopes(fn: (envelopes: SyncServerEnvelope[]) => void) {
  onEnvelopes = fn;
  logger.log("set_on_envelopes");
}

// ---------------------------------------------------------------------------
// Envelope batching (RAF)
// ---------------------------------------------------------------------------

let incomingQueue: SyncServerEnvelope[] = [];
let flushScheduled = false;

function enqueueEnvelope(envelope: SyncServerEnvelope) {
  incomingQueue.push(envelope);
  logger.log("enqueue_envelope", {
    queueSize: incomingQueue.length,
    type: envelope.type,
    eventType: envelope.type === "event" ? envelope.eventType : undefined,
    opId: "opId" in envelope ? envelope.opId : undefined,
    serverSeq: "serverSeq" in envelope ? envelope.serverSeq : undefined,
  });
  if (flushScheduled) return;
  flushScheduled = true;

  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(flush);
    return;
  }
  queueMicrotask(flush);
}

function flush() {
  flushScheduled = false;
  if (incomingQueue.length === 0) return;
  const batch = incomingQueue.splice(0);
  logger.log("flush_batch", {
    batchSize: batch.length,
    types: batch.map((envelope) =>
      envelope.type === "event" ? `${envelope.type}:${envelope.eventType}` : envelope.type,
    ),
  });
  onEnvelopes?.(batch);

  // If more envelopes arrived during processing, schedule again
  if (incomingQueue.length > 0 && !flushScheduled) {
    flushScheduled = true;
    queueMicrotask(flush);
  }
}

// ---------------------------------------------------------------------------
// WebSocket lifecycle
// ---------------------------------------------------------------------------

let socket: WebSocket | undefined;
let reconnectAttempt = 0;
let reconnectTimer: number | undefined;
let started = false;

function syncLog(message: string, details?: Record<string, unknown>) {
  if (details) {
    console.log(`[ws] ${message}`, details);
    return;
  }
  console.log(`[ws] ${message}`);
}

function send(message: object) {
  if (socket?.readyState === WebSocket.OPEN) {
    logger.log("send", {
      readyState: socket.readyState,
      type: (message as { type?: string }).type ?? null,
      opId: (message as { opId?: string }).opId ?? null,
    });
    socket.send(JSON.stringify(message));
    return;
  }
  logger.warn("send_skipped_socket_not_open", {
    readyState: socket?.readyState ?? null,
    type: (message as { type?: string }).type ?? null,
    opId: (message as { opId?: string }).opId ?? null,
  });
}

function connect() {
  if (typeof window === "undefined") return;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  syncLog("connect", { clientId, lastServerSeq });
  logger.log("connect", {
    clientId,
    lastServerSeq,
    reconnectAttempt,
    url: `${protocol}//${location.host}/api/sync/ws`,
  });
  const ws = new WebSocket(`${protocol}//${location.host}/api/sync/ws`);
  socket = ws;

  ws.addEventListener("open", () => {
    reconnectAttempt = 0;
    syncLog("open", { pendingOps: pendingOps.unackedOpIds().length });
    logger.log("open", {
      pendingCount: pendingOps.unackedOpIds().length,
      readyState: ws.readyState,
    });
    send({
      type: "hello",
      clientId,
      protocolVersion: SYNC_PROTOCOL_VERSION,
      lastServerSeq,
      unackedOpIds: pendingOps.unackedOpIds(),
    });
  });

  ws.addEventListener("message", ({ data }) => {
    const envelope = JSON.parse(String(data)) as SyncServerEnvelope;
    logger.log("message", {
      type: envelope.type,
      eventType: envelope.type === "event" ? envelope.eventType : undefined,
      opId: "opId" in envelope ? envelope.opId : undefined,
      serverSeq: "serverSeq" in envelope ? envelope.serverSeq : undefined,
      reason: "reason" in envelope ? envelope.reason : undefined,
    });
    enqueueEnvelope(envelope);
  });

  ws.addEventListener("close", (event) => {
    syncLog("close");
    logger.warn("close", {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
      readyState: ws.readyState,
    });
    scheduleReconnect();
  });

  ws.addEventListener("error", (event) => {
    syncLog("error");
    logger.error("error", {
      readyState: ws.readyState,
      ...serializeError(event),
    });
  });
}

function scheduleReconnect() {
  if (typeof window === "undefined") return;
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  const delay = Math.min(10_000, 500 * 2 ** reconnectAttempt++);
  logger.warn("schedule_reconnect", {
    delay,
    reconnectAttempt,
    hasSocket: Boolean(socket),
    readyState: socket?.readyState ?? null,
  });
  reconnectTimer = window.setTimeout(() => connect(), delay);
}

/** Called once from UI onMount. */
export function start() {
  if (started || typeof window === "undefined") {
    logger.warn("start_skipped", {
      started,
      hasWindow: typeof window !== "undefined",
    });
    return;
  }
  started = true;
  logger.log("start", {
    clientId,
    lastServerSeq,
  });
  pendingOps.setSendFn(send);
  connect();
}
