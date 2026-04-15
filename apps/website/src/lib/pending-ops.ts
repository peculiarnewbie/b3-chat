import {
  createId,
  nowIso,
  type PendingSyncOp,
  type SyncClientCommand,
  type SyncCommandPayloadMap,
  type SyncCommandType,
} from "@b3-chat/domain";

const PENDING_OPS_KEY = "b3.pendingOps";

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

type TrackedOp = PendingSyncOp & {
  resolve: () => void;
  reject: (reason: string) => void;
};

const ops = new Map<string, TrackedOp>(
  Object.entries(readJson<Record<string, PendingSyncOp>>(PENDING_OPS_KEY, {})).map(([key, op]) => [
    key,
    { ...op, resolve: () => {}, reject: () => {} },
  ]),
);

function persist() {
  if (typeof localStorage === "undefined") return;
  const plain: Record<string, PendingSyncOp> = {};
  for (const [key, op] of ops) {
    plain[key] = {
      opId: op.opId,
      clientTs: op.clientTs,
      commandType: op.commandType,
      payload: op.payload,
    };
  }
  localStorage.setItem(PENDING_OPS_KEY, JSON.stringify(plain));
}

/** Send function, set by ws-connection after init. */
let sendFn: ((msg: object) => void) | null = null;

export function setSendFn(fn: (msg: object) => void) {
  sendFn = fn;
}

function sendOp(op: PendingSyncOp) {
  if (!sendFn) return;
  sendFn({
    type: "command",
    opId: op.opId,
    clientTs: op.clientTs,
    commandType: op.commandType,
    payload: op.payload,
  } satisfies SyncClientCommand);
}

/**
 * Dispatch a command to the server. Returns a promise that resolves on ack,
 * rejects on reject. The optimistic mutations should be applied before calling this.
 */
export function dispatch<T extends SyncCommandType>(
  commandType: T,
  payload: SyncCommandPayloadMap[T],
  options?: { opId?: string },
): { opId: string; promise: Promise<void> } {
  const opId = options?.opId ?? createId("op");
  const op: PendingSyncOp = {
    opId,
    clientTs: nowIso(),
    commandType,
    payload,
  };
  let resolve: () => void;
  let reject: (reason: string) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = (reason: string) => rej(new Error(reason));
  });
  ops.set(opId, { ...op, resolve: resolve!, reject: reject! });
  persist();
  sendOp(op);
  return { opId, promise };
}

/** Called by sync-adapter when server acknowledges an op. */
export function resolve(opId: string) {
  const op = ops.get(opId);
  if (!op) return;
  op.resolve();
  ops.delete(opId);
  persist();
}

/** Called by sync-adapter when server rejects an op. Returns the opId for rollback. */
export function reject(opId: string, reason: string) {
  const op = ops.get(opId);
  if (!op) return;
  op.reject(reason);
  ops.delete(opId);
  persist();
}

/** Re-send all pending ops after reconnect handshake. */
export function flushAll() {
  for (const op of ops.values()) {
    sendOp(op);
  }
}

/** Clear all pending ops (on non-initial sync_reset). */
export function clear() {
  for (const op of ops.values()) {
    op.reject("sync_reset");
  }
  ops.clear();
  persist();
}

/** Test helper: drop pending ops without rejecting in-flight promises. */
export function resetPendingOps() {
  ops.clear();
  persist();
}

/** Get all unacked opIds for the hello handshake. */
export function unackedOpIds(): string[] {
  return [...ops.keys()];
}
