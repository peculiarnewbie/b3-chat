import {
  createId,
  createMessage,
  createThread,
  createWorkspace,
  mergeAttachmentLink,
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
  collection: { delete: (keys: string | string[]) => any };
  key: string;
};

const optimisticByOp = new Map<string, OptimisticEntry[]>();

function trackOptimistic(opId: string, entries: OptimisticEntry[]) {
  optimisticByOp.set(opId, entries);
}

/**
 * Called by sync-adapter on reject — removes optimistic rows.
 */
export function rollbackOp(opId: string) {
  const entries = optimisticByOp.get(opId);
  if (!entries) return;
  for (const entry of entries) {
    try {
      entry.collection.delete(entry.key);
    } catch {
      // Row may already have been replaced by server data
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

export function createWorkspaceAction(name: string, defaultModelId: string) {
  const opId = createId("op");
  const workspace = createWorkspace({ name, defaultModelId });
  const initialThread = createThread({ workspaceId: workspace.id });

  // Optimistic
  workspaces.insert(workspace);
  threads.insert(initialThread);
  setActiveWorkspaceId(workspace.id);
  setActiveThreadId(initialThread.id);
  trackOptimistic(opId, [
    { collection: workspaces, key: workspace.id },
    { collection: threads, key: initialThread.id },
  ]);

  dispatch("create_workspace", {
    workspace: toWire(workspace, opId),
    initialThread: toWire(initialThread, opId),
  });
}

export function createThreadAction(workspaceId: string) {
  const opId = createId("op");
  const thread = createThread({ workspaceId });

  threads.insert(thread);
  setActiveThreadId(thread.id);
  trackOptimistic(opId, [{ collection: threads, key: thread.id }]);

  dispatch("create_thread", { thread: toWire(thread, opId) });
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
  threads.update(thread.id, (draft) => {
    Object.assign(draft, thread);
  });
  dispatch("update_thread", { thread: toWire(thread, createId("op")) });
}

export function updateWorkspaceAction(workspace: any) {
  workspaces.update(workspace.id, (draft) => {
    Object.assign(draft, workspace);
  });
  dispatch("update_workspace", { workspace: toWire(workspace, createId("op")) });
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

  // Link attachments to user message
  for (const attachmentId of input.attachmentIds ?? []) {
    const existing = attachments.get(attachmentId) as Attachment | undefined;
    if (!existing) continue;
    completeAttachmentAction({
      ...existing,
      messageId: userMessage.id,
      status: "ready",
    });
  }

  trackOptimistic(opId, [
    { collection: messages, key: userMessage.id },
    { collection: messages, key: assistantMessage.id },
  ]);

  dispatch("create_user_message", {
    threadId: input.thread.id,
    thread: toWire(threadUpdate, opId),
    userMessage: toWire(userMessage, opId),
    assistantMessage: toWire(assistantMessage, opId),
    promptText: input.text,
    modelId: input.modelId,
    search: input.search,
    attachmentIds: input.attachmentIds ?? [],
  } satisfies CreateUserMessagePayload);
}

export function registerAttachmentAction(attachment: Attachment) {
  const opId = createId("op");
  const existing = attachments.get(attachment.id) as Attachment | undefined;
  const merged = mergeAttachmentLink(existing ?? null, attachment);
  attachments.insert(merged);
  trackOptimistic(opId, [{ collection: attachments, key: attachment.id }]);
  dispatch("register_attachment", { attachment: toWire(merged, opId) });
}

export function completeAttachmentAction(attachment: Attachment) {
  const opId = createId("op");
  const existing = attachments.get(attachment.id) as Attachment | undefined;
  const merged = mergeAttachmentLink(existing ?? null, attachment);
  if (existing) {
    attachments.update(attachment.id, (draft) => {
      Object.assign(draft, merged);
    });
  } else {
    attachments.insert(merged);
  }
  dispatch("complete_attachment", { attachment: toWire(merged, opId) });
}
