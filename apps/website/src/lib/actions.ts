import {
  createId,
  createMessage,
  createThread,
  createWorkspace,
  nowIso,
  summarizeThreadTitle,
  toWire,
  type Attachment,
  type Thread,
  type CreateUserMessagePayload,
} from "@b3-chat/domain";
import { dispatch } from "./pending-ops";
import { workspaces, threads, messages, attachments } from "./collections";
import { setActiveWorkspaceId, setActiveThreadId, ensureActiveSelection } from "./ui-state";

// ---------------------------------------------------------------------------
// Optimistic rollback tracking
// ---------------------------------------------------------------------------

type OptimisticEntry = {
  rollback: () => void;
};

type CollectionWithRows = {
  delete: (keys: string | string[]) => unknown;
  get: (key: string) => any;
  insert: (value: any) => unknown;
  update: (key: string, updater: (draft: any) => void) => unknown;
};

const optimisticByOp = new Map<string, OptimisticEntry[]>();

function trackOptimistic(opId: string, entries: OptimisticEntry[]) {
  optimisticByOp.set(opId, entries);
}

function deleteRow(collection: Pick<CollectionWithRows, "delete">, key: string): OptimisticEntry {
  return {
    rollback: () => {
      collection.delete(key);
    },
  };
}

function restoreRow<T extends { id: string }>(
  collection: CollectionWithRows,
  row: T,
): OptimisticEntry {
  const snapshot = { ...row };
  return {
    rollback: () => {
      const existing = collection.get(snapshot.id);
      if (existing) {
        collection.update(snapshot.id, (draft) => {
          Object.assign(draft, snapshot);
        });
        return;
      }
      collection.insert(snapshot);
    },
  };
}

/**
 * Called by sync-adapter on reject — removes optimistic rows.
 */
export function rollbackOp(opId: string) {
  const entries = optimisticByOp.get(opId);
  if (!entries) return;
  for (const entry of entries) {
    try {
      entry.rollback();
    } catch {
      // The row may already have been replaced by server data.
    }
  }
  optimisticByOp.delete(opId);
  // Re-validate selection
  ensureActiveSelection([...workspaces.state.values()], [...threads.state.values()]);
}

/** Clean up tracking when server ack confirms the optimistic data. */
export function confirmOp(opId: string) {
  optimisticByOp.delete(opId);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export function createWorkspaceAction(
  name: string,
  input: { defaultModelId: string; defaultSearchMode?: boolean },
) {
  const opId = createId("op");
  const workspace = createWorkspace({
    name,
    defaultModelId: input.defaultModelId,
    defaultSearchMode: input.defaultSearchMode,
  });
  const initialThread = createThread({ workspaceId: workspace.id });

  // Optimistic
  workspaces.insert(workspace);
  threads.insert(initialThread);
  setActiveWorkspaceId(workspace.id);
  setActiveThreadId(initialThread.id);
  trackOptimistic(opId, [
    deleteRow(workspaces, workspace.id),
    deleteRow(threads, initialThread.id),
  ]);

  dispatch(
    "create_workspace",
    {
      workspace: toWire(workspace, opId),
      initialThread: toWire(initialThread, opId),
    },
    { opId },
  );
}

export function createThreadAction(workspaceId: string) {
  const opId = createId("op");
  const thread = createThread({ workspaceId });

  threads.insert(thread);
  setActiveThreadId(thread.id);
  trackOptimistic(opId, [deleteRow(threads, thread.id)]);

  dispatch("create_thread", { thread: toWire(thread, opId) }, { opId });
}

export function archiveThreadAction(threadId: string) {
  const existing = threads.get(threadId);
  if (!existing) return;

  threads.update(threadId, (draft) => {
    draft.archivedAt = nowIso();
    draft.updatedAt = nowIso();
  });

  dispatch("archive_thread", { id: threadId, archivedAt: nowIso() });

  // Re-validate selection
  ensureActiveSelection([...workspaces.state.values()], [...threads.state.values()]);
}

export function archiveWorkspaceAction(workspaceId: string) {
  const existing = workspaces.get(workspaceId);
  if (!existing) return;

  workspaces.update(workspaceId, (draft) => {
    draft.archivedAt = nowIso();
    draft.updatedAt = nowIso();
  });

  dispatch("archive_workspace", { id: workspaceId, archivedAt: nowIso() });

  ensureActiveSelection([...workspaces.state.values()], [...threads.state.values()]);
}

export function updateThreadAction(thread: Thread) {
  const opId = createId("op");
  const existing = threads.get(thread.id);
  threads.update(thread.id, (draft) => {
    Object.assign(draft, thread);
  });
  if (existing) {
    trackOptimistic(opId, [restoreRow(threads, existing)]);
  }
  dispatch("update_thread", { thread: toWire(thread, opId) }, { opId });
}

export function updateWorkspaceAction(workspace: any) {
  const opId = createId("op");
  const existing = workspaces.get(workspace.id);
  workspaces.update(workspace.id, (draft) => {
    Object.assign(draft, workspace);
  });
  if (existing) {
    trackOptimistic(opId, [restoreRow(workspaces, existing)]);
  }
  dispatch("update_workspace", { workspace: toWire(workspace, opId) }, { opId });
}

export function sendMessageAction(input: {
  thread: Thread;
  text: string;
  modelId: string;
  search: boolean;
  attachmentIds?: string[];
}) {
  const opId = createId("op");
  const updatedAt = nowIso();

  const threadUpdate: Thread = {
    ...input.thread,
    title:
      input.thread.title === "New Chat" ? summarizeThreadTitle(input.text) : input.thread.title,
    updatedAt,
    lastMessageAt: updatedAt,
  };
  const userMessage = createMessage({
    threadId: input.thread.id,
    role: "user",
    modelId: input.modelId,
    text: input.text,
    searchEnabled: input.search,
    status: "completed",
  });
  const assistantMessage = createMessage({
    threadId: input.thread.id,
    role: "assistant",
    modelId: input.modelId,
    text: "",
    searchEnabled: input.search,
    status: "pending",
  });

  // Optimistic mutations
  threads.update(input.thread.id, (draft) => {
    Object.assign(draft, threadUpdate);
  });
  messages.insert(userMessage);
  messages.insert(assistantMessage);

  const rollbackEntries: OptimisticEntry[] = [
    restoreRow(threads, input.thread),
    deleteRow(messages, userMessage.id),
    deleteRow(messages, assistantMessage.id),
  ];

  // Link attachments to the user message locally for immediate UI feedback.
  for (const attachmentId of input.attachmentIds ?? []) {
    const existing = attachments.get(attachmentId) as Attachment | undefined;
    if (!existing) continue;
    rollbackEntries.push(restoreRow(attachments, existing));
    attachments.update(attachmentId, (draft) => {
      draft.messageId = userMessage.id;
      draft.status = "ready";
    });
  }

  trackOptimistic(opId, rollbackEntries);

  dispatch(
    "create_user_message",
    {
      threadId: input.thread.id,
      thread: toWire(threadUpdate, opId),
      userMessage: toWire(userMessage, opId),
      assistantMessage: toWire(assistantMessage, opId),
      promptText: input.text,
      modelId: input.modelId,
      search: input.search,
      attachmentIds: input.attachmentIds ?? [],
    } satisfies CreateUserMessagePayload,
    { opId },
  );
}

export function deleteAttachmentAction(attachmentId: string) {
  dispatch("delete_attachment", { id: attachmentId });
}

export function resetAllData() {
  const opId = createId("op");
  // Tell server to wipe all DO state
  dispatch("reset_storage", {}, { opId });
  // Clear local state
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem("b3.lastServerSeq");
    localStorage.removeItem("b3.activeWorkspaceId");
    localStorage.removeItem("b3.activeThreadId");
    localStorage.removeItem("b3.clientId");
  }
  // Reload to get fresh state from server
  setTimeout(() => location.reload(), 300);
}
