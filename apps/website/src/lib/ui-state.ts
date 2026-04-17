import { createSignal } from "solid-js";
import type { Workspace, Thread } from "@b3-chat/domain";

// ---------------------------------------------------------------------------
// Persisted signals
// ---------------------------------------------------------------------------

function readString(key: string, fallback: string): string {
  if (typeof localStorage === "undefined") return fallback;
  return localStorage.getItem(key) ?? fallback;
}

function createPersistedSignal(key: string, fallback = "") {
  const [value, rawSet] = createSignal(readString(key, fallback));
  const set = (next: string) => {
    rawSet(next);
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, next);
    }
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

  if (nextThread && currentThreadId !== nextThread.id) {
    setActiveThreadId(nextThread.id);
  }
}
