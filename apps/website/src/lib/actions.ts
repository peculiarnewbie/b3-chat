import {
  createAttachment,
  createId,
  createMessage,
  createThread,
  createWorkspace,
  nowIso,
  summarizeThreadTitle,
  toWire,
  type Attachment,
  type CancelAssistantTurnPayload,
  type CreateUserMessagePayload,
  type EditUserMessagePayload,
  type Message,
  type ReasoningLevel,
  type RetryMessagePayload,
  type Thread,
  type Workspace,
} from "@b3-chat/domain";
import { dispatch } from "./pending-ops";
import {
  workspaces,
  threads,
  attachments,
  applyLocalDelete,
  applyLocalInsert,
  applyLocalUpdate,
  type CollectionId,
} from "./collections";
import { clearAllDraftState, clearWorkspaceDraft } from "./draft-state";
import { setActiveWorkspaceId, setActiveThreadId, ensureActiveSelection } from "./ui-state";

// ---------------------------------------------------------------------------
// Optimistic rollback tracking
// ---------------------------------------------------------------------------

type OptimisticEntry = {
  rollback: () => void;
};

type CollectionWithRows = {
  get: (key: string) => any;
};

const optimisticByOp = new Map<string, OptimisticEntry[]>();

function toLocalSyncRow<T extends object>(row: T, opId: string) {
  return {
    ...row,
    optimistic: false as const,
    opId,
  };
}

function trackOptimistic(opId: string, entries: OptimisticEntry[]) {
  optimisticByOp.set(opId, entries);
}

function deleteRow(collectionId: CollectionId, key: string): OptimisticEntry {
  return {
    rollback: () => {
      applyLocalDelete(collectionId, key);
    },
  };
}

function restoreRow<T extends { id: string }>(
  collectionId: CollectionId,
  collection: CollectionWithRows,
  row: T,
): OptimisticEntry {
  const snapshot = { ...row };
  return {
    rollback: () => {
      const existing = collection.get(snapshot.id);
      if (existing) {
        applyLocalUpdate(collectionId, snapshot);
        return;
      }
      applyLocalInsert(collectionId, snapshot);
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
  input: {
    defaultModelId: string;
    defaultReasoningLevel?: ReasoningLevel;
    defaultSearchMode?: boolean;
  },
) {
  const opId = createId("op");
  const workspace = createWorkspace({
    name,
    defaultModelId: input.defaultModelId,
    defaultReasoningLevel: input.defaultReasoningLevel,
    defaultSearchMode: input.defaultSearchMode,
  });
  const initialThread = createThread({ workspaceId: workspace.id });

  // Optimistic
  applyLocalInsert("workspaces", toLocalSyncRow(workspace, opId));
  applyLocalInsert("threads", toLocalSyncRow(initialThread, opId));
  setActiveWorkspaceId(workspace.id);
  setActiveThreadId(initialThread.id);
  trackOptimistic(opId, [
    deleteRow("workspaces", workspace.id),
    deleteRow("threads", initialThread.id),
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

  applyLocalInsert("threads", toLocalSyncRow(thread, opId));
  setActiveThreadId(thread.id);
  trackOptimistic(opId, [deleteRow("threads", thread.id)]);

  dispatch("create_thread", { thread: toWire(thread, opId) }, { opId });
}

export function archiveThreadAction(threadId: string) {
  const existing = threads.get(threadId);
  if (!existing) return;
  const updatedAt = nowIso();

  applyLocalUpdate("threads", {
    ...existing,
    archivedAt: updatedAt,
    updatedAt,
  });

  dispatch("archive_thread", { id: threadId, archivedAt: updatedAt });

  // Re-validate selection
  ensureActiveSelection([...workspaces.state.values()], [...threads.state.values()]);
}

export function archiveWorkspaceAction(workspaceId: string) {
  const existing = workspaces.get(workspaceId);
  if (!existing) return;
  const updatedAt = nowIso();

  applyLocalUpdate("workspaces", {
    ...existing,
    archivedAt: updatedAt,
    updatedAt,
  });

  dispatch("archive_workspace", { id: workspaceId, archivedAt: updatedAt });

  clearWorkspaceDraft(workspaceId);
  ensureActiveSelection([...workspaces.state.values()], [...threads.state.values()]);
}

export function updateThreadAction(thread: Thread) {
  const opId = createId("op");
  const existing = threads.get(thread.id);
  applyLocalUpdate("threads", toLocalSyncRow(thread, opId));
  if (existing) {
    trackOptimistic(opId, [restoreRow("threads", threads, existing)]);
  }
  dispatch("update_thread", { thread: toWire(thread, opId) }, { opId });
}

export function updateWorkspaceAction(workspace: Workspace) {
  const opId = createId("op");
  const existing = workspaces.get(workspace.id);
  applyLocalUpdate("workspaces", toLocalSyncRow(workspace, opId));
  if (existing) {
    trackOptimistic(opId, [restoreRow("workspaces", workspaces, existing)]);
  }
  dispatch("update_workspace", { workspace: toWire(workspace, opId) }, { opId });
}

export function sendMessageAction(input: {
  thread: Thread;
  text: string;
  modelId: string;
  modelInterleavedField?: string | null;
  reasoningLevel: ReasoningLevel;
  search: boolean;
  attachmentIds?: string[];
}) {
  const opId = createId("op");
  const updatedAt = nowIso();
  const userMessage = createMessage({
    threadId: input.thread.id,
    parentMessageId: input.thread.headMessageId ?? null,
    role: "user",
    modelId: input.modelId,
    reasoningLevel: input.reasoningLevel,
    text: input.text,
    searchEnabled: input.search,
    status: "completed",
  });
  const assistantMessage = createMessage({
    threadId: input.thread.id,
    parentMessageId: userMessage.id,
    role: "assistant",
    modelId: input.modelId,
    reasoningLevel: input.reasoningLevel,
    text: "",
    searchEnabled: input.search,
    status: "pending",
  });
  const threadUpdate: Thread = {
    ...input.thread,
    title:
      input.thread.title === "New Chat" ? summarizeThreadTitle(input.text) : input.thread.title,
    headMessageId: assistantMessage.id,
    updatedAt,
    lastMessageAt: updatedAt,
  };

  // Optimistic mutations
  const existingThread = threads.get(input.thread.id);
  if (!existingThread) {
    applyLocalInsert("threads", toLocalSyncRow(input.thread, opId));
  }
  applyLocalUpdate("threads", toLocalSyncRow(threadUpdate, opId));
  applyLocalInsert("messages", toLocalSyncRow(userMessage, opId));
  applyLocalInsert("messages", toLocalSyncRow(assistantMessage, opId));

  const rollbackEntries: OptimisticEntry[] = [
    existingThread
      ? restoreRow("threads", threads, existingThread)
      : deleteRow("threads", input.thread.id),
    deleteRow("messages", userMessage.id),
    deleteRow("messages", assistantMessage.id),
  ];

  // Link attachments to the user message locally for immediate UI feedback.
  for (const attachmentId of input.attachmentIds ?? []) {
    const existing = attachments.get(attachmentId) as Attachment | undefined;
    if (!existing) continue;
    rollbackEntries.push(restoreRow("attachments", attachments, existing));
    applyLocalUpdate("attachments", {
      ...existing,
      messageId: userMessage.id,
      status: "ready",
      optimistic: false,
      opId,
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
      modelInterleavedField: input.modelInterleavedField ?? null,
      reasoningLevel: input.reasoningLevel,
      search: input.search,
      attachmentIds: input.attachmentIds ?? [],
    } satisfies CreateUserMessagePayload,
    { opId },
  );
}

export function retryMessageAction(input: {
  thread: Thread;
  userMessage: Message;
  modelId: string;
  modelInterleavedField?: string | null;
  reasoningLevel: ReasoningLevel;
  search: boolean;
}) {
  const opId = createId("op");
  const updatedAt = nowIso();
  const assistantMessage = createMessage({
    threadId: input.thread.id,
    parentMessageId: input.userMessage.id,
    role: "assistant",
    modelId: input.modelId,
    reasoningLevel: input.reasoningLevel,
    text: "",
    searchEnabled: input.search,
    status: "pending",
  });
  const threadUpdate: Thread = {
    ...input.thread,
    headMessageId: assistantMessage.id,
    updatedAt,
    lastMessageAt: updatedAt,
  };

  const existingThread = threads.get(input.thread.id);
  if (existingThread) {
    applyLocalUpdate("threads", toLocalSyncRow(threadUpdate, opId));
  }
  applyLocalInsert("messages", toLocalSyncRow(assistantMessage, opId));

  trackOptimistic(opId, [
    existingThread
      ? restoreRow("threads", threads, existingThread)
      : deleteRow("threads", input.thread.id),
    deleteRow("messages", assistantMessage.id),
  ]);

  dispatch(
    "retry_message",
    {
      threadId: input.thread.id,
      thread: toWire(threadUpdate, opId),
      userMessage: toWire(input.userMessage, opId),
      assistantMessage: toWire(assistantMessage, opId),
      modelId: input.modelId,
      modelInterleavedField: input.modelInterleavedField ?? null,
      reasoningLevel: input.reasoningLevel,
      search: input.search,
    } satisfies RetryMessagePayload,
    { opId },
  );
}

export function editUserMessageAction(input: {
  thread: Thread;
  sourceMessage: Message;
  text: string;
  modelId: string;
  modelInterleavedField?: string | null;
  reasoningLevel: ReasoningLevel;
  search: boolean;
  attachmentIds?: string[];
}) {
  const opId = createId("op");
  const updatedAt = nowIso();
  const userMessage = createMessage({
    threadId: input.thread.id,
    parentMessageId: input.sourceMessage.parentMessageId ?? null,
    sourceMessageId: input.sourceMessage.id,
    role: "user",
    modelId: input.modelId,
    reasoningLevel: input.reasoningLevel,
    text: input.text,
    searchEnabled: input.search,
    status: "completed",
  });
  const assistantMessage = createMessage({
    threadId: input.thread.id,
    parentMessageId: userMessage.id,
    role: "assistant",
    modelId: input.modelId,
    reasoningLevel: input.reasoningLevel,
    text: "",
    searchEnabled: input.search,
    status: "pending",
  });
  const threadUpdate: Thread = {
    ...input.thread,
    headMessageId: assistantMessage.id,
    updatedAt,
    lastMessageAt: updatedAt,
  };

  const existingThread = threads.get(input.thread.id);
  if (existingThread) {
    applyLocalUpdate("threads", toLocalSyncRow(threadUpdate, opId));
  }
  applyLocalInsert("messages", toLocalSyncRow(userMessage, opId));
  applyLocalInsert("messages", toLocalSyncRow(assistantMessage, opId));

  const rollbackEntries: OptimisticEntry[] = [
    existingThread
      ? restoreRow("threads", threads, existingThread)
      : deleteRow("threads", input.thread.id),
    deleteRow("messages", userMessage.id),
    deleteRow("messages", assistantMessage.id),
  ];
  const clonedAttachments: Attachment[] = [];

  for (const attachmentId of input.attachmentIds ?? []) {
    const existing = attachments.get(attachmentId) as Attachment | undefined;
    if (!existing || existing.status !== "ready") continue;
    const clonedAttachment = {
      ...createAttachment({
        threadId: input.thread.id,
        messageId: userMessage.id,
        objectKey: existing.objectKey,
        fileName: existing.fileName,
        mimeType: existing.mimeType,
        sizeBytes: existing.sizeBytes,
        sha256: existing.sha256,
        status: "ready",
      }),
      width: existing.width,
      height: existing.height,
      optimistic: false as const,
      opId,
    };
    applyLocalInsert("attachments", clonedAttachment);
    rollbackEntries.push(deleteRow("attachments", clonedAttachment.id));
    clonedAttachments.push(clonedAttachment);
  }

  trackOptimistic(opId, rollbackEntries);

  dispatch(
    "edit_user_message",
    {
      threadId: input.thread.id,
      sourceMessageId: input.sourceMessage.id,
      thread: toWire(threadUpdate, opId),
      userMessage: toWire(userMessage, opId),
      assistantMessage: toWire(assistantMessage, opId),
      promptText: input.text,
      modelId: input.modelId,
      modelInterleavedField: input.modelInterleavedField ?? null,
      reasoningLevel: input.reasoningLevel,
      search: input.search,
      attachments: clonedAttachments.map((attachment) => toWire(attachment, opId)),
    } satisfies EditUserMessagePayload,
    { opId },
  );
}

/**
 * Cancel an in-flight assistant response. The server marks the message
 * `failed` with errorCode "cancelled", which releases the thread's "busy"
 * state client-side and lets the user regain control immediately.
 */
export function cancelAssistantTurnAction(messageId: string) {
  const opId = createId("op");
  dispatch("cancel_assistant_turn", { messageId } satisfies CancelAssistantTurnPayload, { opId });
}

export function deleteAttachmentAction(attachmentId: string) {
  dispatch("delete_attachment", { id: attachmentId });
}

export function updateAttachmentAction(attachment: Attachment) {
  const opId = createId("op");
  const existing = attachments.get(attachment.id);
  applyLocalUpdate("attachments", toLocalSyncRow(attachment, opId));
  if (existing) {
    trackOptimistic(opId, [restoreRow("attachments", attachments, existing)]);
  }
  dispatch("update_attachment", { attachment: toWire(attachment, opId) }, { opId });
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
  clearAllDraftState();
  // Reload to get fresh state from server
  setTimeout(() => location.reload(), 300);
}
