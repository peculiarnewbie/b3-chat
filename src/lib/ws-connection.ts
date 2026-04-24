import { SYNC_PROTOCOL_VERSION, createId, type SyncServerEnvelope } from "@b3-chat/domain";
import { createSignal } from "solid-js";
import * as pendingOps from "./pending-ops";

// ---------------------------------------------------------------------------
// Persistent client identity & sync cursor
// ---------------------------------------------------------------------------

const CLIENT_ID_KEY = "b3.clientId";
const LAST_SERVER_SEQ_KEY = "b3.lastServerSeq";

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

let lastServerSeq = readJson<number>(LAST_SERVER_SEQ_KEY, 0);

export function getLastServerSeq() {
  return lastServerSeq;
}

export function setLastServerSeq(seq: number) {
  lastServerSeq = seq;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(LAST_SERVER_SEQ_KEY, JSON.stringify(seq));
  }
}

// ---------------------------------------------------------------------------
// Envelope callback — set by sync-adapter
// ---------------------------------------------------------------------------

let onEnvelopes: ((envelopes: SyncServerEnvelope[]) => void) | null = null;

export function setOnEnvelopes(fn: (envelopes: SyncServerEnvelope[]) => void) {
  onEnvelopes = fn;
}

// ---------------------------------------------------------------------------
// Envelope batching (RAF)
// ---------------------------------------------------------------------------

let incomingQueue: SyncServerEnvelope[] = [];
let flushScheduled = false;

function enqueueEnvelope(envelope: SyncServerEnvelope) {
  incomingQueue.push(envelope);
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

const [isConnected, setIsConnected] = createSignal(false);
export { isConnected };

function syncLog(message: string, details?: Record<string, unknown>) {
  if (details) {
    console.log(`[ws] ${message}`, details);
    return;
  }
  console.log(`[ws] ${message}`);
}

function send(message: object) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function connect() {
  if (typeof window === "undefined") return;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  syncLog("connect", { clientId, lastServerSeq });
  const ws = new WebSocket(`${protocol}//${location.host}/api/sync/ws`);
  socket = ws;

  ws.addEventListener("open", () => {
    reconnectAttempt = 0;
    setIsConnected(true);
    syncLog("open", { pendingOps: pendingOps.unackedOpIds().length });
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
    enqueueEnvelope(envelope);
  });

  ws.addEventListener("close", () => {
    syncLog("close");
    setIsConnected(false);
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    syncLog("error");
    setIsConnected(false);
  });
}

function scheduleReconnect() {
  if (typeof window === "undefined") return;
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  const delay = Math.min(10_000, 500 * 2 ** reconnectAttempt++);
  reconnectTimer = window.setTimeout(() => connect(), delay);
}

/** Called once from UI onMount. */
export function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  pendingOps.setSendFn(send);
  connect();
}
