import {
  LOCAL_VALUES,
  TABLES,
  createId,
  createMessage,
  createThread,
  createWorkspace,
  decodeAttachmentRow,
  localValuesSchema,
  mergeAttachmentLink,
  nowIso,
  summarizeThreadTitle,
  tablesSchema,
  type Attachment,
  type CreateUserMessagePayload,
  type PendingSyncOp,
  type SyncClientCommand,
  type SyncCommandPayloadMap,
  type SyncCommandType,
  type SyncEventPayloadMap,
  type SyncEventType,
  type SyncServerEnvelope,
  type Thread,
} from "@b3-chat/domain";
import { createMergeableStore } from "tinybase";
import { createMiddleware } from "tinybase/middleware";
import { createLocalPersister } from "tinybase/persisters/persister-browser";

const PENDING_OPS_KEY = "b3.pendingOps";
const LAST_SERVER_SEQ_KEY = "b3.lastServerSeq";
const CLIENT_ID_KEY = "b3.clientId";

function syncLog(message: string, details?: Record<string, unknown>) {
  if (details) {
    console.log(`[sync-client] ${message}`, details);
    return;
  }
  console.log(`[sync-client] ${message}`);
}

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

class SyncClient {
  store = createMergeableStore("b3-chat-client")
    .setTablesSchema(tablesSchema)
    .setValuesSchema(localValuesSchema);
  middleware = createMiddleware(this.store as any);
  persister = createLocalPersister(this.store as any, "b3-chat.local");
  socket?: WebSocket;
  started = false;
  reconnectAttempt = 0;
  reconnectTimer?: number;
  clientId = readJson(CLIENT_ID_KEY, createId("client"));
  lastServerSeq = readJson(LAST_SERVER_SEQ_KEY, 0);
  pendingOps = new Map<string, PendingSyncOp>(
    Object.entries(readJson<Record<string, PendingSyncOp>>(PENDING_OPS_KEY, {})),
  );

  constructor() {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(CLIENT_ID_KEY, JSON.stringify(this.clientId));
    }
    this.installMiddleware();
  }

  async start() {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    await this.persister.startAutoPersisting();
    this.ensureLocalDefaults();
    this.connect();
  }

  private installMiddleware() {
    this.middleware.addWillSetRowCallback((tableId, _rowId, row) => {
      if (!row || typeof row !== "object") return row;
      const next = {
        ...row,
        optimistic: Boolean((row as any).optimistic),
        opId: (row as any).opId ?? null,
      } as any;
      if (tableId === TABLES.messages) {
        const current = this.store.getRow(tableId, (row as any).id ?? "") as any;
        if (
          current?.role === "assistant" &&
          current.status === "completed" &&
          next.status === "streaming"
        ) {
          return current;
        }
      }
      return next;
    });
  }

  private ensureLocalDefaults() {
    this.store.transaction(() => {
      if (!this.store.hasValue(LOCAL_VALUES.connectionStatus)) {
        this.store.setValue(LOCAL_VALUES.connectionStatus, "connecting");
      }
      if (!this.store.hasValue(LOCAL_VALUES.sidebarQuery)) {
        this.store.setValue(LOCAL_VALUES.sidebarQuery, "");
      }
    });
    this.ensureActiveSelection();
  }

  private connect() {
    if (typeof window === "undefined") return;
    this.store.setValue(LOCAL_VALUES.connectionStatus, "connecting");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    syncLog("connect", { clientId: this.clientId, lastServerSeq: this.lastServerSeq });
    const socket = new WebSocket(`${protocol}//${location.host}/api/sync/ws`);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      syncLog("open", { pendingOps: this.pendingOps.size });
      this.send({
        type: "hello",
        clientId: this.clientId,
        lastServerSeq: this.lastServerSeq,
        unackedOpIds: [...this.pendingOps.keys()],
      });
      this.flushPendingOps();
    });

    socket.addEventListener("message", ({ data }) => {
      const envelope = JSON.parse(String(data)) as SyncServerEnvelope;
      syncLog("message", {
        type: envelope.type,
        eventType: envelope.type === "event" ? envelope.eventType : undefined,
      });
      void this.handleServerEnvelope(envelope);
    });

    socket.addEventListener("close", () => {
      syncLog("close");
      this.store.setValue(LOCAL_VALUES.connectionStatus, "offline");
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      syncLog("error");
      this.store.setValue(LOCAL_VALUES.connectionStatus, "degraded");
    });
  }

  private scheduleReconnect() {
    if (typeof window === "undefined") return;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    const delay = Math.min(10_000, 500 * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  private async handleServerEnvelope(envelope: SyncServerEnvelope) {
    switch (envelope.type) {
      case "hello_ack":
        this.store.setValue(LOCAL_VALUES.connectionStatus, "connected");
        if (envelope.lastServerSeq > this.lastServerSeq) {
          this.lastServerSeq = envelope.lastServerSeq;
          this.persistLastServerSeq();
        }
        return;
      case "ack":
        this.pendingOps.delete(envelope.opId);
        this.persistPendingOps();
        return;
      case "reject":
        this.rollbackOp(envelope.opId);
        this.pendingOps.delete(envelope.opId);
        this.persistPendingOps();
        return;
      case "event":
        this.lastServerSeq = envelope.serverSeq;
        this.persistLastServerSeq();
        this.applyEvent(envelope.eventType, envelope.payload as any);
        return;
      case "sync_reset":
        syncLog("sync_reset", { reason: envelope.reason });
        if (envelope.reason !== "initial_sync") {
          this.pendingOps.clear();
          this.persistPendingOps();
        }
        this.store.transaction(() => {
          this.store.setTables(envelope.snapshot.tables as any);
        });
        this.ensureActiveSelection();
        return;
      case "pong":
        return;
    }
  }

  private send(message: object) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      syncLog("send", {
        type: (message as { type?: string }).type,
        commandType: (message as { commandType?: string }).commandType,
      });
      this.socket.send(JSON.stringify(message));
    }
  }

  private flushPendingOps() {
    for (const op of this.pendingOps.values()) {
      this.send({
        type: "command",
        opId: op.opId,
        clientTs: op.clientTs,
        commandType: op.commandType,
        payload: op.payload,
      } satisfies SyncClientCommand);
    }
  }

  private persistPendingOps() {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(
      PENDING_OPS_KEY,
      JSON.stringify(Object.fromEntries(this.pendingOps.entries())),
    );
  }

  private persistLastServerSeq() {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(LAST_SERVER_SEQ_KEY, JSON.stringify(this.lastServerSeq));
  }

  private enqueueCommand<T extends SyncCommandType>(
    commandType: T,
    payload: SyncCommandPayloadMap[T],
  ) {
    const op: PendingSyncOp<T> = {
      opId: createId("op"),
      clientTs: nowIso(),
      commandType,
      payload,
    };
    syncLog("enqueue", { opId: op.opId, commandType });
    this.applyOptimistic(op);
    this.pendingOps.set(op.opId, op);
    this.persistPendingOps();
    this.send({
      type: "command",
      opId: op.opId,
      clientTs: op.clientTs,
      commandType: op.commandType,
      payload: op.payload,
    } satisfies SyncClientCommand);
    return op;
  }

  private applyOptimistic(op: PendingSyncOp) {
    this.store.transaction(() => {
      switch (op.commandType) {
        case "create_workspace": {
          const payload = op.payload as SyncCommandPayloadMap["create_workspace"];
          this.store.setRow(TABLES.workspaces, payload.workspace.id, payload.workspace as any);
          this.store.setRow(TABLES.threads, payload.initialThread.id, payload.initialThread as any);
          this.store.setValue(LOCAL_VALUES.activeWorkspaceId, payload.workspace.id);
          this.store.setValue(LOCAL_VALUES.activeThreadId, payload.initialThread.id);
          break;
        }
        case "create_thread": {
          const payload = op.payload as SyncCommandPayloadMap["create_thread"];
          this.store.setRow(TABLES.threads, payload.thread.id, payload.thread as any);
          this.store.setValue(LOCAL_VALUES.activeThreadId, payload.thread.id);
          break;
        }
        case "archive_thread": {
          const payload = op.payload as SyncCommandPayloadMap["archive_thread"];
          const row = this.store.getRow(TABLES.threads, payload.id) as any;
          if (row) {
            this.store.setRow(TABLES.threads, payload.id, {
              ...row,
              archivedAt: payload.archivedAt,
              updatedAt: nowIso(),
            });
          }
          break;
        }
        case "create_user_message": {
          const payload = op.payload as SyncCommandPayloadMap["create_user_message"];
          this.store.setRow(TABLES.threads, payload.thread.id, payload.thread as any);
          this.store.setRow(TABLES.messages, payload.userMessage.id, payload.userMessage as any);
          this.store.setRow(
            TABLES.messages,
            payload.assistantMessage.id,
            payload.assistantMessage as any,
          );
          for (const attachmentId of payload.attachmentIds ?? []) {
            const existing = this.store.getRow(
              TABLES.attachments,
              attachmentId,
            ) as Attachment | null;
            if (!existing) continue;
            this.store.setRow(TABLES.attachments, attachmentId, {
              ...existing,
              messageId: payload.userMessage.id,
            } as any);
          }
          break;
        }
        case "register_attachment":
        case "complete_attachment": {
          const payload = op.payload as
            | SyncCommandPayloadMap["register_attachment"]
            | SyncCommandPayloadMap["complete_attachment"];
          const existing = this.store.getRow(
            TABLES.attachments,
            payload.attachment.id,
          ) as Attachment | null;
          this.store.setRow(
            TABLES.attachments,
            payload.attachment.id,
            mergeAttachmentLink(existing, payload.attachment) as any,
          );
          break;
        }
        case "delete_attachment": {
          const payload = op.payload as SyncCommandPayloadMap["delete_attachment"];
          this.store.delRow(TABLES.attachments, payload.id);
          break;
        }
        case "update_thread": {
          const payload = op.payload as SyncCommandPayloadMap["update_thread"];
          this.store.setRow(TABLES.threads, payload.thread.id, payload.thread as any);
          break;
        }
        case "update_workspace": {
          const payload = op.payload as SyncCommandPayloadMap["update_workspace"];
          this.store.setRow(TABLES.workspaces, payload.workspace.id, payload.workspace as any);
          break;
        }
        case "set_search_mode": {
          const payload = op.payload as SyncCommandPayloadMap["set_search_mode"];
          const workspace = this.store.getRow(TABLES.workspaces, payload.workspaceId) as any;
          if (workspace) {
            this.store.setRow(TABLES.workspaces, payload.workspaceId, {
              ...workspace,
              defaultSearchMode: payload.defaultSearchMode,
              updatedAt: nowIso(),
            });
          }
          break;
        }
      }
    });
  }

  private rollbackOp(opId: string) {
    this.store.transaction(() => {
      for (const tableId of [
        TABLES.workspaces,
        TABLES.threads,
        TABLES.messages,
        TABLES.attachments,
      ]) {
        for (const rowId of this.store.getRowIds(tableId)) {
          const row = this.store.getRow(tableId, rowId) as any;
          if (row?.opId === opId && row?.optimistic) {
            this.store.delRow(tableId, rowId);
          }
        }
      }
    });
    this.ensureActiveSelection();
  }

  private applyEvent<T extends SyncEventType>(eventType: T, payload: SyncEventPayloadMap[T]) {
    this.store.transaction(() => {
      switch (eventType) {
        case "workspace_upserted": {
          const event = payload as SyncEventPayloadMap["workspace_upserted"];
          this.store.setRow(TABLES.workspaces, event.row.id, event.row as any);
          break;
        }
        case "workspace_archived": {
          const event = payload as SyncEventPayloadMap["workspace_archived"];
          const row = this.store.getRow(TABLES.workspaces, event.id) as any;
          if (row)
            this.store.setRow(TABLES.workspaces, event.id, {
              ...row,
              archivedAt: event.archivedAt,
              updatedAt: event.updatedAt,
            });
          break;
        }
        case "thread_upserted": {
          const event = payload as SyncEventPayloadMap["thread_upserted"];
          this.store.setRow(TABLES.threads, event.row.id, event.row as any);
          break;
        }
        case "thread_archived": {
          const event = payload as SyncEventPayloadMap["thread_archived"];
          const row = this.store.getRow(TABLES.threads, event.id) as any;
          if (row)
            this.store.setRow(TABLES.threads, event.id, {
              ...row,
              archivedAt: event.archivedAt,
              updatedAt: event.updatedAt,
            });
          break;
        }
        case "message_upserted": {
          const event = payload as SyncEventPayloadMap["message_upserted"];
          this.store.setRow(TABLES.messages, event.row.id, event.row as any);
          break;
        }
        case "message_delta": {
          const event = payload as SyncEventPayloadMap["message_delta"];
          const row = this.store.getRow(TABLES.messages, event.messageId) as any;
          if (row) {
            this.store.setRow(TABLES.messages, event.messageId, {
              ...row,
              text: `${row.text}${event.delta}`,
              status: "streaming",
              updatedAt: event.updatedAt,
              optimistic: false,
            });
          }
          break;
        }
        case "message_part_appended": {
          const event = payload as SyncEventPayloadMap["message_part_appended"];
          this.store.setRow(TABLES.messageParts, event.row.id, event.row as any);
          break;
        }
        case "message_completed": {
          const event = payload as SyncEventPayloadMap["message_completed"];
          const row = this.store.getRow(TABLES.messages, event.messageId) as any;
          if (row) {
            this.store.setRow(TABLES.messages, event.messageId, {
              ...row,
              text: event.text,
              status: "completed",
              updatedAt: event.updatedAt,
              durationMs: event.durationMs ?? null,
              ttftMs: event.ttftMs ?? null,
              promptTokens: event.promptTokens ?? null,
              completionTokens: event.completionTokens ?? null,
              optimistic: false,
            });
          }
          break;
        }
        case "message_failed": {
          const event = payload as SyncEventPayloadMap["message_failed"];
          const row = this.store.getRow(TABLES.messages, event.messageId) as any;
          if (row) {
            this.store.setRow(TABLES.messages, event.messageId, {
              ...row,
              status: "failed",
              errorCode: event.errorCode,
              errorMessage: event.errorMessage,
              updatedAt: event.updatedAt,
              optimistic: false,
            });
          }
          break;
        }
        case "attachment_upserted": {
          const event = payload as SyncEventPayloadMap["attachment_upserted"];
          const existing = this.store.getRow(TABLES.attachments, event.row.id) as Attachment | null;
          this.store.setRow(
            TABLES.attachments,
            event.row.id,
            mergeAttachmentLink(existing, event.row) as any,
          );
          break;
        }
        case "attachment_deleted": {
          const event = payload as SyncEventPayloadMap["attachment_deleted"];
          this.store.delRow(TABLES.attachments, event.id);
          break;
        }
        case "search_results_replaced": {
          const event = payload as SyncEventPayloadMap["search_results_replaced"];
          for (const existingId of this.store.getRowIds(TABLES.searchResults)) {
            const row = this.store.getRow(TABLES.searchResults, existingId) as any;
            if (row?.messageId === event.messageId)
              this.store.delRow(TABLES.searchResults, existingId);
          }
          for (const row of event.rows) {
            this.store.setRow(TABLES.searchResults, row.id, row as any);
          }
          break;
        }
        case "server_state_rebased": {
          const event = payload as SyncEventPayloadMap["server_state_rebased"];
          this.store.setTables(event.snapshot.tables as any);
          break;
        }
      }
    });
    this.ensureActiveSelection();
  }

  private ensureActiveSelection() {
    const workspaces = Object.values<any>(this.store.getTable(TABLES.workspaces) ?? {}).filter(
      (workspace) => !workspace.archivedAt,
    );
    const activeWorkspaceId = this.store.getValue(LOCAL_VALUES.activeWorkspaceId) as
      | string
      | undefined;
    const nextWorkspace =
      workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0];
    if (nextWorkspace && activeWorkspaceId !== nextWorkspace.id) {
      this.store.setValue(LOCAL_VALUES.activeWorkspaceId, nextWorkspace.id);
    }
    const threads = Object.values<any>(this.store.getTable(TABLES.threads) ?? {}).filter(
      (thread) => thread.workspaceId === nextWorkspace?.id && !thread.archivedAt,
    );
    const activeThreadId = this.store.getValue(LOCAL_VALUES.activeThreadId) as string | undefined;
    const nextThread = threads.find((thread) => thread.id === activeThreadId) ?? threads[0];
    if (nextThread && activeThreadId !== nextThread.id) {
      this.store.setValue(LOCAL_VALUES.activeThreadId, nextThread.id);
    }
  }

  setActiveWorkspaceId(id: string) {
    this.store.setValue(LOCAL_VALUES.activeWorkspaceId, id);
    this.ensureActiveSelection();
  }

  setActiveThreadId(id: string) {
    this.store.setValue(LOCAL_VALUES.activeThreadId, id);
  }

  createWorkspace(name: string, defaultModelId: string) {
    const opId = createId("op");
    const workspace = createWorkspace({ name, defaultModelId, optimistic: true, opId });
    const initialThread = createThread({ workspaceId: workspace.id, optimistic: true, opId });
    return this.enqueueCommand("create_workspace", { workspace, initialThread });
  }

  createThread(workspaceId: string) {
    const opId = createId("op");
    const thread = createThread({ workspaceId, optimistic: true, opId });
    return this.enqueueCommand("create_thread", { thread });
  }

  archiveThread(threadId: string) {
    return this.enqueueCommand("archive_thread", {
      id: threadId,
      archivedAt: nowIso(),
    });
  }

  updateThread(thread: Thread) {
    return this.enqueueCommand("update_thread", { thread });
  }

  updateWorkspace(workspace: any) {
    return this.enqueueCommand("update_workspace", { workspace });
  }

  sendMessage(input: {
    thread: Thread;
    text: string;
    modelId: string;
    search: boolean;
    attachmentIds?: string[];
  }) {
    const opId = createId("op");
    const updatedAt = nowIso();
    const thread = {
      ...input.thread,
      title:
        input.thread.title === "New Chat" ? summarizeThreadTitle(input.text) : input.thread.title,
      updatedAt,
      lastMessageAt: updatedAt,
      optimistic: true,
      opId,
    };
    const userMessage = createMessage({
      threadId: input.thread.id,
      role: "user",
      modelId: input.modelId,
      text: input.text,
      searchEnabled: input.search,
      status: "completed",
      optimistic: true,
      opId,
    });
    const assistantMessage = createMessage({
      threadId: input.thread.id,
      role: "assistant",
      modelId: input.modelId,
      text: "",
      searchEnabled: input.search,
      status: "pending",
      optimistic: true,
      opId,
    });
    for (const attachmentId of input.attachmentIds ?? []) {
      const attachment = this.store.getRow(TABLES.attachments, attachmentId) as Attachment | null;
      if (!attachment) continue;
      this.completeAttachment({
        ...attachment,
        messageId: userMessage.id,
        status: "ready",
      });
    }
    return this.enqueueCommand("create_user_message", {
      threadId: input.thread.id,
      thread: thread as Thread,
      userMessage,
      assistantMessage,
      promptText: input.text,
      modelId: input.modelId,
      search: input.search,
      attachmentIds: input.attachmentIds ?? [],
    } satisfies CreateUserMessagePayload);
  }

  registerAttachment(attachment: Attachment) {
    const normalized = decodeAttachmentRow({
      ...attachment,
      optimistic: true,
      opId: attachment.opId ?? createId("op"),
    });
    return this.enqueueCommand("register_attachment", { attachment: normalized });
  }

  completeAttachment(attachment: Attachment) {
    const normalized = decodeAttachmentRow({
      ...attachment,
      optimistic: true,
    });
    return this.enqueueCommand("complete_attachment", { attachment: normalized });
  }

  get tables() {
    return this.store.getTables();
  }

  get values() {
    return this.store.getValues();
  }
}

export const syncClient = new SyncClient();
