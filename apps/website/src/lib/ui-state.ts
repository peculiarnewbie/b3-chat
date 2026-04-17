import { createSignal } from "solid-js";
import type { Workspace, Thread } from "@b3-chat/domain";
import { createClientLogger } from "./debug-log";

// ---------------------------------------------------------------------------
// Persisted signals
// ---------------------------------------------------------------------------

function readString(key: string, fallback: string): string {
  if (typeof localStorage === "undefined") return fallback;
  return localStorage.getItem(key) ?? fallback;
}

const logger = createClientLogger("ui-state");

function createPersistedSignal(key: string, fallback = "") {
  const [value, rawSet] = createSignal(readString(key, fallback));
  logger.log("hydrate_signal", {
    key,
    value: value(),
  });
  const set = (next: string) => {
    const previous = value();
    rawSet(next);
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, next);
    }
    logger.log("set_signal", {
      key,
      previous,
      next,
    });
  };
  return [value, set] as const;
}

export const [activeWorkspaceId, setActiveWorkspaceId] =
  createPersistedSignal("b3.activeWorkspaceId");
export const [activeThreadId, setActiveThreadId] = createPersistedSignal("b3.activeThreadId");

// ---------------------------------------------------------------------------
// Selection validation
// ---------------------------------------------------------------------------

/**
 * Ensures the active workspace and thread selections are still valid.
 * Call after any event batch that may archive or delete workspaces/threads.
 */
export function ensureActiveSelection(workspaces: Workspace[], threads: Thread[]) {
  const currentWorkspaceId = activeWorkspaceId();
  const validWorkspaces = workspaces.filter((w) => !w.archivedAt);
  const nextWorkspace =
    validWorkspaces.find((w) => w.id === currentWorkspaceId) ?? validWorkspaces[0];

  if (nextWorkspace && currentWorkspaceId !== nextWorkspace.id) {
    setActiveWorkspaceId(nextWorkspace.id);
  }

  const selectedWorkspaceId = nextWorkspace?.id ?? currentWorkspaceId;
  const validThreads = threads.filter(
    (t) => t.workspaceId === selectedWorkspaceId && !t.archivedAt,
  );
  const currentThreadId = activeThreadId();
  const nextThread = validThreads.find((t) => t.id === currentThreadId) ?? validThreads[0];

  logger.log("ensure_active_selection", {
    currentWorkspaceId,
    nextWorkspaceId: nextWorkspace?.id ?? null,
    currentThreadId,
    nextThreadId: nextThread?.id ?? null,
    workspaceIds: validWorkspaces.map((workspace) => workspace.id),
    threadIds: validThreads.map((thread) => thread.id),
  });

  if (nextThread && currentThreadId !== nextThread.id) {
    setActiveThreadId(nextThread.id);
  }
}
