import {
  TABLES,
  buildSearchPlanningContext,
  buildSearchContext,
  createId,
  createMessagePart,
  createThread,
  createWorkspace,
  decodeAttachmentRow,
  decodeMessageRow,
  decodeSearchResultRow,
  decodeThreadRow,
  decodeWorkspaceRow,
  nowIso,
  type Attachment,
  type CreateUserMessagePayload,
  type Message,
  type SearchResult,
  type SyncClientEnvelope,
  type SyncClientHello,
  type SyncCommandPayloadMap,
  type SyncCommandType,
  type SyncEventPayloadMap,
  type SyncEventType,
  type SyncServerAck,
  type SyncServerEnvelope,
  type SyncServerEvent,
  type SyncSnapshot,
  type Thread,
  type Workspace,
} from "@b3-chat/domain";
import {
  completeTextAttachment,
  exaMcpSearchContext,
  exaSearch,
  getDefaultModelId,
  getSignedAttachmentUrl,
  isImageAttachment,
  isInlineTextAttachment,
  planSearch,
  type SearchPlan,
  type AppEnv,
} from "@b3-chat/server";
type SyncCommandResult = {
  ack?: SyncServerAck;
  events: SyncServerEvent[];
  followUp?: Promise<void>;
};

type DeferredFollowUp = () => Promise<void>;

function json<T>(value: T) {
  return JSON.stringify(value);
}

function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function isWebSocketRequest(request: Request) {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function syncLog(message: string, details?: Record<string, unknown>) {
  if (details) {
    console.log(`[sync-do] ${message}`, JSON.stringify(details));
    return;
  }
  console.log(`[sync-do] ${message}`);
}

export class SyncEngineDurableObject {
  private initialized = false;
  private readonly ctx: DurableObjectState;
  private readonly env: AppEnv;

  constructor(ctx: DurableObjectState, env: AppEnv) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request) {
    await this.ensureInitialized();
    const url = new URL(request.url);
    syncLog("fetch", { path: url.pathname, method: request.method });

    if (url.pathname === "/ws") {
      if (!isWebSocketRequest(request)) {
        return new Response("Upgrade required", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/internal/command" && request.method === "POST") {
      const body = (await request.json()) as {
        opId: string;
        commandType: SyncCommandType;
        payload: SyncCommandPayloadMap[SyncCommandType];
      };
      syncLog("internal_command", {
        opId: body.opId,
        commandType: body.commandType,
      });
      const result = await this.processCommand(body.opId, body.commandType, body.payload, true);
      return Response.json({
        ok: true,
        ack: result.ack,
      });
    }

    if (url.pathname === "/internal/snapshot") {
      return Response.json(await this.getSnapshot());
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    await this.ensureInitialized();
    const envelope = parseJson<SyncClientEnvelope>(
      typeof message === "string" ? message : new TextDecoder().decode(message),
    );
    try {
      syncLog("ws_message", { type: envelope.type });
      await this.handleSocketEnvelope(ws, envelope);
    } catch (error) {
      console.error("[sync] websocket message error", error);
      ws.send(
        json({
          type: "sync_reset",
          reason: error instanceof Error ? error.message : String(error),
          snapshot: await this.getSnapshot(),
        } satisfies SyncServerEnvelope),
      );
    }
  }

  async webSocketClose(_ws: WebSocket) {}

  private async ensureInitialized() {
    if (this.initialized) return;
    this.initialized = true;
    syncLog("initialize");
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        op_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS commands (
        op_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        response_json TEXT,
        created_at TEXT NOT NULL,
        acked_seq INTEGER
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        archived_at TEXT,
        updated_at TEXT NOT NULL,
        row_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        archived_at TEXT,
        updated_at TEXT NOT NULL,
        last_message_at TEXT NOT NULL,
        row_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        row_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS message_parts (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        row_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        message_id TEXT,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        row_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS search_results (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        row_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_seq ON events(seq);
      CREATE INDEX IF NOT EXISTS idx_commands_seq ON commands(acked_seq);
      CREATE INDEX IF NOT EXISTS idx_threads_workspace ON threads(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
      CREATE INDEX IF NOT EXISTS idx_parts_message_seq ON message_parts(message_id, seq);
      CREATE INDEX IF NOT EXISTS idx_attachments_thread ON attachments(thread_id);
      CREATE INDEX IF NOT EXISTS idx_search_results_message ON search_results(message_id);
    `);
  }

  private async handleSocketEnvelope(ws: WebSocket, envelope: SyncClientEnvelope) {
    switch (envelope.type) {
      case "hello":
        await this.handleHello(ws, envelope);
        return;
      case "resume":
        await this.replayAfter(ws, envelope.lastServerSeq);
        return;
      case "ping":
        ws.send(
          json({
            type: "pong",
            at: nowIso(),
          } satisfies SyncServerEnvelope),
        );
        return;
      case "command": {
        await this.processCommand(
          envelope.opId,
          envelope.commandType,
          envelope.payload as SyncCommandPayloadMap[typeof envelope.commandType],
          true,
        );
        return;
      }
    }
  }

  private async handleHello(ws: WebSocket, hello: SyncClientHello) {
    syncLog("hello", {
      clientId: hello.clientId,
      lastServerSeq: hello.lastServerSeq,
      unackedOpIds: hello.unackedOpIds.length,
    });
    await this.ensureBootstrapped();
    const lastServerSeq = this.getLastServerSeq();
    ws.send(
      json({
        type: "hello_ack",
        serverTime: nowIso(),
        lastServerSeq,
      } satisfies SyncServerEnvelope),
    );

    if (hello.lastServerSeq <= 0) {
      ws.send(
        json({
          type: "sync_reset",
          reason: "initial_sync",
          snapshot: await this.getSnapshot(),
        } satisfies SyncServerEnvelope),
      );
    } else {
      await this.replayAfter(ws, hello.lastServerSeq);
    }

    for (const opId of hello.unackedOpIds) {
      const ack = this.getCommandAck(opId);
      if (ack) ws.send(json(ack));
    }
  }

  private async replayAfter(ws: WebSocket, afterSeq: number) {
    for (const event of this.getEventsAfter(afterSeq)) {
      ws.send(json(event));
    }
  }

  private async ensureBootstrapped() {
    const existing = this.queryOne<{ count: number }>("SELECT count(*) as count FROM workspaces");
    if (Number(existing?.count ?? 0) > 0) return;
    await this.processCommand(
      createId("bootstrap"),
      "bootstrap_session",
      { defaultModelId: getDefaultModelId(this.env) },
      false,
    );
  }

  private async processCommand<T extends SyncCommandType>(
    opId: string,
    commandType: T,
    payload: SyncCommandPayloadMap[T],
    broadcast: boolean,
  ): Promise<SyncCommandResult> {
    syncLog("process_command_start", { opId, commandType, broadcast });
    const existing = this.getCommandAck(opId);
    if (existing) {
      syncLog("process_command_duplicate", { opId, commandType });
      return {
        ack: existing,
        events: [],
      };
    }

    const createdAt = nowIso();
    let followUp: DeferredFollowUp | undefined;
    const transactionResult = this.ctx.storage.transactionSync(() => {
      const pendingEvents: SyncServerEvent[] = [];
      switch (commandType) {
        case "bootstrap_session": {
          const command = payload as SyncCommandPayloadMap["bootstrap_session"];
          const workspaces = this.queryOne<{ count: number }>(
            "SELECT count(*) as count FROM workspaces",
          );
          if (Number(workspaces?.count ?? 0) === 0) {
            const workspace = createWorkspace({
              name: "Default Workspace",
              defaultModelId: command.defaultModelId,
              optimistic: false,
              opId,
            });
            const thread = createThread({
              workspaceId: workspace.id,
              title: "New Chat",
              optimistic: false,
              opId,
            });
            pendingEvents.push(
              this.insertEvent(opId, "workspace_upserted", { row: workspace }),
              this.insertEvent(opId, "thread_upserted", { row: thread }),
            );
          }
          break;
        }
        case "create_workspace": {
          const command = payload as SyncCommandPayloadMap["create_workspace"];
          pendingEvents.push(
            this.insertEvent(opId, "workspace_upserted", {
              row: this.normalizeWorkspace(command.workspace, opId),
            }),
            this.insertEvent(opId, "thread_upserted", {
              row: this.normalizeThread(command.initialThread, opId),
            }),
          );
          break;
        }
        case "update_workspace": {
          const command = payload as SyncCommandPayloadMap["update_workspace"];
          pendingEvents.push(
            this.insertEvent(opId, "workspace_upserted", {
              row: this.normalizeWorkspace(command.workspace, opId),
            }),
          );
          break;
        }
        case "archive_workspace": {
          const command = payload as SyncCommandPayloadMap["archive_workspace"];
          if (!this.getWorkspace(command.id)) throw new Error("Workspace not found");
          pendingEvents.push(
            this.insertEvent(opId, "workspace_archived", {
              id: command.id,
              archivedAt: command.archivedAt,
              updatedAt: nowIso(),
            }),
          );
          break;
        }
        case "create_thread":
        case "update_thread": {
          const command = payload as
            | SyncCommandPayloadMap["create_thread"]
            | SyncCommandPayloadMap["update_thread"];
          pendingEvents.push(
            this.insertEvent(opId, "thread_upserted", {
              row: this.normalizeThread(command.thread, opId),
            }),
          );
          break;
        }
        case "archive_thread": {
          const command = payload as SyncCommandPayloadMap["archive_thread"];
          if (!this.getThread(command.id)) throw new Error("Thread not found");
          pendingEvents.push(
            this.insertEvent(opId, "thread_archived", {
              id: command.id,
              archivedAt: command.archivedAt,
              updatedAt: nowIso(),
            }),
          );
          break;
        }
        case "create_user_message": {
          const command = payload as SyncCommandPayloadMap["create_user_message"];
          const normalizedThread = this.normalizeThread(command.thread, opId);
          const userMessage = this.normalizeMessage(
            {
              ...command.userMessage,
              status: "completed",
            },
            opId,
          );
          const assistantMessage = this.normalizeMessage(
            {
              ...command.assistantMessage,
              status: "pending",
              text: "",
            },
            opId,
          );
          pendingEvents.push(
            this.insertEvent(opId, "thread_upserted", { row: normalizedThread }),
            this.insertEvent(opId, "message_upserted", { row: userMessage }),
            this.insertEvent(opId, "message_upserted", { row: assistantMessage }),
          );
          // Link attachments to the user message
          if (command.attachmentIds?.length) {
            for (const attId of command.attachmentIds) {
              const attRow = this.getAttachment(attId);
              if (attRow) {
                pendingEvents.push(
                  this.insertEvent(opId, "attachment_upserted", {
                    row: this.normalizeAttachment({ ...attRow, messageId: userMessage.id }, opId),
                  }),
                );
              }
            }
          }
          followUp = () =>
            this.runAssistantTurn({
              ...command,
              thread: normalizedThread,
              userMessage,
              assistantMessage,
            });
          break;
        }
        case "start_assistant_turn": {
          const command = payload as SyncCommandPayloadMap["start_assistant_turn"];
          pendingEvents.push(
            this.insertEvent(opId, "message_upserted", {
              row: this.normalizeMessage(
                { ...command.assistantMessage, status: "pending", text: "" },
                opId,
              ),
            }),
          );
          break;
        }
        case "cancel_assistant_turn": {
          const command = payload as SyncCommandPayloadMap["cancel_assistant_turn"];
          if (!this.getMessage(command.messageId)) throw new Error("Message not found");
          pendingEvents.push(
            this.insertEvent(opId, "message_failed", {
              messageId: command.messageId,
              errorCode: "cancelled",
              errorMessage: "Cancelled",
              updatedAt: nowIso(),
            }),
          );
          break;
        }
        case "register_attachment":
        case "complete_attachment": {
          const command = payload as
            | SyncCommandPayloadMap["register_attachment"]
            | SyncCommandPayloadMap["complete_attachment"];
          pendingEvents.push(
            this.insertEvent(opId, "attachment_upserted", {
              row: this.normalizeAttachment(command.attachment, opId),
            }),
          );
          break;
        }
        case "delete_attachment": {
          const command = payload as SyncCommandPayloadMap["delete_attachment"];
          pendingEvents.push(this.insertEvent(opId, "attachment_deleted", { id: command.id }));
          break;
        }
        case "set_search_mode": {
          const command = payload as SyncCommandPayloadMap["set_search_mode"];
          const workspace = this.getWorkspace(command.workspaceId);
          if (!workspace) throw new Error("Workspace not found");
          pendingEvents.push(
            this.insertEvent(opId, "workspace_upserted", {
              row: this.normalizeWorkspace(
                {
                  ...workspace,
                  defaultSearchMode: command.defaultSearchMode,
                  updatedAt: nowIso(),
                },
                opId,
              ),
            }),
          );
          break;
        }
      }

      const ackedSeq = pendingEvents.at(-1)?.serverSeq ?? this.getLastServerSeq();
      const ack: SyncServerAck = {
        type: "ack",
        opId,
        serverSeq: ackedSeq,
        acceptedAt: createdAt,
        commandType,
      };
      this.exec(
        `INSERT INTO commands (op_id, type, status, response_json, created_at, acked_seq)
         VALUES (?, ?, ?, ?, ?, ?)`,
        opId,
        commandType,
        "accepted",
        json(ack),
        createdAt,
        ackedSeq,
      );
      return { ack, pendingEvents };
    });
    syncLog("process_command_committed", {
      opId,
      commandType,
      eventCount: transactionResult.pendingEvents.length,
      ackedSeq: transactionResult.ack.serverSeq,
      hasFollowUp: Boolean(followUp),
    });

    if (broadcast) {
      this.broadcast(transactionResult.ack);
      for (const event of transactionResult.pendingEvents) this.broadcast(event);
    }
    const followUpPromise = followUp?.().catch((error) => {
      console.error("[sync-do] follow_up_error", error);
    });
    if (followUpPromise) this.ctx.waitUntil(followUpPromise);
    return {
      ack: transactionResult.ack,
      events: transactionResult.pendingEvents,
      followUp: followUpPromise,
    };
  }

  private async runAssistantTurn(
    payload: CreateUserMessagePayload & {
      thread: Thread;
      userMessage: Message;
      assistantMessage: Message;
    },
  ) {
    syncLog("assistant_turn_start", {
      threadId: payload.threadId,
      assistantMessageId: payload.assistantMessage.id,
      modelId: payload.modelId,
      search: payload.search,
    });
    const snapshot = await this.getSnapshot();
    const thread = this.getThread(payload.threadId);
    if (!thread) return;
    const workspace = this.getWorkspace(thread.workspaceId);
    if (!workspace) return;
    const modelId = payload.modelId || workspace.defaultModelId || getDefaultModelId(this.env);

    let searchRows: SearchResult[] = [];
    let searchContext = "";
    if (payload.search && payload.promptText.trim()) {
      const threadMessages = this.getThreadMessages(snapshot, thread.id);
      const planningContext = buildSearchPlanningContext({
        promptText: payload.promptText,
        messages: threadMessages,
      });
      let searchPlan: SearchPlan;
      try {
        searchPlan = await planSearch(this.env, {
          modelId,
          planningContext,
        });
      } catch {
        searchPlan = {
          needsSearch: false,
          summary: "",
          query: "",
          numResults: 0,
        };
      }
      syncLog("assistant_turn_search_plan", {
        assistantMessageId: payload.assistantMessage.id,
        needsSearch: searchPlan.needsSearch,
        summary: searchPlan.summary,
        query: searchPlan.query,
        numResults: searchPlan.numResults,
      });
      if (searchPlan.needsSearch && searchPlan.query) {
        try {
          if (this.env.EXA_API_KEY) {
            searchRows = (await exaSearch(this.env, searchPlan.query, searchPlan.numResults)).map(
              (row) =>
                decodeSearchResultRow({
                  ...row,
                  id: createId("src"),
                  messageId: payload.assistantMessage.id,
                }),
            );
            searchContext = buildSearchContext({
              query: searchPlan.query,
              rows: searchRows,
            });
          } else {
            searchContext = await exaMcpSearchContext(searchPlan.query, searchPlan.numResults);
          }
        } catch {
          if (searchRows.length === 0) {
            searchContext = await exaMcpSearchContext(searchPlan.query, searchPlan.numResults);
          }
        }
      }
    }
    syncLog("assistant_turn_context_ready", {
      assistantMessageId: payload.assistantMessage.id,
      searchResults: searchRows.length,
      hasSearchContext: Boolean(searchContext),
    });

    if (searchRows.length > 0) {
      const searchEvent = await this.appendServerEvent(null, "search_results_replaced", {
        messageId: payload.assistantMessage.id,
        rows: searchRows,
      });
      this.broadcast(searchEvent);
    }

    const messages = await this.buildOpenAiMessages(snapshot, thread.id, workspace.id);
    if (searchContext) {
      messages.push({
        role: "system",
        content: searchContext,
      });
    }

    const upstream = await fetch(
      `${this.env.OPENCODE_GO_BASE_URL.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.env.OPENCODE_GO_API_KEY}`,
        },
        body: JSON.stringify({
          model: modelId,
          stream: true,
          stream_options: { include_usage: true },
          messages,
        }),
      },
    );
    syncLog("assistant_turn_upstream", {
      assistantMessageId: payload.assistantMessage.id,
      ok: upstream.ok,
      status: upstream.status,
    });

    if (!upstream.ok || !upstream.body) {
      const failed = await this.appendServerEvent(null, "message_failed", {
        messageId: payload.assistantMessage.id,
        errorCode: String(upstream.status),
        errorMessage: await upstream.text(),
        updatedAt: nowIso(),
      });
      this.broadcast(failed);
      return;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let accumulated = "";
    let pendingDelta = "";
    let seq = 0;
    let chunkCount = 0;
    let deltaCount = 0;
    const streamStartedAt = Date.now();
    let firstTokenAt: number | null = null;
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;

    const flushDelta = async () => {
      if (!pendingDelta) return;
      deltaCount += 1;
      accumulated += pendingDelta;
      const part = createMessagePart({
        messageId: payload.assistantMessage.id,
        seq: seq++,
        kind: "text",
        text: pendingDelta,
      });
      const partEvent = await this.appendServerEvent(null, "message_part_appended", { row: part });
      const deltaEvent = await this.appendServerEvent(null, "message_delta", {
        messageId: payload.assistantMessage.id,
        delta: pendingDelta,
        updatedAt: nowIso(),
      });
      this.broadcast(partEvent);
      this.broadcast(deltaEvent);
      syncLog("assistant_turn_delta", {
        assistantMessageId: payload.assistantMessage.id,
        seq: part.seq,
        chars: pendingDelta.length,
        totalChars: accumulated.length,
      });
      pendingDelta = "";
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunkCount += 1;
        buffer += decoder.decode(value, { stream: true });
        while (buffer.includes("\n\n")) {
          const idx = buffer.indexOf("\n\n");
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLines = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim());
          if (dataLines.length === 0) continue;
          const payloadJson = dataLines.join("\n");
          if (payloadJson === "[DONE]") continue;
          const parsed = JSON.parse(payloadJson);
          if (parsed.usage) {
            promptTokens = parsed.usage.prompt_tokens ?? null;
            completionTokens = parsed.usage.completion_tokens ?? null;
          }
          const delta = parsed.choices?.[0]?.delta?.content ?? "";
          if (!delta) continue;
          if (firstTokenAt === null) firstTokenAt = Date.now();
          pendingDelta += delta;
          if (pendingDelta.length >= 96 || /\n/.test(pendingDelta)) {
            await flushDelta();
          }
        }
      }
      await flushDelta();
      const durationMs = Date.now() - streamStartedAt;
      const ttftMs = firstTokenAt !== null ? firstTokenAt - streamStartedAt : null;
      const completed = await this.appendServerEvent(null, "message_completed", {
        messageId: payload.assistantMessage.id,
        text: accumulated,
        updatedAt: nowIso(),
        durationMs,
        ttftMs,
        promptTokens,
        completionTokens,
      });
      this.broadcast(completed);
      syncLog("assistant_turn_completed", {
        assistantMessageId: payload.assistantMessage.id,
        chunkCount,
        deltaCount,
        totalChars: accumulated.length,
      });
    } catch (error) {
      const failed = await this.appendServerEvent(null, "message_failed", {
        messageId: payload.assistantMessage.id,
        errorCode: "stream_error",
        errorMessage: error instanceof Error ? error.message : String(error),
        updatedAt: nowIso(),
      });
      this.broadcast(failed);
      console.error("[sync-do] assistant_turn_failed", {
        assistantMessageId: payload.assistantMessage.id,
        chunkCount,
        deltaCount,
        error,
      });
    }
  }

  private getThreadMessages(snapshot: SyncSnapshot, threadId: string) {
    return Object.values<any>(snapshot.tables?.[TABLES.messages] ?? {})
      .filter((message) => message.threadId === threadId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private async buildOpenAiMessages(snapshot: SyncSnapshot, threadId: string, workspaceId: string) {
    const workspace = snapshot.tables?.[TABLES.workspaces]?.[workspaceId];
    const messages = this.getThreadMessages(snapshot, threadId);
    const attachments = Object.values<any>(snapshot.tables?.[TABLES.attachments] ?? {}).filter(
      (attachment) => attachment.threadId === threadId && attachment.status === "ready",
    );

    const result: Array<Record<string, unknown>> = [];
    if (workspace?.systemPrompt) {
      result.push({
        role: "system",
        content: workspace.systemPrompt,
      });
    }

    for (const message of messages) {
      if (message.status === "failed" || message.status === "cancelled") continue;
      const inlineParts: Array<Record<string, unknown> | string> = [];
      if (message.text?.trim()) inlineParts.push(message.text);
      if (message.role === "user") {
        for (const attachment of attachments) {
          if (attachment.messageId && attachment.messageId !== message.id) continue;
          if (isImageAttachment(attachment.mimeType)) {
            inlineParts.push({
              type: "image_url",
              image_url: {
                url: await getSignedAttachmentUrl(this.env, attachment.objectKey),
              },
            });
            continue;
          }
          if (isInlineTextAttachment(attachment.mimeType, attachment.sizeBytes)) {
            const text = await completeTextAttachment(this.env, attachment.objectKey);
            if (text)
              inlineParts.push(`Attachment ${attachment.fileName}:\n${text.slice(0, 10_000)}`);
          }
        }
      }
      if (message.role === "assistant" && inlineParts.length === 0) continue;
      result.push({
        role: message.role,
        content:
          inlineParts.length <= 1 && typeof inlineParts[0] === "string"
            ? inlineParts[0]
            : inlineParts,
      });
    }

    return result;
  }

  private normalizeWorkspace(row: Workspace, opId: string) {
    return decodeWorkspaceRow({
      ...row,
      optimistic: false,
      opId,
      updatedAt: row.updatedAt || nowIso(),
    });
  }

  private normalizeThread(row: Thread, opId: string) {
    return decodeThreadRow({
      ...row,
      optimistic: false,
      opId,
      updatedAt: row.updatedAt || nowIso(),
      lastMessageAt: row.lastMessageAt || row.updatedAt || nowIso(),
    });
  }

  private normalizeMessage(row: Message, opId: string) {
    return decodeMessageRow({
      ...row,
      optimistic: false,
      opId,
      updatedAt: row.updatedAt || nowIso(),
    });
  }

  private normalizeAttachment(row: Attachment, opId: string) {
    return decodeAttachmentRow({
      ...row,
      optimistic: false,
      opId,
      updatedAt: row.updatedAt || nowIso(),
    });
  }

  private insertEvent<T extends SyncEventType>(
    opId: string | null,
    eventType: T,
    payload: SyncEventPayloadMap[T],
  ) {
    const eventId = createId("evt");
    const createdAt = nowIso();
    this.exec(
      `INSERT INTO events (event_id, op_id, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      eventId,
      opId,
      eventType,
      json(payload),
      createdAt,
    );
    const row = this.queryOne<{ seq: number }>("SELECT last_insert_rowid() as seq");
    const serverSeq = Number(row?.seq ?? 0);
    this.applyEventToMaterializedState(eventType, payload);
    return {
      type: "event",
      serverSeq,
      eventId,
      eventType,
      payload,
      causedByOpId: opId,
    } satisfies SyncServerEvent<T>;
  }

  private async appendServerEvent<T extends SyncEventType>(
    opId: string | null,
    eventType: T,
    payload: SyncEventPayloadMap[T],
  ) {
    return this.ctx.storage.transactionSync(() => this.insertEvent(opId, eventType, payload));
  }

  private applyEventToMaterializedState<T extends SyncEventType>(
    eventType: T,
    payload: SyncEventPayloadMap[T],
  ) {
    switch (eventType) {
      case "workspace_upserted": {
        const event = payload as SyncEventPayloadMap["workspace_upserted"];
        const row = event.row;
        this.exec(
          `INSERT OR REPLACE INTO workspaces (id, archived_at, updated_at, row_json)
           VALUES (?, ?, ?, ?)`,
          row.id,
          row.archivedAt,
          row.updatedAt,
          json(row),
        );
        break;
      }
      case "workspace_archived": {
        const event = payload as SyncEventPayloadMap["workspace_archived"];
        const row = this.getWorkspace(event.id);
        if (!row) break;
        this.applyEventToMaterializedState("workspace_upserted", {
          row: { ...row, archivedAt: event.archivedAt, updatedAt: event.updatedAt },
        });
        break;
      }
      case "thread_upserted": {
        const event = payload as SyncEventPayloadMap["thread_upserted"];
        const row = event.row;
        this.exec(
          `INSERT OR REPLACE INTO threads (id, workspace_id, archived_at, updated_at, last_message_at, row_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
          row.id,
          row.workspaceId,
          row.archivedAt,
          row.updatedAt,
          row.lastMessageAt,
          json(row),
        );
        break;
      }
      case "thread_archived": {
        const event = payload as SyncEventPayloadMap["thread_archived"];
        const row = this.getThread(event.id);
        if (!row) break;
        this.applyEventToMaterializedState("thread_upserted", {
          row: { ...row, archivedAt: event.archivedAt, updatedAt: event.updatedAt },
        });
        break;
      }
      case "message_upserted": {
        const event = payload as SyncEventPayloadMap["message_upserted"];
        const row = event.row;
        this.exec(
          `INSERT OR REPLACE INTO messages (id, thread_id, role, status, created_at, updated_at, row_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          row.id,
          row.threadId,
          row.role,
          row.status,
          row.createdAt,
          row.updatedAt,
          json(row),
        );
        break;
      }
      case "message_delta": {
        const event = payload as SyncEventPayloadMap["message_delta"];
        const row = this.getMessage(event.messageId);
        if (!row) break;
        this.applyEventToMaterializedState("message_upserted", {
          row: {
            ...row,
            text: `${row.text}${event.delta}`,
            status: "streaming",
            updatedAt: event.updatedAt,
            optimistic: false,
          },
        });
        break;
      }
      case "message_completed": {
        const event = payload as SyncEventPayloadMap["message_completed"];
        const row = this.getMessage(event.messageId);
        if (!row) break;
        this.applyEventToMaterializedState("message_upserted", {
          row: {
            ...row,
            text: event.text,
            status: "completed",
            updatedAt: event.updatedAt,
            durationMs: event.durationMs ?? null,
            ttftMs: event.ttftMs ?? null,
            promptTokens: event.promptTokens ?? null,
            completionTokens: event.completionTokens ?? null,
            optimistic: false,
          },
        });
        break;
      }
      case "message_failed": {
        const event = payload as SyncEventPayloadMap["message_failed"];
        const row = this.getMessage(event.messageId);
        if (!row) break;
        this.applyEventToMaterializedState("message_upserted", {
          row: {
            ...row,
            status: "failed",
            errorCode: event.errorCode,
            errorMessage: event.errorMessage,
            updatedAt: event.updatedAt,
            optimistic: false,
          },
        });
        break;
      }
      case "message_part_appended": {
        const event = payload as SyncEventPayloadMap["message_part_appended"];
        const row = event.row;
        this.exec(
          `INSERT OR REPLACE INTO message_parts (id, message_id, seq, row_json)
           VALUES (?, ?, ?, ?)`,
          row.id,
          row.messageId,
          row.seq,
          json(row),
        );
        break;
      }
      case "attachment_upserted": {
        const event = payload as SyncEventPayloadMap["attachment_upserted"];
        const row = event.row;
        this.exec(
          `INSERT OR REPLACE INTO attachments (id, thread_id, message_id, status, updated_at, row_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
          row.id,
          row.threadId,
          row.messageId,
          row.status,
          row.updatedAt,
          json(row),
        );
        break;
      }
      case "attachment_deleted": {
        const event = payload as SyncEventPayloadMap["attachment_deleted"];
        this.exec(`DELETE FROM attachments WHERE id = ?`, event.id);
        break;
      }
      case "search_results_replaced": {
        const event = payload as SyncEventPayloadMap["search_results_replaced"];
        this.exec(`DELETE FROM search_results WHERE message_id = ?`, event.messageId);
        for (const row of event.rows) {
          this.exec(
            `INSERT OR REPLACE INTO search_results (id, message_id, row_json)
             VALUES (?, ?, ?)`,
            row.id,
            row.messageId,
            json(row),
          );
        }
        break;
      }
      case "server_state_rebased": {
        const event = payload as SyncEventPayloadMap["server_state_rebased"];
        this.replaceSnapshot(event.snapshot);
        break;
      }
    }
  }

  private replaceSnapshot(snapshot: SyncSnapshot) {
    const tables = snapshot.tables ?? {};
    for (const tableName of [
      "workspaces",
      "threads",
      "messages",
      "message_parts",
      "attachments",
      "search_results",
    ]) {
      this.exec(`DELETE FROM ${tableName}`);
    }
    for (const row of Object.values<Workspace>(tables[TABLES.workspaces] ?? {})) {
      this.applyEventToMaterializedState("workspace_upserted", { row });
    }
    for (const row of Object.values<Thread>(tables[TABLES.threads] ?? {})) {
      this.applyEventToMaterializedState("thread_upserted", { row });
    }
    for (const row of Object.values<Message>(tables[TABLES.messages] ?? {})) {
      this.applyEventToMaterializedState("message_upserted", { row });
    }
    for (const row of Object.values<any>(tables[TABLES.messageParts] ?? {})) {
      this.applyEventToMaterializedState("message_part_appended", { row });
    }
    for (const row of Object.values<Attachment>(tables[TABLES.attachments] ?? {})) {
      this.applyEventToMaterializedState("attachment_upserted", { row });
    }
    const resultsByMessage = new Map<string, SearchResult[]>();
    for (const row of Object.values<SearchResult>(tables[TABLES.searchResults] ?? {})) {
      const list = resultsByMessage.get(row.messageId) ?? [];
      list.push(row);
      resultsByMessage.set(row.messageId, list);
    }
    for (const [messageId, rows] of resultsByMessage) {
      this.applyEventToMaterializedState("search_results_replaced", { messageId, rows });
    }
  }

  private getEventsAfter(afterSeq: number) {
    return this.queryAll<{
      seq: number;
      event_id: string;
      op_id: string | null;
      type: string;
      payload_json: string;
    }>(
      `SELECT seq, event_id, op_id, type, payload_json FROM events WHERE seq > ? ORDER BY seq ASC`,
      afterSeq,
    ).map((row) => ({
      type: "event",
      serverSeq: Number(row.seq),
      eventId: String(row.event_id),
      eventType: row.type as SyncEventType,
      payload: parseJson(row.payload_json),
      causedByOpId: row.op_id,
    }));
  }

  private getCommandAck(opId: string) {
    const row = this.queryOne<{ response_json: string | null }>(
      `SELECT response_json FROM commands WHERE op_id = ?`,
      opId,
    );
    return row?.response_json ? parseJson<SyncServerAck>(row.response_json) : null;
  }

  private getWorkspace(id: string) {
    const row = this.queryOne<{ row_json: string }>(
      `SELECT row_json FROM workspaces WHERE id = ?`,
      id,
    );
    return row ? parseJson<Workspace>(row.row_json) : null;
  }

  private getThread(id: string) {
    const row = this.queryOne<{ row_json: string }>(
      `SELECT row_json FROM threads WHERE id = ?`,
      id,
    );
    return row ? parseJson<Thread>(row.row_json) : null;
  }

  private getMessage(id: string) {
    const row = this.queryOne<{ row_json: string }>(
      `SELECT row_json FROM messages WHERE id = ?`,
      id,
    );
    return row ? parseJson<Message>(row.row_json) : null;
  }

  private getAttachment(id: string) {
    const row = this.queryOne<{ row_json: string }>(
      `SELECT row_json FROM attachments WHERE id = ?`,
      id,
    );
    return row ? parseJson<Attachment>(row.row_json) : null;
  }

  private getLastServerSeq() {
    const row = this.queryOne<{ seq: number }>("SELECT coalesce(max(seq), 0) as seq FROM events");
    return Number(row?.seq ?? 0);
  }

  private async getSnapshot(): Promise<SyncSnapshot> {
    return {
      tables: {
        [TABLES.workspaces]: this.readTable("workspaces"),
        [TABLES.threads]: this.readTable("threads"),
        [TABLES.messages]: this.readTable("messages"),
        [TABLES.messageParts]: this.readTable("message_parts"),
        [TABLES.attachments]: this.readTable("attachments"),
        [TABLES.searchResults]: this.readTable("search_results"),
      },
    };
  }

  private readTable(tableName: string) {
    const rows = this.queryAll<{ row_json: string }>(`SELECT row_json FROM ${tableName}`);
    const result: Record<string, unknown> = {};
    for (const row of rows) {
      const parsed = parseJson<{ id: string }>(row.row_json);
      result[parsed.id] = parsed;
    }
    return result;
  }

  private broadcast(envelope: SyncServerEnvelope) {
    const message = json(envelope);
    const sockets = this.ctx.getWebSockets();
    syncLog("broadcast", {
      type: envelope.type,
      sockets: sockets.length,
      eventType: envelope.type === "event" ? envelope.eventType : undefined,
    });
    for (const socket of sockets) {
      socket.send(message);
    }
  }

  private exec(query: string, ...params: any[]) {
    return this.ctx.storage.sql.exec(query, ...params);
  }

  private queryOne<T extends Record<string, unknown>>(query: string, ...params: any[]) {
    const rows = this.exec(query, ...params).toArray() as T[];
    return rows[0] ?? null;
  }

  private queryAll<T extends Record<string, unknown>>(query: string, ...params: any[]) {
    return this.exec(query, ...params).toArray() as T[];
  }
}
