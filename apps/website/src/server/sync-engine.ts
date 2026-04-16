import {
  SYNC_PROTOCOL_VERSION,
  TABLES,
  createId,
  createMessagePart,
  createTraceRun,
  createTraceSpan,
  createThread,
  createWorkspace,
  decodeAttachmentRow,
  decodeMessageRow,
  decodeThreadRow,
  decodeTraceRunRow,
  decodeTraceSpanRow,
  decodeWorkspaceRow,
  mergeAttachmentLink,
  nowIso,
  type Attachment,
  type CreateUserMessagePayload,
  type Message,
  type ReasoningLevel,
  type SearchRun,
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
  type TraceRun,
  type TraceSpan,
  type Workspace,
  sortConversationMessages,
} from "@b3-chat/domain";
import {
  chat,
  completeTextAttachment,
  createChatCompletionsAdapter,
  getDefaultModelId,
  getSignedAttachmentUrl,
  isImageAttachment,
  isInlineTextAttachment,
  type AppEnv,
  type ModelMessage,
} from "@b3-chat/server";
import {
  createStructuredLogger,
  decodeAppEnv,
  makeRootTraceContext,
  makeTraceRecorder,
  runAppEffect,
  traceEffect,
} from "@b3-chat/effect";
import { Effect } from "effect";
import { createExaSearchTool, type SearchProgressEvent } from "./search";
import { normalizeAssistantError } from "./error-normalization";
import { consumeAssistantStream, type StreamConsumerDeps } from "./stream-consumer";
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
  syncLogger.log(message, details);
}

const syncLogger = createStructuredLogger("sync-do");

function previewText(value: string, limit = 160) {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function looksLikeMissingRealtimeAccess(text: string) {
  return /don'?t have access to real[- ]?time|can'?t tell you the (exact )?current time|don'?t have access to the current date|don'?t have access to current information/i.test(
    text,
  );
}

const SEARCH_TOOL_SYSTEM_PROMPT =
  "You have access to the exa_web_search tool for current or external information. Use it when the answer depends on up-to-date facts, live information, or verification outside the conversation. If the tool is available, do not claim you lack access to current information without trying it when it is relevant.";

function getProviderModelOptions(
  modelId: string,
  _toolCount: number,
  reasoningLevel: ReasoningLevel,
  modelInterleavedField?: string | null,
) {
  const provider = modelId.split("/")[0]?.toLowerCase() ?? "";
  const effectiveReasoningLevel = reasoningLevel;
  const overrideReason: string | null = null;

  // Models with interleaved thinking (e.g., Kimi K2.5) use reasoning_content field.
  // The adapter now properly caches and replays reasoning_content across tool calls.
  if (modelInterleavedField === "reasoning_content") {
    return {
      effectiveReasoningLevel,
      overrideReason,
      modelOptions: {
        thinking: {
          type: effectiveReasoningLevel === "off" ? ("disabled" as const) : ("enabled" as const),
        },
      },
    };
  }

  if (provider === "openai") {
    return {
      effectiveReasoningLevel,
      overrideReason,
      modelOptions: {
        reasoning: {
          effort:
            effectiveReasoningLevel === "off"
              ? ("none" as const)
              : (effectiveReasoningLevel as "low" | "medium" | "high"),
        },
      },
    };
  }

  if (provider === "groq") {
    return {
      effectiveReasoningLevel,
      overrideReason,
      modelOptions: {
        reasoning_effort:
          effectiveReasoningLevel === "off"
            ? ("none" as const)
            : (effectiveReasoningLevel as "low" | "medium" | "high"),
      },
    };
  }

  return {
    effectiveReasoningLevel,
    overrideReason,
    modelOptions: undefined,
  };
}

export class SyncEngineDurableObject {
  private initialized = false;
  private readonly ctx: DurableObjectState;
  private readonly env: AppEnv;

  constructor(ctx: DurableObjectState, env: AppEnv) {
    this.ctx = ctx;
    this.env = decodeAppEnv(env);
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
          protocolVersion: SYNC_PROTOCOL_VERSION,
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
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
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
      CREATE TABLE IF NOT EXISTS search_runs (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        row_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS search_results (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        row_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trace_runs (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        thread_id TEXT,
        workspace_id TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        row_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trace_spans (
        id TEXT PRIMARY KEY,
        trace_run_id TEXT,
        message_id TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        row_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_seq ON events(seq);
      CREATE INDEX IF NOT EXISTS idx_commands_seq ON commands(acked_seq);
      CREATE INDEX IF NOT EXISTS idx_threads_workspace ON threads(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
      CREATE INDEX IF NOT EXISTS idx_parts_message_seq ON message_parts(message_id, seq);
      CREATE INDEX IF NOT EXISTS idx_attachments_thread ON attachments(thread_id);
      CREATE INDEX IF NOT EXISTS idx_search_runs_message ON search_runs(message_id);
      CREATE INDEX IF NOT EXISTS idx_search_results_message ON search_results(message_id);
      CREATE INDEX IF NOT EXISTS idx_trace_runs_message ON trace_runs(message_id);
      CREATE INDEX IF NOT EXISTS idx_trace_spans_trace_run ON trace_spans(trace_run_id);
    `);
    const version = this.queryOne<{ value: string }>(
      `SELECT value FROM metadata WHERE key = 'sync_protocol_version'`,
    );
    if (version?.value !== SYNC_PROTOCOL_VERSION) {
      this.resetForProtocolVersion();
    }
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
        protocolVersion: SYNC_PROTOCOL_VERSION,
        serverTime: nowIso(),
        lastServerSeq,
      } satisfies SyncServerEnvelope),
    );

    if (hello.protocolVersion !== SYNC_PROTOCOL_VERSION) {
      syncLog("sync_reset", {
        reason: "protocol_mismatch",
        clientProtocolVersion: hello.protocolVersion,
        serverProtocolVersion: SYNC_PROTOCOL_VERSION,
      });
      ws.send(
        json({
          type: "sync_reset",
          reason: "protocol_mismatch",
          protocolVersion: SYNC_PROTOCOL_VERSION,
          snapshot: await this.getSnapshot(),
        } satisfies SyncServerEnvelope),
      );
      return;
    }

    // Check if client needs a full resync:
    // 1. lastServerSeq <= 0 means fresh client
    // 2. lastServerSeq < oldest event means the cursor is stale (events were pruned or client has old data)
    const oldestSeq = this.getOldestEventSeq();
    const needsFullSync =
      hello.lastServerSeq <= 0 || (oldestSeq > 0 && hello.lastServerSeq < oldestSeq);

    if (needsFullSync) {
      const reason = hello.lastServerSeq <= 0 ? "initial_sync" : "cursor_stale";
      syncLog("sync_reset", { reason, clientSeq: hello.lastServerSeq, oldestSeq });
      ws.send(
        json({
          type: "sync_reset",
          reason,
          protocolVersion: SYNC_PROTOCOL_VERSION,
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
            const workspace = {
              ...createWorkspace({
                name: "Default Workspace",
                defaultModelId: command.defaultModelId,
              }),
              optimistic: false,
              opId,
            };
            const thread = {
              ...createThread({
                workspaceId: workspace.id,
                title: "New Chat",
              }),
              optimistic: false,
              opId,
            };
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
          const existing = this.getAttachment(command.attachment.id);
          pendingEvents.push(
            this.insertEvent(opId, "attachment_upserted", {
              row: this.normalizeAttachment(
                mergeAttachmentLink(existing, command.attachment),
                opId,
              ),
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
        case "reset_storage": {
          // Drop all data and reset to a fresh state
          syncLog("reset_storage", { opId });
          this.exec(`DELETE FROM workspaces`);
          this.exec(`DELETE FROM threads`);
          this.exec(`DELETE FROM messages`);
          this.exec(`DELETE FROM message_parts`);
          this.exec(`DELETE FROM attachments`);
          this.exec(`DELETE FROM search_runs`);
          this.exec(`DELETE FROM search_results`);
          this.exec(`DELETE FROM trace_runs`);
          this.exec(`DELETE FROM trace_spans`);
          this.exec(`DELETE FROM events`);
          this.exec(`DELETE FROM commands`);
          this.exec(`DELETE FROM metadata WHERE key <> 'sync_protocol_version'`);
          // Reset autoincrement sequences
          this.exec(`DELETE FROM sqlite_sequence`);
          this.exec(
            `INSERT OR REPLACE INTO metadata (key, value) VALUES ('sync_protocol_version', ?)`,
            SYNC_PROTOCOL_VERSION,
          );
          // Bootstrap a fresh workspace
          const workspace = {
            ...createWorkspace({
              name: "Default Workspace",
              defaultModelId: getDefaultModelId(this.env),
            }),
            optimistic: false,
            opId,
          };
          const thread = {
            ...createThread({
              workspaceId: workspace.id,
              title: "New Chat",
            }),
            optimistic: false,
            opId,
          };
          pendingEvents.push(
            this.insertEvent(opId, "workspace_upserted", { row: workspace }),
            this.insertEvent(opId, "thread_upserted", { row: thread }),
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
      syncLog("follow_up_error", {
        opId,
        commandType,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
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
    const traceContext = makeRootTraceContext({
      messageId: payload.assistantMessage.id,
      threadId: payload.threadId,
      modelId: payload.modelId,
      opId: payload.assistantMessage.opId ?? null,
    });
    const rootSpanId = createId("span");
    const childTraceContext = {
      ...traceContext,
      parentSpanId: rootSpanId,
    };
    const traceRuns = new Map<string, TraceRun>();
    const traceSpans = new Map<string, TraceSpan>();
    const turnLogger = createStructuredLogger("assistant-turn", {
      traceId: traceContext.traceId,
      traceRunId: traceContext.traceRunId,
      rootSpanId,
      messageId: payload.assistantMessage.id,
      threadId: payload.threadId,
      modelId: payload.modelId,
    });

    const upsertTraceRun = async (row: TraceRun) => {
      traceRuns.set(row.id, row);
      const event = await this.appendServerEvent(null, "trace_run_upserted", { row });
      this.broadcast(event);
    };

    const upsertTraceSpan = async (row: TraceSpan) => {
      traceSpans.set(row.id, row);
      const event = await this.appendServerEvent(null, "trace_span_upserted", { row });
      this.broadcast(event);
    };

    const recorder = makeTraceRecorder({
      scope: "assistant-turn",
      logger: turnLogger,
      onTraceRunStart: async (row) => {
        await upsertTraceRun(
          createTraceRun({
            id: row.id,
            messageId: row.messageId,
            threadId: row.threadId,
            workspaceId: row.workspaceId,
            traceId: row.traceId,
            rootSpanId: row.rootSpanId,
            modelId: row.modelId,
            status: row.status,
            startedAt: row.startedAt,
            endedAt: row.endedAt,
            durationMs: row.durationMs,
            errorCode: row.errorCode,
            errorMessage: row.errorMessage,
            attrs: typeof row.attrsJson === "string" ? parseJson(row.attrsJson) : {},
          }),
        );
      },
      onTraceRunFinish: async (row) => {
        const current = traceRuns.get(row.id);
        if (!current) return;
        await upsertTraceRun(
          decodeTraceRunRow({
            ...current,
            ...row,
          }),
        );
      },
      onSpanStart: async (row) => {
        await upsertTraceSpan(
          createTraceSpan({
            id: row.id,
            traceRunId: row.traceRunId,
            traceId: row.traceId,
            parentSpanId: row.parentSpanId,
            messageId: row.messageId,
            name: row.name,
            kind: row.kind,
            status: row.status,
            startedAt: row.startedAt,
            endedAt: row.endedAt,
            durationMs: row.durationMs,
            errorCode: row.errorCode,
            errorMessage: row.errorMessage,
            attrs: typeof row.attrsJson === "string" ? parseJson(row.attrsJson) : {},
            events: typeof row.eventsJson === "string" ? parseJson(row.eventsJson) : [],
          }),
        );
      },
      onSpanFinish: async (row) => {
        const current = traceSpans.get(row.id);
        if (!current) return;
        await upsertTraceSpan(
          decodeTraceSpanRow({
            ...current,
            ...row,
          }),
        );
      },
    });

    const traceRuntime = {
      env: this.env,
      traceRecorder: recorder,
      traceContext: childTraceContext,
    } satisfies Parameters<typeof runAppEffect>[1];

    const traceAsync = <A>(
      name: string,
      kind: TraceSpan["kind"],
      attrs: Record<string, unknown>,
      run: () => Promise<A>,
    ) => runAppEffect(traceEffect(name, kind, attrs, Effect.tryPromise(run)), traceRuntime);

    const traceSync = <A>(
      name: string,
      kind: TraceSpan["kind"],
      attrs: Record<string, unknown>,
      run: () => A,
    ) => runAppEffect(traceEffect(name, kind, attrs, Effect.sync(run)), traceRuntime);

    syncLog("assistant_turn_start", {
      threadId: payload.threadId,
      assistantMessageId: payload.assistantMessage.id,
      modelId: payload.modelId,
      reasoningLevel: payload.reasoningLevel,
      search: payload.search,
      traceId: traceContext.traceId,
      traceRunId: traceContext.traceRunId,
    });

    await recorder.startTraceRun({
      traceRunId: traceContext.traceRunId,
      traceId: traceContext.traceId,
      rootSpanId,
      messageId: payload.assistantMessage.id,
      threadId: payload.threadId,
      workspaceId: payload.thread.workspaceId,
      modelId: payload.modelId || payload.assistantMessage.modelId || null,
      attrs: {
        reasoningLevel: payload.reasoningLevel,
        searchEnabled: payload.search,
      },
    });
    await recorder.startSpan({
      spanId: rootSpanId,
      traceRunId: traceContext.traceRunId,
      traceId: traceContext.traceId,
      parentSpanId: null,
      messageId: payload.assistantMessage.id,
      name: "assistant.turn",
      kind: "root",
      attrs: {
        workspaceId: payload.thread.workspaceId,
        threadId: payload.threadId,
        messageId: payload.assistantMessage.id,
        modelId: payload.modelId || payload.assistantMessage.modelId || null,
        reasoningLevel: payload.reasoningLevel,
        searchEnabled: payload.search,
      },
    });

    const snapshot = await traceAsync("assistant.snapshot.load", "io", {}, () =>
      this.getSnapshot(),
    );
    const thread = this.getThread(payload.threadId);
    if (!thread) {
      await recorder.finishSpan({
        spanId: rootSpanId,
        status: "failed",
        errorCode: "ThreadNotFound",
        errorMessage: "Thread not found",
      });
      await recorder.finishTraceRun({
        traceRunId: traceContext.traceRunId,
        status: "failed",
        errorCode: "ThreadNotFound",
        errorMessage: "Thread not found",
      });
      return;
    }
    const workspace = this.getWorkspace(thread.workspaceId);
    if (!workspace) {
      await recorder.finishSpan({
        spanId: rootSpanId,
        status: "failed",
        errorCode: "WorkspaceNotFound",
        errorMessage: "Workspace not found",
      });
      await recorder.finishTraceRun({
        traceRunId: traceContext.traceRunId,
        status: "failed",
        errorCode: "WorkspaceNotFound",
        errorMessage: "Workspace not found",
      });
      return;
    }
    const modelId = payload.modelId || workspace.defaultModelId || getDefaultModelId(this.env);
    childTraceContext.workspaceId = workspace.id;
    childTraceContext.modelId = modelId;
    let seq = 0;

    const appendMessagePart = async (
      kind: "activity" | "thinking_tokens",
      input: {
        text?: string;
        json?: string | null;
      },
    ) => {
      const part = createMessagePart({
        messageId: payload.assistantMessage.id,
        seq: seq++,
        kind,
        text: input.text ?? "",
        json: input.json ?? null,
      });
      const event = await this.appendServerEvent(null, "message_part_appended", { row: part });
      this.broadcast(event);
      return part;
    };

    const reportActivity = async (activity: SearchProgressEvent) => {
      await appendMessagePart("activity", {
        text: activity.label,
        json: json(activity),
      });
    };

    try {
      const threadMessages = await traceSync("assistant.thread_messages.load", "sync", {}, () =>
        this.getThreadMessages(snapshot, thread.id, [
          payload.userMessage,
          payload.assistantMessage,
        ]),
      );
      const searchTool = payload.search
        ? createExaSearchTool({
            env: this.env,
            assistantMessageId: payload.assistantMessage.id,
            log: syncLog,
            trace: (name, attrs, run) =>
              traceAsync(
                name,
                name === "assistant.search.prepare" ? "internal" : "tool",
                attrs,
                run,
              ),
            onProgress: reportActivity,
            onSearchStateChange: async (state) => {
              const searchRunEvent = await this.appendServerEvent(null, "search_runs_replaced", {
                messageId: payload.assistantMessage.id,
                rows: state.searchRuns,
              });
              this.broadcast(searchRunEvent);

              const searchEvent = await this.appendServerEvent(null, "search_results_replaced", {
                messageId: payload.assistantMessage.id,
                rows: state.searchResults,
              });
              this.broadcast(searchEvent);
            },
          })
        : null;

      const { messages: modelMessages, systemPrompts } = await traceAsync(
        "assistant.attachments.resolve",
        "io",
        { threadMessageCount: threadMessages.length },
        () => this.buildModelMessages(snapshot, workspace.id, threadMessages),
      );
      if (searchTool) {
        systemPrompts.push(SEARCH_TOOL_SYSTEM_PROMPT);
      }

      // Create adapter for TanStack AI chat()
      const adapter = createChatCompletionsAdapter(
        {
          baseUrl: this.env.OPENCODE_GO_BASE_URL,
          apiKey: this.env.OPENCODE_GO_API_KEY,
          trace: (name, kind, attrs, run) => traceAsync(name, kind, attrs, run),
        },
        modelId,
      );
      const providerOptions = await traceSync(
        "assistant.provider.options",
        "model",
        {
          modelId,
          reasoningLevel: payload.reasoningLevel,
          toolCount: searchTool ? 1 : 0,
          searchEnabled: payload.search,
        },
        () =>
          getProviderModelOptions(
            modelId,
            searchTool ? 1 : 0,
            payload.reasoningLevel,
            payload.modelInterleavedField,
          ),
      );
      const modelOptions = providerOptions.modelOptions;

      if (!modelOptions && payload.reasoningLevel !== "off") {
        syncLog("reasoning_mapping_unavailable", {
          assistantMessageId: payload.assistantMessage.id,
          modelId,
          requestedReasoningLevel: payload.reasoningLevel,
        });
      }

      syncLog("assistant_turn_upstream", {
        assistantMessageId: payload.assistantMessage.id,
        modelId,
        messageCount: modelMessages.length,
        systemPromptCount: systemPrompts.length,
        toolCount: searchTool ? 1 : 0,
        modelInterleavedField: payload.modelInterleavedField ?? null,
        requestedReasoningLevel: payload.reasoningLevel,
        effectiveReasoningLevel: providerOptions.effectiveReasoningLevel,
        overrideReason: providerOptions.overrideReason,
        modelOptions,
      });

      // Create stream consumer dependencies
      const consumerDeps: StreamConsumerDeps = {
        appendServerEvent: (opId, eventType, eventPayload) =>
          this.appendServerEvent(opId, eventType as any, eventPayload as any),
        broadcast: (envelope) => this.broadcast(envelope as any),
        appendMessagePart,
        reportActivity,
        messageId: payload.assistantMessage.id,
        log: syncLog,
        trace: (name, kind, attrs, run) => traceAsync(name, kind, attrs, run),
      };

      // Stream using TanStack AI's chat() function
      // Cast messages to work around strict ConstrainedModelMessage type constraints
      const stream = chat({
        adapter,
        messages: modelMessages as any,
        systemPrompts,
        ...(modelOptions ? { modelOptions } : {}),
        ...(searchTool ? { tools: [searchTool.tool] } : {}),
      });

      const result = await traceAsync("assistant.stream.consume", "io", { modelId }, () =>
        consumeAssistantStream(stream, consumerDeps),
      );
      const searchRuns = searchTool?.state.searchRuns ?? [];

      // Log completion metrics
      syncLog("assistant_turn_search_summary", {
        assistantMessageId: payload.assistantMessage.id,
        searchRuns: searchRuns.map((run) => ({
          step: run.step,
          query: run.query,
          status: run.status,
          resultCount: run.resultCount,
        })),
      });
      syncLog("assistant_turn_answer_sanity", {
        assistantMessageId: payload.assistantMessage.id,
        searched: searchRuns.length > 0,
        likelyIgnoredGrounding:
          searchRuns.length > 0 && looksLikeMissingRealtimeAccess(result.text),
        answerPreview: previewText(result.text),
      });
      await recorder.finishSpan({
        spanId: rootSpanId,
        status: "completed",
        attrs: {
          searchRunCount: searchRuns.length,
          answerPreview: previewText(result.text),
        },
      });
      await recorder.finishTraceRun({
        traceRunId: traceContext.traceRunId,
        status: "completed",
        attrs: {
          resultTextLength: result.text.length,
          searchRunCount: searchRuns.length,
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const normalizedError = normalizeAssistantError({
        errorCode: "assistant_turn_error",
        errorMessage,
        modelId,
      });
      syncLog("assistant_turn_exception", {
        assistantMessageId: payload.assistantMessage.id,
        modelId,
        search: payload.search,
        error: errorMessage,
        normalizedErrorCode: normalizedError.errorCode,
        providerName: normalizedError.providerName,
        retryable: normalizedError.retryable,
        stack: error instanceof Error ? error.stack : undefined,
      });

      const current = this.getMessage(payload.assistantMessage.id);
      if (current && current.status !== "completed" && current.status !== "failed") {
        const failed = await this.appendServerEvent(null, "message_failed", {
          messageId: payload.assistantMessage.id,
          errorCode: normalizedError.errorCode,
          errorMessage: normalizedError.errorMessage,
          updatedAt: nowIso(),
        });
        this.broadcast(failed);
      }

      await appendMessagePart("activity", {
        text: "Response failed",
        json: json({
          label: "Response failed",
          state: "failed",
          detail: normalizedError.errorMessage,
        } satisfies SearchProgressEvent),
      });
      await recorder.finishSpan({
        spanId: rootSpanId,
        status: normalizedError.errorCode === "cancelled" ? "cancelled" : "failed",
        errorCode: normalizedError.errorCode,
        errorMessage: normalizedError.errorMessage,
      });
      await recorder.finishTraceRun({
        traceRunId: traceContext.traceRunId,
        status: normalizedError.errorCode === "cancelled" ? "cancelled" : "failed",
        errorCode: normalizedError.errorCode,
        errorMessage: normalizedError.errorMessage,
      });
    }
  }

  private getThreadMessages(
    snapshot: SyncSnapshot,
    threadId: string,
    additionalMessages: Message[] = [],
  ) {
    const byId = new Map<string, Message>();
    for (const message of Object.values<any>(snapshot.tables?.[TABLES.messages] ?? {})) {
      if (message.threadId !== threadId) continue;
      byId.set(message.id, message);
    }
    for (const message of additionalMessages) {
      if (message.threadId !== threadId) continue;
      byId.set(message.id, message);
    }
    return sortConversationMessages([...byId.values()]);
  }

  /**
   * Builds TanStack AI ModelMessage array from thread messages.
   * Resolves attachments (images → signed URLs, text → inline content).
   * Returns messages and system prompts separately for TanStack AI's chat().
   */
  private async buildModelMessages(
    snapshot: SyncSnapshot,
    workspaceId: string,
    threadMessages: Message[],
  ): Promise<{ messages: ModelMessage[]; systemPrompts: string[] }> {
    const workspace = snapshot.tables?.[TABLES.workspaces]?.[workspaceId];
    const threadId = threadMessages[0]?.threadId;
    const attachments = Object.values<any>(snapshot.tables?.[TABLES.attachments] ?? {}).filter(
      (attachment) => attachment.threadId === threadId && attachment.status === "ready",
    );

    const systemPrompts: string[] = [];
    if (workspace?.systemPrompt) {
      systemPrompts.push(workspace.systemPrompt);
    }

    const messages: ModelMessage[] = [];

    for (const message of threadMessages) {
      if (message.status === "failed" || message.status === "cancelled") continue;

      // Build content parts - strings or typed parts
      // Our adapter handles conversion to OpenAI format
      const contentParts: Array<
        string | { type: "image"; source: { type: "url"; value: string } }
      > = [];

      if (message.text?.trim()) {
        contentParts.push(message.text);
      }

      if (message.role === "user") {
        for (const attachment of attachments) {
          if (attachment.messageId !== message.id) continue;
          if (isImageAttachment(attachment.mimeType)) {
            const signedUrl = await getSignedAttachmentUrl(this.env, attachment.objectKey);
            contentParts.push({
              type: "image",
              source: { type: "url", value: signedUrl },
            });
            continue;
          }
          if (isInlineTextAttachment(attachment.mimeType, attachment.sizeBytes)) {
            const text = await completeTextAttachment(this.env, attachment.objectKey);
            if (text) {
              contentParts.push(`Attachment ${attachment.fileName}:\n${text.slice(0, 10_000)}`);
            }
          }
        }
      }

      // Skip empty assistant messages
      if (message.role === "assistant" && contentParts.length === 0) continue;

      // Flatten content if only one string part
      const content: ModelMessage["content"] =
        contentParts.length === 1 && typeof contentParts[0] === "string"
          ? contentParts[0]
          : (contentParts as ModelMessage["content"]);

      messages.push({
        role: message.role as "user" | "assistant",
        content,
      });
    }

    return { messages, systemPrompts };
  }

  private normalizeWorkspace(row: Workspace, opId: string) {
    return decodeWorkspaceRow({
      ...row,
      defaultReasoningLevel: row.defaultReasoningLevel ?? "off",
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
      reasoningLevel: row.reasoningLevel ?? "off",
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
      case "search_runs_replaced": {
        const event = payload as SyncEventPayloadMap["search_runs_replaced"];
        this.exec(`DELETE FROM search_runs WHERE message_id = ?`, event.messageId);
        for (const row of event.rows) {
          this.exec(
            `INSERT OR REPLACE INTO search_runs (id, message_id, row_json)
             VALUES (?, ?, ?)`,
            row.id,
            row.messageId,
            json(row),
          );
        }
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
      case "trace_run_upserted": {
        const event = payload as SyncEventPayloadMap["trace_run_upserted"];
        const row = event.row;
        this.exec(
          `INSERT OR REPLACE INTO trace_runs (id, message_id, thread_id, workspace_id, status, started_at, row_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          row.id,
          row.messageId,
          row.threadId,
          row.workspaceId,
          row.status,
          row.startedAt,
          json(row),
        );
        break;
      }
      case "trace_span_upserted": {
        const event = payload as SyncEventPayloadMap["trace_span_upserted"];
        const row = event.row;
        this.exec(
          `INSERT OR REPLACE INTO trace_spans (id, trace_run_id, message_id, status, started_at, row_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
          row.id,
          row.traceRunId,
          row.messageId,
          row.status,
          row.startedAt,
          json(row),
        );
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
      "search_runs",
      "search_results",
      "trace_runs",
      "trace_spans",
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
    const runsByMessage = new Map<string, SearchRun[]>();
    for (const row of Object.values<SearchRun>(tables[TABLES.searchRuns] ?? {})) {
      const list = runsByMessage.get(row.messageId) ?? [];
      list.push(row);
      runsByMessage.set(row.messageId, list);
    }
    for (const [messageId, rows] of runsByMessage) {
      this.applyEventToMaterializedState("search_runs_replaced", { messageId, rows });
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
    for (const row of Object.values<TraceRun>(tables[TABLES.traceRuns] ?? {})) {
      this.applyEventToMaterializedState("trace_run_upserted", { row });
    }
    for (const row of Object.values<TraceSpan>(tables[TABLES.traceSpans] ?? {})) {
      this.applyEventToMaterializedState("trace_span_upserted", { row });
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

  /**
   * Returns the oldest event sequence in the log, or 0 if empty.
   * Used to detect if a client's cursor is stale (older than the oldest retained event).
   */
  private getOldestEventSeq(): number {
    const row = this.queryOne<{ min_seq: number | null }>(`SELECT MIN(seq) as min_seq FROM events`);
    return row?.min_seq ?? 0;
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
        [TABLES.searchRuns]: this.readTable("search_runs"),
        [TABLES.searchResults]: this.readTable("search_results"),
        [TABLES.traceRuns]: this.readTable("trace_runs"),
        [TABLES.traceSpans]: this.readTable("trace_spans"),
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

  private resetForProtocolVersion() {
    for (const tableName of [
      "events",
      "commands",
      "workspaces",
      "threads",
      "messages",
      "message_parts",
      "attachments",
      "search_runs",
      "search_results",
      "trace_runs",
      "trace_spans",
    ]) {
      this.exec(`DELETE FROM ${tableName}`);
    }
    this.exec(`DELETE FROM sqlite_sequence`);
    this.exec(
      `INSERT OR REPLACE INTO metadata (key, value) VALUES ('sync_protocol_version', ?)`,
      SYNC_PROTOCOL_VERSION,
    );
  }
}
