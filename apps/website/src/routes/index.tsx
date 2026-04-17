import {
  For,
  Index,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onMount,
} from "solid-js";
import { createStore } from "solid-js/store";
import { useLiveQuery } from "@tanstack/solid-db";
import { createId, nowIso, resolveThreadMessagePath } from "@b3-chat/domain";
import type {
  Attachment,
  Message,
  MessagePart,
  ReasoningLevel,
  SearchRun,
  SearchResult,
  Thread,
  TraceRun,
  TraceSpan,
  Workspace,
} from "@b3-chat/domain";
import Markdown, { type Citation } from "../components/Markdown";
import { explainAssistantError } from "../lib/assistant-errors";
import { authClient } from "../lib/auth-client";
import { BUILD_INFO } from "../lib/build-info";
import { isAllowedFile, isImageMime, uploadFile } from "../lib/upload";
import {
  workspaces as workspacesCollection,
  threads as threadsCollection,
  messages as messagesCollection,
  messageParts as messagePartsCollection,
  attachments as attachmentsCollection,
  searchRuns as searchRunsCollection,
  searchResults as searchResultsCollection,
  traceRuns as traceRunsCollection,
  traceSpans as traceSpansCollection,
} from "../lib/collections";
import {
  createWorkspaceAction,
  archiveThreadAction,
  archiveWorkspaceAction,
  updateThreadAction,
  updateWorkspaceAction,
  deleteAttachmentAction,
  editUserMessageAction,
  retryMessageAction,
  sendMessageAction,
  resetAllData,
} from "../lib/actions";
import {
  activeWorkspaceId,
  setActiveWorkspaceId,
  activeThreadId,
  setActiveThreadId,
} from "../lib/ui-state";
import {
  activateWorkspaceDraftView,
  activateWorkspaceThreadView,
  consumePendingDraftAttachmentCleanup,
  ensureWorkspaceDraft,
  finalizeWorkspaceDraft,
  getWorkspaceConversationView,
  getWorkspaceDraft,
  pendingDraftAttachmentCleanupTick,
  removeWorkspaceDraftAttachment,
  updateWorkspaceDraft,
} from "../lib/draft-state";
import { start as startConnection } from "../lib/ws-connection";
import { init as initSyncAdapter } from "../lib/sync-adapter";

type SessionPayload = {
  user?: {
    email?: string;
  };
};

type ModelsPayload = {
  models: Array<{
    id: string;
    name: string;
    attachment: boolean;
    reasoning: boolean;
    toolCall: boolean;
    interleaved: {
      field: string | null;
    } | null;
    family: string;
    context: number | null;
    output: number | null;
  }>;
};

type Theme = "clean" | "night" | "warm";
type AssistantActivity = {
  label: string;
  state: "active" | "completed" | "failed";
  step: number | null;
  query: string | null;
  detail: string | null;
};

type ParsedTraceSpan = TraceSpan & {
  attrs: Record<string, unknown>;
  events: Record<string, unknown>[];
  children: ParsedTraceSpan[];
};

const REASONING_OPTIONS: Array<{ value: ReasoningLevel; label: string }> = [
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

function getDateGroup(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);
  const weekStart = new Date(todayStart.getTime() - 6 * 86_400_000);

  if (date >= todayStart) return "Today";
  if (date >= yesterdayStart) return "Yesterday";
  if (date >= weekStart) return "Last 7 Days";
  return "Older";
}

function groupThreadsByDate(threads: any[]): { label: string; threads: any[] }[] {
  const order = ["Today", "Yesterday", "Last 7 Days", "Older"];
  const groups: Record<string, any[]> = {};
  for (const thread of threads) {
    const label = getDateGroup(thread.lastMessageAt);
    (groups[label] ??= []).push(thread);
  }
  return order
    .filter((label) => groups[label]?.length)
    .map((label) => ({ label, threads: groups[label] }));
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokenCount(tokens: number): string {
  return new Intl.NumberFormat().format(tokens);
}

function getTotalTokens(message: {
  promptTokens?: number | null;
  completionTokens?: number | null;
}) {
  const promptTokens = typeof message.promptTokens === "number" ? message.promptTokens : null;
  const completionTokens =
    typeof message.completionTokens === "number" ? message.completionTokens : null;
  if (promptTokens == null && completionTokens == null) return null;
  return (promptTokens ?? 0) + (completionTokens ?? 0);
}

function parseThinkingTokens(part: { kind?: string; text?: string; json?: string | null }) {
  if (part.kind !== "thinking_tokens") return null;

  const fromText =
    typeof part.text === "string" && part.text.trim() ? Number(part.text.trim()) : NaN;
  if (Number.isFinite(fromText) && fromText > 0) return Math.round(fromText);

  if (typeof part.json !== "string" || !part.json.trim()) return null;
  try {
    const parsed = JSON.parse(part.json) as { tokens?: unknown };
    const tokens =
      typeof parsed.tokens === "number"
        ? parsed.tokens
        : typeof parsed.tokens === "string" && parsed.tokens.trim()
          ? Number(parsed.tokens)
          : NaN;
    if (Number.isFinite(tokens) && tokens > 0) return Math.round(tokens);
  } catch {
    return null;
  }

  return null;
}

function parseAssistantActivity(part: { kind?: string; text?: string; json?: string | null }) {
  if (part.kind !== "activity") return null;

  const fallbackLabel = typeof part.text === "string" ? part.text.trim() : "";
  if (typeof part.json !== "string" || !part.json.trim()) {
    return fallbackLabel
      ? {
          label: fallbackLabel,
          state: "active" as const,
          step: null,
          query: null,
          detail: null,
        }
      : null;
  }

  try {
    const parsed = JSON.parse(part.json) as Record<string, unknown>;
    const label =
      typeof parsed.label === "string" && parsed.label.trim() ? parsed.label.trim() : fallbackLabel;
    if (!label) return null;

    return {
      label,
      state: parsed.state === "completed" || parsed.state === "failed" ? parsed.state : "active",
      step: typeof parsed.step === "number" ? parsed.step : null,
      query: typeof parsed.query === "string" && parsed.query.trim() ? parsed.query.trim() : null,
      detail:
        typeof parsed.detail === "string" && parsed.detail.trim() ? parsed.detail.trim() : null,
    } satisfies AssistantActivity;
  } catch {
    return fallbackLabel
      ? {
          label: fallbackLabel,
          state: "active" as const,
          step: null,
          query: null,
          detail: null,
        }
      : null;
  }
}

function parseTraceJson(value: string | null | undefined) {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseTraceEvents(value: string | null | undefined) {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> =>
          Boolean(item && typeof item === "object"),
        )
      : [];
  } catch {
    return [];
  }
}

function formatTraceStatus(status: string) {
  switch (status) {
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Running";
  }
}

function shortTraceId(value: string) {
  return value.length <= 14 ? value : `${value.slice(0, 14)}…`;
}

function buildTraceTree(spans: TraceSpan[], parentSpanId: string | null = null): ParsedTraceSpan[] {
  return spans
    .filter((span) => (span.parentSpanId ?? null) === parentSpanId)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map((span) => ({
      ...span,
      attrs: parseTraceJson(span.attrsJson),
      events: parseTraceEvents(span.eventsJson),
      children: buildTraceTree(spans, span.id),
    }));
}

function TraceSpanTree(props: { span: ParsedTraceSpan }) {
  return (
    <div class="trace-span-node">
      <div
        classList={{
          "trace-span-header": true,
          "is-failed": props.span.status === "failed",
          "is-cancelled": props.span.status === "cancelled",
        }}
      >
        <span class="trace-span-name">{props.span.name}</span>
        <span class="trace-span-meta">
          <span>{formatTraceStatus(props.span.status)}</span>
          <Show when={props.span.durationMs != null}>
            <span>{formatDuration(props.span.durationMs!)}</span>
          </Show>
        </span>
      </div>
      <Show
        when={
          Object.keys(props.span.attrs).length > 0 ||
          props.span.errorMessage ||
          props.span.events.length > 0
        }
      >
        <details class="trace-span-details">
          <summary>Details</summary>
          <Show when={Object.keys(props.span.attrs).length > 0}>
            <pre>{JSON.stringify(props.span.attrs, null, 2)}</pre>
          </Show>
          <Show when={props.span.errorMessage}>
            <pre>{props.span.errorMessage}</pre>
          </Show>
          <Show when={props.span.events.length > 0}>
            <pre>{JSON.stringify(props.span.events, null, 2)}</pre>
          </Show>
        </details>
      </Show>
      <Show when={props.span.children.length > 0}>
        <div class="trace-span-children">
          <For each={props.span.children}>{(child) => <TraceSpanTree span={child} />}</For>
        </div>
      </Show>
    </div>
  );
}

const THEMES: { id: Theme; label: string }[] = [
  { id: "clean", label: "Clean" },
  { id: "night", label: "Night" },
  { id: "warm", label: "Warm" },
];

function getInitialTheme(): Theme {
  if (typeof localStorage !== "undefined") {
    const saved = localStorage.getItem("b3-theme") as Theme | null;
    if (saved && THEMES.some((t) => t.id === saved)) return saved;
  }
  return "clean";
}

const fetchSession = async () => {
  const response = await fetch("/api/session");
  if (response.status === 401) return null;
  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new Error(message || "Failed to load session");
  }
  return (await response.json()) as SessionPayload;
};

const fetchModels = async () => {
  const response = await fetch("/api/models");
  if (!response.ok) throw new Error("Failed to load models");
  return (await response.json()) as ModelsPayload;
};

export default function Home() {
  const [session] = createResource(fetchSession);
  const [models] = createResource(fetchModels);

  // Initialize sync layer
  onMount(() => {
    initSyncAdapter();
    startConnection();
  });

  // Reactive collection data via TanStack DB live queries
  const allWorkspaces = useLiveQuery(() => workspacesCollection);
  const allThreads = useLiveQuery(() => threadsCollection);
  const allMessages = useLiveQuery(() => messagesCollection);
  const allMessageParts = useLiveQuery(() => messagePartsCollection);
  const allAttachments = useLiveQuery(() => attachmentsCollection);
  const allSearchRuns = useLiveQuery(() => searchRunsCollection);
  const allSearchResults = useLiveQuery(() => searchResultsCollection);
  const allTraceRuns = useLiveQuery(() => traceRunsCollection);
  const allTraceSpans = useLiveQuery(() => traceSpansCollection);
  const [theme, setTheme] = createSignal<Theme>(getInitialTheme());
  const [sidebarOpen, setSidebarOpen] = createSignal(false);
  const [collapsedProgressByMessage, setCollapsedProgressByMessage] = createStore<
    Record<string, boolean>
  >({});
  const [didAutoCollapseProgressByMessage, setDidAutoCollapseProgressByMessage] = createStore<
    Record<string, boolean>
  >({});
  const [collapsedTraceByMessage, setCollapsedTraceByMessage] = createStore<
    Record<string, boolean>
  >({});
  const [composer, setComposer] = createStore({
    text: "",
    modelId: "",
    reasoningLevel: "off" as ReasoningLevel,
    search: false,
    sending: false,
    attachments: [] as Array<{
      localId: string;
      attachmentId: string | null;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      status: "uploading" | "ready" | "failed";
      previewUrl?: string;
    }>,
  });

  // Inline editing state
  const [editingThreadId, setEditingThreadId] = createSignal<string | null>(null);
  const [editingWorkspaceId, setEditingWorkspaceId] = createSignal<string | null>(null);
  const [editValue, setEditValue] = createSignal("");
  const [editingUserMessageId, setEditingUserMessageId] = createSignal<string | null>(null);
  const [editingUserMessageText, setEditingUserMessageText] = createSignal("");
  const [workspaceDeleteTarget, setWorkspaceDeleteTarget] = createSignal<{
    id: string;
    name: string;
  } | null>(null);

  // Settings state
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [systemPromptDraft, setSystemPromptDraft] = createSignal("");

  // biome-ignore lint: assigned via ref attribute
  // eslint-disable-next-line no-unassigned-vars -- assigned via SolidJS ref
  let timelineRef: HTMLElement | undefined;
  // eslint-disable-next-line no-unassigned-vars -- assigned via SolidJS ref attribute
  let fileInputRef: HTMLInputElement | undefined;

  // Drag-and-drop state
  const [isDragging, setIsDragging] = createSignal(false);
  let dragCounter = 0;
  const removedUploadLocalIds = new Set<string>();

  const workspaces = createMemo(() =>
    (allWorkspaces() as Workspace[])
      .filter((workspace) => !workspace.archivedAt)
      .sort((a, b) => b.sortKey - a.sortKey),
  );
  const activeWorkspace = createMemo(
    () => workspaces().find((workspace) => workspace.id === activeWorkspaceId()) ?? workspaces()[0],
  );
  const threads = createMemo(() =>
    (allThreads() as Thread[])
      .filter((thread) => thread.workspaceId === activeWorkspace()?.id && !thread.archivedAt)
      .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt)),
  );
  const activeThread = createMemo(
    () => threads().find((thread) => thread.id === activeThreadId()) ?? threads()[0],
  );
  const activeDraft = createMemo(() => {
    const workspace = activeWorkspace();
    if (!workspace) return null;
    return getWorkspaceDraft(workspace.id);
  });
  const isDraftViewActive = createMemo(() => {
    const workspace = activeWorkspace();
    if (!workspace) return false;
    return getWorkspaceConversationView(workspace.id) === "draft" && Boolean(activeDraft());
  });
  const selectedConversationThread = createMemo(
    () => (isDraftViewActive() ? activeDraft()?.thread : activeThread()) ?? null,
  );
  const composerText = () => (isDraftViewActive() ? (activeDraft()?.text ?? "") : composer.text);
  const composerAttachments = () =>
    isDraftViewActive() ? (activeDraft()?.attachments ?? []) : composer.attachments;
  const composerModelId = () =>
    isDraftViewActive() ? (activeDraft()?.modelId ?? "") : composer.modelId;
  const composerReasoningLevel = () =>
    isDraftViewActive() ? (activeDraft()?.reasoningLevel ?? "off") : composer.reasoningLevel;
  const composerSearch = () =>
    isDraftViewActive() ? (activeDraft()?.search ?? false) : composer.search;
  const setComposerTextValue = (text: string) => {
    const workspace = activeWorkspace();
    if (workspace && isDraftViewActive()) {
      updateWorkspaceDraft(workspace.id, (draft) => ({
        ...draft,
        text,
        updatedAt: nowIso(),
      }));
      return;
    }
    setComposer("text", text);
  };

  // File upload handlers
  const handleFileSelect = async (files: FileList | null) => {
    const thread = selectedConversationThread();
    const workspace = activeWorkspace();
    const draftMode = isDraftViewActive();
    if (!files || !thread || !workspace) return;
    for (const file of Array.from(files)) {
      if (!isAllowedFile(file)) continue;
      const localId = createId("local");
      const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;

      const draftAttachment = {
        localId,
        attachmentId: null,
        threadId: thread.id,
        fileName: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        status: "uploading" as const,
        previewUrl,
      };
      if (draftMode) {
        updateWorkspaceDraft(workspace.id, (draft) => ({
          ...draft,
          attachments: [...draft.attachments, draftAttachment],
          updatedAt: nowIso(),
        }));
      } else {
        setComposer("attachments", (prev) => [...prev, draftAttachment]);
      }

      try {
        const result = await uploadFile(file, thread.id);
        if (removedUploadLocalIds.delete(localId)) {
          deleteAttachmentAction(result.attachment.id);
          continue;
        }
        if (draftMode) {
          updateWorkspaceDraft(workspace.id, (draft) => ({
            ...draft,
            attachments: draft.attachments.map((attachment) =>
              attachment.localId === localId
                ? {
                    ...attachment,
                    attachmentId: result.attachment.id,
                    status: "ready",
                  }
                : attachment,
            ),
            updatedAt: nowIso(),
          }));
        } else {
          setComposer("attachments", (att) => att.localId === localId, {
            attachmentId: result.attachment.id,
            status: "ready",
          });
        }
      } catch (err) {
        if (removedUploadLocalIds.delete(localId)) {
          continue;
        }
        console.error("Upload failed:", err);
        if (draftMode) {
          updateWorkspaceDraft(workspace.id, (draft) => ({
            ...draft,
            attachments: draft.attachments.map((attachment) =>
              attachment.localId === localId
                ? {
                    ...attachment,
                    status: "failed",
                  }
                : attachment,
            ),
            updatedAt: nowIso(),
          }));
        } else {
          setComposer("attachments", (att) => att.localId === localId, "status", "failed");
        }
      }
    }
    if (fileInputRef) fileInputRef.value = "";
  };

  const removeAttachment = (localId: string) => {
    const workspace = activeWorkspace();
    const att = composerAttachments().find((attachment) => attachment.localId === localId);
    if (att?.previewUrl) URL.revokeObjectURL(att.previewUrl);
    if (att?.attachmentId) {
      deleteAttachmentAction(att.attachmentId);
    } else {
      removedUploadLocalIds.add(localId);
    }
    if (workspace && isDraftViewActive()) {
      removeWorkspaceDraftAttachment(workspace.id, localId);
      return;
    }
    setComposer("attachments", (prev) =>
      prev.filter((attachment) => attachment.localId !== localId),
    );
  };

  const handleDragEnter = (e: DragEvent) => {
    e.preventDefault();
    dragCounter++;
    setIsDragging(true);
  };
  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      setIsDragging(false);
    }
  };
  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
  };
  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    dragCounter = 0;
    setIsDragging(false);
    void handleFileSelect(e.dataTransfer?.files ?? null);
  };

  const handlePaste = (e: ClipboardEvent) => {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      void handleFileSelect(files);
    }
  };

  // Smart scroll: track whether user is near the bottom
  const [isNearBottom, setIsNearBottom] = createSignal(true);
  const [showScrollBtn, setShowScrollBtn] = createSignal(false);

  const SCROLL_THRESHOLD = 80; // px from bottom to consider "at bottom"

  const handleTimelineScroll = () => {
    if (!timelineRef) return;
    const { scrollTop, scrollHeight, clientHeight } = timelineRef;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const nearBottom = distanceFromBottom <= SCROLL_THRESHOLD;
    setIsNearBottom(nearBottom);
    setShowScrollBtn(!nearBottom);
  };

  const scrollToBottom = () => {
    if (!timelineRef) return;
    timelineRef.scrollTo({ top: timelineRef.scrollHeight, behavior: "smooth" });
  };

  // Apply theme to document
  createEffect(() => {
    document.documentElement.setAttribute("data-theme", theme());
    localStorage.setItem("b3-theme", theme());
  });

  // Sync system prompt draft when settings opens or workspace changes
  createEffect(() => {
    if (settingsOpen()) {
      setSystemPromptDraft(activeWorkspace()?.systemPrompt ?? "");
    }
  });

  createEffect(() => {
    const workspace = activeWorkspace();
    if (!workspace) return;
    if (getWorkspaceConversationView(workspace.id) === "draft" && getWorkspaceDraft(workspace.id)) {
      return;
    }
    setComposer("modelId", workspace.defaultModelId);
    setComposer("reasoningLevel", workspace.defaultReasoningLevel ?? "off");
    setComposer("search", workspace.defaultSearchMode);
  });

  createEffect(() => {
    const modelList = models()?.models ?? [];
    const workspace = activeWorkspace();
    if (!workspace) {
      if (!composer.modelId && modelList[0]) setComposer("modelId", modelList[0].id);
      return;
    }

    if (workspace.defaultModelId && modelList.length > 0) {
      const exists = modelList.some((m) => m.id === workspace.defaultModelId);
      if (!exists && modelList[0]) {
        updateWorkspacePreferences({ defaultModelId: modelList[0].id });
      }
    }
  });

  const selectedModel = createMemo(
    () => (models()?.models ?? []).find((model) => model.id === composerModelId()) ?? null,
  );
  const modelInterleavedFieldFor = (modelId: string) =>
    (models()?.models ?? []).find((model) => model.id === modelId)?.interleaved?.field?.trim() ||
    null;
  const selectedModelSupportsReasoning = createMemo(() => Boolean(selectedModel()?.reasoning));
  const selectedModelInterleavedField = createMemo(
    () => selectedModel()?.interleaved?.field?.trim() || null,
  );
  const effectiveComposerReasoningLevel = createMemo<ReasoningLevel>(() =>
    selectedModelSupportsReasoning() ? composerReasoningLevel() : "off",
  );
  const willDisableReasoningForToolTurn = createMemo(
    () =>
      composerSearch() &&
      effectiveComposerReasoningLevel() !== "off" &&
      Boolean(selectedModelInterleavedField()),
  );

  createEffect(() => {
    pendingDraftAttachmentCleanupTick();
    for (const cleanup of consumePendingDraftAttachmentCleanup()) {
      if (cleanup.previewUrl) {
        URL.revokeObjectURL(cleanup.previewUrl);
      }
      if (cleanup.attachmentId) {
        deleteAttachmentAction(cleanup.attachmentId);
        continue;
      }
      removedUploadLocalIds.add(cleanup.localId);
    }
  });
  const messageIds = createMemo(() =>
    resolveThreadMessagePath(
      (allMessages() as Message[]).filter(
        (message) => message.threadId === selectedConversationThread()?.id,
      ),
      selectedConversationThread()?.headMessageId ?? null,
    ).map((message) => message.id),
  );
  const messagesById = createMemo(() => {
    const byId = new Map<string, Message>();
    for (const message of allMessages() as Message[]) {
      byId.set(message.id, message);
    }
    return byId;
  });
  const messageById = (messageId: string) => messagesById().get(messageId);
  const streamingThreadIds = createMemo(() => {
    const ids = new Set<string>();
    for (const msg of allMessages() as Message[]) {
      if (msg.status === "streaming" || msg.status === "pending" || msg.status === "queued") {
        ids.add(msg.threadId);
      }
    }
    return ids;
  });
  const searchRunsMemo = createMemo(() => {
    const resultsByRun = new Map<string, SearchResult[]>();
    for (const row of allSearchResults() as SearchResult[]) {
      const list = resultsByRun.get(row.searchRunId) ?? [];
      list.push(row);
      resultsByRun.set(row.searchRunId, list);
    }

    const byMessage = new Map<string, Array<SearchRun & { results: SearchResult[] }>>();
    for (const row of allSearchRuns() as SearchRun[]) {
      const list = byMessage.get(row.messageId) ?? [];
      list.push({
        ...row,
        results: resultsByRun.get(row.id) ?? [],
      });
      byMessage.set(row.messageId, list);
    }

    for (const list of byMessage.values()) {
      list.sort((a, b) => a.step - b.step);
    }
    return byMessage;
  });
  /** Flat, ordered list of citations per message (matches [1],[2]… numbering the model uses). */
  const citationsForMessage = (messageId: string): Citation[] => {
    const runs = searchRunsMemo().get(messageId);
    if (!runs?.length) return [];
    return runs.flatMap((run) =>
      run.results.map((r) => ({
        url: r.url,
        title: r.title,
        domain: r.domain,
        snippet: r.snippet,
      })),
    );
  };
  const thinkingTokensByMessage = createMemo(() => {
    const byMessage = new Map<string, { seq: number; tokens: number }>();
    for (const row of allMessageParts() as MessagePart[]) {
      const tokens = parseThinkingTokens(row);
      if (tokens == null) continue;
      const current = byMessage.get(row.messageId);
      if (!current || row.seq > current.seq) {
        byMessage.set(row.messageId, { seq: row.seq, tokens });
      }
    }
    return new Map(
      Array.from(byMessage.entries()).map(([messageId, value]) => [messageId, value.tokens]),
    );
  });
  const assistantActivities = createMemo(() => {
    const byMessage = new Map<string, Array<AssistantActivity & { seq: number }>>();
    for (const row of allMessageParts() as MessagePart[]) {
      const activity = parseAssistantActivity(row);
      if (!activity) continue;
      const list = byMessage.get(row.messageId) ?? [];
      list.push({
        ...activity,
        seq: row.seq,
      });
      byMessage.set(row.messageId, list);
    }

    for (const list of byMessage.values()) {
      list.sort((a, b) => a.seq - b.seq);
    }
    return byMessage;
  });

  // Auto-scroll only when user is already near the bottom
  createEffect(() => {
    const _messageIds = messageIds();
    const _activities = assistantActivities();
    if (timelineRef && isNearBottom()) {
      requestAnimationFrame(() => {
        timelineRef!.scrollTop = timelineRef!.scrollHeight;
      });
    }
  });

  const traceRunsByMessage = createMemo(() => {
    const byMessage = new Map<string, TraceRun[]>();
    for (const row of allTraceRuns() as TraceRun[]) {
      if (!row.messageId) continue;
      const list = byMessage.get(row.messageId) ?? [];
      list.push(row);
      byMessage.set(row.messageId, list);
    }
    for (const list of byMessage.values()) {
      list.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    }
    return byMessage;
  });
  const traceSpansByRun = createMemo(() => {
    const byRun = new Map<string, TraceSpan[]>();
    for (const row of allTraceSpans() as TraceSpan[]) {
      if (!row.traceRunId) continue;
      const list = byRun.get(row.traceRunId) ?? [];
      list.push(row);
      byRun.set(row.traceRunId, list);
    }
    for (const list of byRun.values()) {
      list.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    }
    return byRun;
  });

  const thinkingTokens = (messageId: string) => thinkingTokensByMessage().get(messageId) ?? null;
  const activitiesForMessage = (messageId: string) => assistantActivities().get(messageId) ?? [];
  const isWaitingForVisibleAnswer = (message: any) =>
    message.role === "assistant" &&
    (message.status === "queued" ||
      message.status === "pending" ||
      message.status === "streaming") &&
    !message.text?.trim();
  const hasAssistantPrelude = (message: any) =>
    message.role === "assistant" &&
    (activitiesForMessage(message.id).length > 0 ||
      isWaitingForVisibleAnswer(message) ||
      thinkingTokens(message.id) != null ||
      traceRunsForMessage(message.id).length > 0);
  const hasAssistantStats = (message: any) =>
    message.role === "assistant" &&
    (thinkingTokens(message.id) != null ||
      message.promptTokens != null ||
      message.ttftMs != null ||
      message.durationMs != null ||
      message.completionTokens != null);
  const hasAssistantAnswerCard = (message: any) =>
    message.role === "assistant" &&
    (Boolean(message.text?.trim()) ||
      message.status === "failed" ||
      (searchRunsMemo().get(message.id)?.length ?? 0) > 0 ||
      hasAssistantStats(message));
  const thinkingLabel = (messageId: string) => {
    const tokens = thinkingTokens(messageId);
    return tokens != null ? `${formatTokenCount(tokens)} thinking tokens` : "Thinking…";
  };
  const isAssistantPreludeCollapsed = (messageId: string) =>
    collapsedProgressByMessage[messageId] ?? false;
  const toggleAssistantPrelude = (messageId: string) =>
    setCollapsedProgressByMessage(messageId, !isAssistantPreludeCollapsed(messageId));
  const assistantPreludeSummary = (message: any) => {
    const parts: string[] = [];
    const activities = activitiesForMessage(message.id);
    const tokens = thinkingTokens(message.id);

    if (activities.length > 0) {
      parts.push(`${activities.length} step${activities.length === 1 ? "" : "s"}`);
    }
    if (tokens != null) {
      parts.push(`${formatTokenCount(tokens)} thinking tokens`);
    }
    if (traceRunsForMessage(message.id).length > 0) {
      parts.push(`trace ${traceRunsForMessage(message.id).length}`);
    }
    if (isWaitingForVisibleAnswer(message)) {
      parts.push("live");
    }

    return parts.join(" • ") || "Live model activity";
  };
  const assistantError = (message: Message) =>
    explainAssistantError({
      errorCode: message.errorCode,
      errorMessage: message.errorMessage,
    });
  const assistantProgressFailureSummary = (message: Message, activity: AssistantActivity) => {
    if (
      activity.state !== "failed" ||
      activity.label !== "Response failed" ||
      message.status !== "failed"
    ) {
      return null;
    }
    return assistantError(message).summary;
  };
  const isTraceCollapsed = (messageId: string) => collapsedTraceByMessage[messageId] ?? true;
  const toggleTraceDrawer = (messageId: string) =>
    setCollapsedTraceByMessage(messageId, !isTraceCollapsed(messageId));
  const traceRunsForMessage = (messageId: string) => traceRunsByMessage().get(messageId) ?? [];
  const traceTreesForMessage = (messageId: string) =>
    traceRunsForMessage(messageId).map((run) => ({
      run,
      spans: buildTraceTree(traceSpansByRun().get(run.id) ?? []),
      attrs: parseTraceJson(run.attrsJson),
    }));

  createEffect(() => {
    for (const messageId of messageIds()) {
      const message = messageById(messageId);
      if (!message) continue;
      if (
        message.role !== "assistant" ||
        !hasAssistantPrelude(message) ||
        !message.text?.trim() ||
        didAutoCollapseProgressByMessage[message.id]
      ) {
        continue;
      }
      setCollapsedProgressByMessage(message.id, true);
      setDidAutoCollapseProgressByMessage(message.id, true);
    }
  });

  const userAttachments = (messageId: string) => {
    return (allAttachments() as Attachment[]).filter(
      (a) => a.messageId === messageId && a.status !== "failed",
    );
  };
  const userImageAttachments = (messageId: string) =>
    userAttachments(messageId).filter((attachment) => isImageMime(attachment.mimeType));
  const userFileAttachments = (messageId: string) =>
    userAttachments(messageId).filter((attachment) => !isImageMime(attachment.mimeType));

  const renderMessage = (messageId: string) => {
    const message = () => messageById(messageId);

    return (
      <Show when={message()}>
        {(message) => (
          <article
            classList={{
              msg: true,
              assistant: message().role === "assistant",
              user: message().role === "user",
            }}
          >
            <div class="msg-meta">
              <span class="msg-role">{message().role === "assistant" ? "AI" : "You"}</span>
              <Show when={message().status && message().status !== "completed"}>
                <span class="msg-status">{message().status}</span>
              </Show>
            </div>
            <Show
              when={message().role === "assistant"}
              fallback={
                <div class="msg-user-row">
                  <div class="msg-user-actions">
                    <button
                      type="button"
                      class="msg-action-btn"
                      aria-label="Edit and regenerate from this point"
                      title="Edit and regenerate from this point"
                      disabled={isSelectedThreadBusy()}
                      onClick={() => startEditingUserMessage(message())}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      class="msg-action-btn"
                      aria-label="Retry from this point with original settings"
                      title="Retry from this point with original settings"
                      disabled={isSelectedThreadBusy()}
                      onClick={() => retryMessage(message())}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                      >
                        <polyline points="1 4 1 10 7 10" />
                        <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                      </svg>
                    </button>
                  </div>
                  <div class="msg-user-stack">
                    <Show when={userImageAttachments(message().id).length > 0}>
                      <div class="msg-attachment-gallery">
                        <For each={userImageAttachments(message().id)}>
                          {(att: any) => (
                            <a
                              class="msg-attachment-card"
                              href={`/api/uploads/blob/${att.objectKey}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <img
                                class="msg-attachment-img"
                                src={`/api/uploads/blob/${att.objectKey}`}
                                alt={att.fileName}
                                loading="lazy"
                              />
                            </a>
                          )}
                        </For>
                      </div>
                    </Show>
                    <Show
                      when={editingUserMessageId() === message().id}
                      fallback={
                        <Show when={message().text?.trim()}>
                          <div class="msg-user-body">
                            <p>{message().text}</p>
                          </div>
                        </Show>
                      }
                    >
                      <div class="msg-edit-form">
                        <textarea
                          value={editingUserMessageText()}
                          onInput={(e) => setEditingUserMessageText(e.currentTarget.value)}
                          onKeyDown={(e) => {
                            if (e.isComposing) return;
                            if (e.key === "Escape") {
                              e.preventDefault();
                              cancelEditingUserMessage();
                              return;
                            }
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              commitUserMessageEdit(message());
                            }
                          }}
                        />
                        <div class="msg-edit-actions">
                          <button type="button" onClick={cancelEditingUserMessage}>
                            Cancel
                          </button>
                          <button type="button" onClick={() => commitUserMessageEdit(message())}>
                            Save
                          </button>
                        </div>
                      </div>
                    </Show>
                    <Show when={userFileAttachments(message().id).length > 0}>
                      <div class="msg-attachments msg-attachments-files">
                        <For each={userFileAttachments(message().id)}>
                          {(att: any) => <span class="msg-attachment-file">{att.fileName}</span>}
                        </For>
                      </div>
                    </Show>
                  </div>
                </div>
              }
            >
              <Show when={hasAssistantPrelude(message())}>
                <div class="assistant-progress-shell">
                  <button
                    type="button"
                    class="assistant-progress-toggle"
                    aria-expanded={!isAssistantPreludeCollapsed(message().id)}
                    aria-controls={`assistant-progress-${message().id}`}
                    onClick={() => toggleAssistantPrelude(message().id)}
                  >
                    <span class="assistant-progress-toggle-copy">
                      <span class="assistant-progress-toggle-label">Model activity</span>
                      <span class="assistant-progress-toggle-meta">
                        {assistantPreludeSummary(message())}
                      </span>
                    </span>
                    <span
                      classList={{
                        "assistant-progress-toggle-chevron": true,
                        "is-collapsed": isAssistantPreludeCollapsed(message().id),
                      }}
                      aria-hidden="true"
                    >
                      ▾
                    </span>
                  </button>
                  <Show when={!isAssistantPreludeCollapsed(message().id)}>
                    <div class="assistant-progress-stack" id={`assistant-progress-${message().id}`}>
                      <Show when={activitiesForMessage(message().id).length > 0}>
                        <div class="assistant-progress">
                          <Index each={activitiesForMessage(message().id)}>
                            {(activity) => {
                              const searchRunResults = () => {
                                if (activity().state !== "completed" || activity().step == null)
                                  return null;
                                const runs = searchRunsMemo().get(message().id) ?? [];
                                const run = runs.find((r) => r.step === activity().step);
                                if (!run || run.results.length === 0) return null;
                                let offset = 0;
                                for (const r of runs) {
                                  if (r.step < run.step) offset += r.results.length;
                                }
                                return { results: run.results, startIndex: offset + 1 };
                              };

                              return (
                                <div
                                  classList={{
                                    "assistant-progress-item": true,
                                    "is-active": activity().state === "active",
                                    "is-failed": activity().state === "failed",
                                  }}
                                >
                                  <span class="assistant-progress-marker" aria-hidden="true" />
                                  <div class="assistant-progress-copy">
                                    <span>{activity().label}</span>
                                    <Show
                                      when={assistantProgressFailureSummary(message(), activity())}
                                    >
                                      {(summary) => (
                                        <span class="assistant-progress-detail">{summary()}</span>
                                      )}
                                    </Show>
                                    <Show when={searchRunResults()}>
                                      {(data) => (
                                        <div class="search-results-inline">
                                          <Index each={data().results}>
                                            {(result, idx) => (
                                              <a
                                                class="search-result-link"
                                                href={result().url}
                                                target="_blank"
                                                rel="noreferrer"
                                              >
                                                <span class="search-result-num">
                                                  {data().startIndex + idx}
                                                </span>
                                                <span class="search-result-title">
                                                  {result().title}
                                                </span>
                                                <span class="search-result-domain">
                                                  {result().domain}
                                                </span>
                                              </a>
                                            )}
                                          </Index>
                                        </div>
                                      )}
                                    </Show>
                                  </div>
                                </div>
                              );
                            }}
                          </Index>
                        </div>
                      </Show>
                      <Show
                        when={
                          isWaitingForVisibleAnswer(message()) ||
                          thinkingTokens(message().id) != null
                        }
                      >
                        <div
                          classList={{
                            "thinking-indicator": true,
                            "is-complete":
                              !isWaitingForVisibleAnswer(message()) &&
                              thinkingTokens(message().id) != null,
                          }}
                        >
                          <Show
                            when={isWaitingForVisibleAnswer(message())}
                            fallback={
                              <span
                                class="assistant-progress-marker thinking-indicator-marker"
                                aria-hidden="true"
                              />
                            }
                          >
                            <span class="thinking-spinner" />
                          </Show>
                          <span>{thinkingLabel(message().id)}</span>
                        </div>
                      </Show>
                      <Show when={traceRunsForMessage(message().id).length > 0}>
                        <div class="trace-shell">
                          <button
                            type="button"
                            class="trace-toggle"
                            aria-expanded={!isTraceCollapsed(message().id)}
                            aria-controls={`trace-drawer-${message().id}`}
                            onClick={() => toggleTraceDrawer(message().id)}
                          >
                            <span class="trace-toggle-copy">
                              <span class="trace-toggle-label">Trace</span>
                              <span class="trace-toggle-meta">
                                {traceTreesForMessage(message().id)[0]?.run
                                  ? `${formatTraceStatus(traceTreesForMessage(message().id)[0]!.run.status)} • ${shortTraceId(traceTreesForMessage(message().id)[0]!.run.traceId)}`
                                  : "Developer trace"}
                              </span>
                            </span>
                            <span
                              classList={{
                                "assistant-progress-toggle-chevron": true,
                                "is-collapsed": isTraceCollapsed(message().id),
                              }}
                              aria-hidden="true"
                            >
                              ▾
                            </span>
                          </button>
                          <Show when={!isTraceCollapsed(message().id)}>
                            <div class="trace-drawer" id={`trace-drawer-${message().id}`}>
                              <For each={traceTreesForMessage(message().id)}>
                                {(trace) => (
                                  <div class="trace-run-card">
                                    <div class="trace-run-header">
                                      <span class="trace-run-id">
                                        trace {shortTraceId(trace.run.traceId)}
                                      </span>
                                      <span class="trace-run-badges">
                                        <span>{formatTraceStatus(trace.run.status)}</span>
                                        <Show when={trace.run.modelId}>
                                          <span>{trace.run.modelId}</span>
                                        </Show>
                                        <Show when={trace.attrs.searchEnabled === true}>
                                          <span>search</span>
                                        </Show>
                                        <Show when={trace.run.durationMs != null}>
                                          <span>{formatDuration(trace.run.durationMs!)}</span>
                                        </Show>
                                      </span>
                                    </div>
                                    <Show when={trace.run.errorMessage}>
                                      <div class="trace-run-error">{trace.run.errorMessage}</div>
                                    </Show>
                                    <Show when={trace.spans.length > 0}>
                                      <div class="trace-tree">
                                        <For each={trace.spans}>
                                          {(span) => <TraceSpanTree span={span} />}
                                        </For>
                                      </div>
                                    </Show>
                                  </div>
                                )}
                              </For>
                            </div>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  </Show>
                </div>
              </Show>
              <Show when={hasAssistantAnswerCard(message())}>
                <div class="assistant-answer-card">
                  <Show when={message().text?.trim()}>
                    {(() => {
                      const cites = () => citationsForMessage(message().id);
                      return (
                        <Show
                          when={message().status === "streaming"}
                          fallback={<Markdown text={message().text} citations={cites()} />}
                        >
                          <Markdown text={message().text} streaming citations={cites()} />
                        </Show>
                      );
                    })()}
                  </Show>
                  <Show when={message().status === "failed"}>
                    <div class="assistant-error-card" role="alert">
                      <div class="assistant-error-title">{assistantError(message()).title}</div>
                      <div class="assistant-error-summary">{assistantError(message()).summary}</div>
                      <p class="assistant-error-explanation">
                        {assistantError(message()).explanation}
                      </p>
                      <details class="assistant-error-details">
                        <summary>Technical details</summary>
                        <pre>{assistantError(message()).details}</pre>
                      </details>
                    </div>
                  </Show>
                  <Show when={hasAssistantStats(message())}>
                    <div class="msg-stats">
                      <Show when={thinkingTokens(message().id)}>
                        <span>
                          {formatTokenCount(thinkingTokens(message().id)!)} thinking tokens
                        </span>
                      </Show>
                      <Show when={getTotalTokens(message()) != null}>
                        <span>{formatTokenCount(getTotalTokens(message())!)} total tokens</span>
                      </Show>
                      <Show when={message().promptTokens != null}>
                        <span>{formatTokenCount(message().promptTokens!)} prompt</span>
                      </Show>
                      <Show when={message().completionTokens != null}>
                        <span>{formatTokenCount(message().completionTokens!)} output</span>
                      </Show>
                      <Show when={message().ttftMs != null}>
                        <span>TTFT {message().ttftMs}ms</span>
                      </Show>
                      <Show when={message().durationMs != null}>
                        <span>{formatDuration(message().durationMs!)}</span>
                      </Show>
                      <Show
                        when={
                          message().completionTokens != null &&
                          message().durationMs != null &&
                          message().durationMs! > 0
                        }
                      >
                        <span>
                          {((message().completionTokens! / message().durationMs!) * 1000).toFixed(
                            1,
                          )}{" "}
                          tok/s
                        </span>
                      </Show>
                      <Show when={message().modelId}>
                        <span class="msg-stats-model">{message().modelId}</span>
                      </Show>
                    </div>
                  </Show>
                </div>
              </Show>
            </Show>
          </article>
        )}
      </Show>
    );
  };

  const signIn = async () => {
    await authClient.signIn.social({
      provider: "google",
      callbackURL: "/",
    });
  };

  const createNewWorkspace = async () => {
    createWorkspaceAction(`Workspace ${workspaces().length + 1}`, {
      defaultModelId: composerModelId() || models()?.models?.[0]?.id || "auto",
      defaultReasoningLevel: composerReasoningLevel(),
      defaultSearchMode: composerSearch(),
    });
  };

  const createNewThread = async () => {
    const workspace = activeWorkspace();
    if (!workspace) return;
    ensureWorkspaceDraft({
      workspace,
      modelId: composerModelId() || workspace.defaultModelId || models()?.models?.[0]?.id || "auto",
      reasoningLevel: composerReasoningLevel(),
      search: composerSearch(),
    });
    activateWorkspaceDraftView(workspace.id);
    setSidebarOpen(false);
  };

  const deleteThread = async (threadId: string) => {
    archiveThreadAction(threadId);
  };

  const requestWorkspaceDelete = (workspaceId: string, workspaceName: string) => {
    if (workspaces().length <= 1) return;
    setWorkspaceDeleteTarget({ id: workspaceId, name: workspaceName });
  };

  const closeWorkspaceDeleteModal = () => {
    setWorkspaceDeleteTarget(null);
  };

  const confirmWorkspaceDelete = () => {
    const target = workspaceDeleteTarget();
    if (!target) return;
    if (editingWorkspaceId() === target.id) {
      setEditingWorkspaceId(null);
      setEditValue("");
    }
    archiveWorkspaceAction(target.id);
    setWorkspaceDeleteTarget(null);
  };

  // Inline rename helpers
  const startEditingThread = (threadId: string, currentTitle: string) => {
    setEditingThreadId(threadId);
    setEditValue(currentTitle);
  };

  const commitThreadRename = (threadId: string) => {
    const newTitle = editValue().trim();
    setEditingThreadId(null);
    if (!newTitle || newTitle === "") return;
    const row = threadsCollection.get(threadId) as Thread | undefined;
    if (!row || row.title === newTitle) return;
    updateThreadAction({ ...row, title: newTitle, updatedAt: nowIso() });
  };

  const startEditingWorkspace = (workspaceId: string, currentName: string) => {
    setEditingWorkspaceId(workspaceId);
    setEditValue(currentName);
  };

  const commitWorkspaceRename = (workspaceId: string) => {
    const newName = editValue().trim();
    setEditingWorkspaceId(null);
    if (!newName || newName === "") return;
    const row = workspacesCollection.get(workspaceId) as Workspace | undefined;
    if (!row || row.name === newName) return;
    updateWorkspaceAction({ ...row, name: newName, updatedAt: nowIso() });
  };

  const saveSystemPrompt = () => {
    const workspace = activeWorkspace();
    if (!workspace) return;
    const row = workspacesCollection.get(workspace.id) as Workspace | undefined;
    if (!row) return;
    updateWorkspaceAction({
      ...row,
      systemPrompt: systemPromptDraft(),
      updatedAt: nowIso(),
    });
    setSettingsOpen(false);
  };

  const updateWorkspacePreferences = (
    changes: Partial<
      Pick<Workspace, "defaultModelId" | "defaultReasoningLevel" | "defaultSearchMode">
    >,
  ) => {
    const workspace = activeWorkspace();
    if (!workspace) return;
    updateWorkspaceAction({
      ...workspace,
      ...changes,
      updatedAt: nowIso(),
    });
  };

  const handleModelChange = (modelId: string) => {
    const workspace = activeWorkspace();
    if (workspace && isDraftViewActive()) {
      updateWorkspaceDraft(workspace.id, (draft) => ({
        ...draft,
        modelId,
        updatedAt: nowIso(),
      }));
    } else {
      setComposer("modelId", modelId);
    }
    updateWorkspacePreferences({ defaultModelId: modelId });
  };

  const handleSearchChange = (search: boolean) => {
    const workspace = activeWorkspace();
    if (workspace && isDraftViewActive()) {
      updateWorkspaceDraft(workspace.id, (draft) => ({
        ...draft,
        search,
        updatedAt: nowIso(),
      }));
    } else {
      setComposer("search", search);
    }
    updateWorkspacePreferences({ defaultSearchMode: search });
  };

  const handleReasoningChange = (reasoningLevel: ReasoningLevel) => {
    const workspace = activeWorkspace();
    if (workspace && isDraftViewActive()) {
      updateWorkspaceDraft(workspace.id, (draft) => ({
        ...draft,
        reasoningLevel,
        updatedAt: nowIso(),
      }));
    } else {
      setComposer("reasoningLevel", reasoningLevel);
    }
    updateWorkspacePreferences({ defaultReasoningLevel: reasoningLevel });
  };

  const isSelectedThreadBusy = createMemo(() => {
    const thread = selectedConversationThread();
    return thread ? streamingThreadIds().has(thread.id) : false;
  });

  const startEditingUserMessage = (msg: Message) => {
    if (isSelectedThreadBusy()) return;
    setEditingUserMessageId(msg.id);
    setEditingUserMessageText(msg.text);
  };

  const cancelEditingUserMessage = () => {
    setEditingUserMessageId(null);
    setEditingUserMessageText("");
  };

  const commitUserMessageEdit = (msg: Message) => {
    const thread = selectedConversationThread();
    const text = editingUserMessageText().trim();
    cancelEditingUserMessage();
    if (!thread || !text || text === msg.text.trim()) return;
    const attachmentIds = userAttachments(msg.id)
      .filter((attachment) => attachment.status === "ready")
      .map((attachment) => attachment.id);
    editUserMessageAction({
      thread,
      sourceMessage: msg,
      text,
      modelId:
        msg.modelId || activeWorkspace()?.defaultModelId || models()?.models?.[0]?.id || "auto",
      modelInterleavedField: modelInterleavedFieldFor(msg.modelId),
      reasoningLevel: (msg.reasoningLevel ?? "off") as ReasoningLevel,
      search: Boolean(msg.searchEnabled),
      attachmentIds,
    });
  };

  const retryMessage = (msg: Message) => {
    const thread = selectedConversationThread();
    if (!thread || !msg.text?.trim() || isSelectedThreadBusy()) return;
    retryMessageAction({
      thread,
      userMessage: msg,
      modelId:
        msg.modelId || activeWorkspace()?.defaultModelId || models()?.models?.[0]?.id || "auto",
      modelInterleavedField: modelInterleavedFieldFor(msg.modelId),
      reasoningLevel: (msg.reasoningLevel ?? "off") as ReasoningLevel,
      search: Boolean(msg.searchEnabled),
    });
  };

  const sendMessage = async () => {
    const thread = selectedConversationThread();
    const workspace = activeWorkspace();
    const draftMode = isDraftViewActive();
    console.log("[send] attempt", {
      activeThread: thread,
      activeWorkspace: workspace,
      text: composerText().trim(),
      attachments: composerAttachments().length,
      sending: composer.sending,
      workspacesCount: workspaces().length,
      threadsCount: threads().length,
    });
    if (
      !thread ||
      (!composerText().trim() && composerAttachments().length === 0) ||
      composer.sending
    ) {
      console.log("[send] blocked", {
        noThread: !thread,
        noContent: !composerText().trim() && composerAttachments().length === 0,
        alreadySending: composer.sending,
      });
      return;
    }
    setComposer("sending", true);
    try {
      const text = composerText().trim();
      const attachmentIds = composerAttachments()
        .filter((a) => a.status === "ready" && a.attachmentId)
        .map((a) => a.attachmentId!);
      sendMessageAction({
        thread,
        text,
        modelId:
          composerModelId() || workspace?.defaultModelId || models()?.models?.[0]?.id || "auto",
        modelInterleavedField: selectedModelInterleavedField(),
        reasoningLevel: effectiveComposerReasoningLevel(),
        search: composerSearch(),
        attachmentIds,
      });
      for (const att of composerAttachments()) {
        if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
      }
      if (draftMode && workspace) {
        finalizeWorkspaceDraft(workspace.id);
        activateWorkspaceThreadView(workspace.id);
        setActiveThreadId(thread.id);
      } else {
        setComposer("text", "");
        setComposer("attachments", []);
      }
    } finally {
      setComposer("sending", false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  return (
    <Show
      when={session()}
      fallback={
        <main class="auth-shell">
          <section class="auth-card">
            <p class="eyebrow">Personal deployment</p>
            <h1>b3 chat</h1>
            <p>Sign in with Google to continue.</p>
            <p class="app-version" title={BUILD_INFO.tooltip}>
              {BUILD_INFO.label}
            </p>
            <button class="btn btn-primary" onClick={signIn}>
              Continue with Google
            </button>
          </section>
        </main>
      }
    >
      <div class="shell">
        <Show when={sidebarOpen()}>
          <div class="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
        </Show>
        <aside classList={{ sidebar: true, open: sidebarOpen() }}>
          <div class="sidebar-top">
            <div class="brand">
              <span class="brand-mark">b3</span>
              <div style="min-width:0">
                <h1>b3.chat</h1>
                <p class="brand-email">{session()?.user?.email}</p>
              </div>
            </div>
            <div class="sidebar-actions">
              <button class="btn btn-primary" onClick={createNewThread}>
                + Chat
              </button>
              <button class="btn" onClick={createNewWorkspace}>
                + Space
              </button>
            </div>
          </div>

          <div class="sidebar-scroll">
            <p class="section-label">Workspaces</p>
            <For each={workspaces()}>
              {(workspace) => (
                <div
                  classList={{
                    "nav-item": true,
                    active: workspace.id === activeWorkspace()?.id,
                  }}
                  onClick={() => {
                    if (editingWorkspaceId() === workspace.id) return;
                    setActiveWorkspaceId(workspace.id);
                    const wsThreads = (allThreads() as Thread[])
                      .filter((t) => t.workspaceId === workspace.id && !t.archivedAt)
                      .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
                    if (wsThreads[0]) {
                      setActiveThreadId(wsThreads[0].id);
                    }
                    setSidebarOpen(false);
                  }}
                >
                  <Show
                    when={editingWorkspaceId() === workspace.id}
                    fallback={
                      <div class="nav-item-row">
                        <strong>{workspace.name}</strong>
                        <div class="nav-item-actions">
                          <button
                            class="action-btn"
                            title="Rename workspace"
                            onClick={(e) => {
                              e.stopPropagation();
                              startEditingWorkspace(workspace.id, workspace.name);
                            }}
                          >
                            ✎
                          </button>
                          <Show when={workspaces().length > 1}>
                            <button
                              class="action-btn action-btn-danger"
                              title="Delete workspace"
                              onClick={(e) => {
                                e.stopPropagation();
                                requestWorkspaceDelete(workspace.id, workspace.name);
                              }}
                            >
                              ×
                            </button>
                          </Show>
                        </div>
                      </div>
                    }
                  >
                    <input
                      class="inline-edit"
                      value={editValue()}
                      onInput={(e) => setEditValue(e.currentTarget.value)}
                      onBlur={() => commitWorkspaceRename(workspace.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitWorkspaceRename(workspace.id);
                        if (e.key === "Escape") setEditingWorkspaceId(null);
                      }}
                      ref={(el) => requestAnimationFrame(() => el.focus())}
                    />
                  </Show>
                </div>
              )}
            </For>

            <For each={groupThreadsByDate(threads())}>
              {(group) => (
                <>
                  <p class="section-label">{group.label}</p>
                  <For each={group.threads}>
                    {(thread) => (
                      <div
                        classList={{
                          "nav-item": true,
                          active: !isDraftViewActive() && thread.id === activeThread()?.id,
                        }}
                        onClick={() => {
                          if (editingThreadId() === thread.id) return;
                          activateWorkspaceThreadView(thread.workspaceId);
                          setActiveThreadId(thread.id);
                          setSidebarOpen(false);
                        }}
                      >
                        <Show
                          when={editingThreadId() === thread.id}
                          fallback={
                            <div class="nav-item-row">
                              <Show when={streamingThreadIds().has(thread.id)}>
                                <span class="thread-spinner" />
                              </Show>
                              <strong>{thread.title}</strong>
                              <div class="nav-item-actions">
                                <span
                                  class="action-btn"
                                  title="Rename thread"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    startEditingThread(thread.id, thread.title);
                                  }}
                                >
                                  ✎
                                </span>
                                <span
                                  class="action-btn action-btn-danger"
                                  title="Delete thread"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void deleteThread(thread.id);
                                  }}
                                >
                                  ×
                                </span>
                              </div>
                            </div>
                          }
                        >
                          <input
                            class="inline-edit"
                            value={editValue()}
                            onInput={(e) => setEditValue(e.currentTarget.value)}
                            onBlur={() => commitThreadRename(thread.id)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitThreadRename(thread.id);
                              if (e.key === "Escape") setEditingThreadId(null);
                            }}
                            ref={(el) => requestAnimationFrame(() => el.focus())}
                          />
                        </Show>
                      </div>
                    )}
                  </For>
                </>
              )}
            </For>
          </div>

          <div class="sidebar-footer">
            <div class="sidebar-footer-controls">
              <For each={THEMES}>
                {(t) => (
                  <button
                    classList={{ "theme-btn": true, active: theme() === t.id }}
                    onClick={() => setTheme(t.id)}
                  >
                    {t.label}
                  </button>
                )}
              </For>
              <button
                classList={{ "theme-btn": true, active: settingsOpen() }}
                onClick={() => {
                  setSettingsOpen(!settingsOpen());
                  setSidebarOpen(false);
                }}
                title="Settings"
              >
                ⚙
              </button>
            </div>
            <div class="sidebar-version" title={BUILD_INFO.tooltip}>
              {BUILD_INFO.label}
            </div>
          </div>
        </aside>

        <main class="main-pane">
          <Show
            when={!settingsOpen()}
            fallback={
              <div class="settings-page">
                <header class="settings-header">
                  <button class="btn" onClick={() => setSettingsOpen(false)}>
                    ← Back
                  </button>
                  <h2>Settings</h2>
                  <span class="settings-workspace">{activeWorkspace()?.name}</span>
                </header>
                <div class="settings-body">
                  <div class="settings-section">
                    <label class="settings-label">System Prompt</label>
                    <p class="settings-hint">
                      Instructions prepended to every conversation in this workspace.
                    </p>
                    <textarea
                      class="settings-textarea"
                      value={systemPromptDraft()}
                      onInput={(e) => setSystemPromptDraft(e.currentTarget.value)}
                      placeholder="You are a helpful assistant..."
                      rows={8}
                    />
                  </div>
                  <div class="settings-actions">
                    <button class="btn" onClick={() => setSettingsOpen(false)}>
                      Cancel
                    </button>
                    <button class="btn btn-primary" onClick={saveSystemPrompt}>
                      Save
                    </button>
                  </div>

                  <div class="settings-section settings-danger">
                    <label class="settings-label">Danger Zone</label>
                    <p class="settings-hint">
                      Wipe all data on server and locally. Start completely fresh.
                    </p>
                    <button
                      class="btn btn-danger"
                      onClick={() => {
                        if (confirm("Delete ALL data? This cannot be undone.")) {
                          resetAllData();
                        }
                      }}
                    >
                      Reset All Data
                    </button>
                  </div>
                </div>
              </div>
            }
          >
            <header class="thread-header">
              <button class="menu-btn" onClick={() => setSidebarOpen(true)}>
                ☰
              </button>
              <span class="workspace-label">{activeWorkspace()?.name}</span>
              <h2>{selectedConversationThread()?.title ?? "New Chat"}</h2>
              <Show when={activeWorkspace()?.systemPrompt}>
                <span class="system-prompt" title={activeWorkspace()?.systemPrompt}>
                  {activeWorkspace()?.systemPrompt}
                </span>
              </Show>
            </header>

            <section class="timeline" ref={timelineRef} onScroll={handleTimelineScroll}>
              <For each={messageIds()}>{renderMessage}</For>
            </section>

            <Show when={showScrollBtn()}>
              <button class="scroll-to-bottom" onClick={scrollToBottom} title="Scroll to bottom">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M8 3v10M4 9l4 4 4-4"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
            </Show>

            <footer
              class="composer"
              classList={{ "composer-dragging": isDragging() }}
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
            >
              <Show when={composerAttachments().length > 0}>
                <div class="attachment-strip">
                  <For each={composerAttachments()}>
                    {(att) => (
                      <div
                        class="attachment-chip"
                        classList={{
                          "attachment-chip-uploading": att.status === "uploading",
                          "attachment-chip-failed": att.status === "failed",
                        }}
                      >
                        <Show
                          when={att.previewUrl}
                          fallback={
                            <span class="attachment-chip-ext">
                              {att.fileName.split(".").pop()?.toUpperCase().slice(0, 4) || "FILE"}
                            </span>
                          }
                        >
                          <img class="attachment-chip-thumb" src={att.previewUrl} alt="" />
                        </Show>
                        <span class="attachment-chip-name">{att.fileName}</span>
                        <Show when={att.status === "uploading"}>
                          <span class="attachment-chip-spinner" />
                        </Show>
                        <button
                          class="attachment-chip-remove"
                          onClick={() => removeAttachment(att.localId)}
                          title="Remove"
                        >
                          ×
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
              <textarea
                value={composerText()}
                onInput={(event) => setComposerTextValue(event.currentTarget.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={
                  composerAttachments().length > 0 ? "Add a message (optional)..." : "Message..."
                }
              />
              <div class="composer-bar">
                <button
                  class="attach-btn"
                  onClick={() => fileInputRef?.click()}
                  title="Attach files"
                >
                  +
                </button>
                <input
                  ref={fileInputRef!}
                  type="file"
                  multiple
                  accept="image/*,text/*,.json,.csv,.pdf"
                  style={{ display: "none" }}
                  onChange={(e) => handleFileSelect(e.currentTarget.files)}
                />
                <select
                  value={composerModelId()}
                  onChange={(event) => handleModelChange(event.currentTarget.value)}
                >
                  <For each={models()?.models ?? []}>
                    {(model) => <option value={model.id}>{model.name}</option>}
                  </For>
                </select>
                <Show when={selectedModelSupportsReasoning()}>
                  <select
                    value={composerReasoningLevel()}
                    title="Reasoning level"
                    aria-label="Reasoning level"
                    onChange={(event) =>
                      handleReasoningChange(event.currentTarget.value as ReasoningLevel)
                    }
                  >
                    <For each={REASONING_OPTIONS}>
                      {(option) => <option value={option.value}>{option.label}</option>}
                    </For>
                  </select>
                </Show>
                <label class="search-toggle">
                  <input
                    type="checkbox"
                    checked={composerSearch()}
                    onChange={(event) => handleSearchChange(event.currentTarget.checked)}
                  />
                  Search
                </label>
                <span class="kbd-hint">Enter to send</span>
                <button
                  class="btn btn-primary"
                  disabled={
                    composer.sending ||
                    composerAttachments().some((attachment) => attachment.status === "uploading")
                  }
                  onClick={sendMessage}
                >
                  {composer.sending ? "Sending…" : "Send"}
                </button>
              </div>
              <Show when={willDisableReasoningForToolTurn()}>
                <p class="composer-note">
                  Thinking will be disabled for this turn because this model requires interleaved
                  reasoning replay
                  {selectedModelInterleavedField() ? ` (${selectedModelInterleavedField()})` : ""}
                  across tool calls, and this app does not preserve that field.
                </p>
              </Show>
            </footer>
          </Show>
        </main>
        <Show when={workspaceDeleteTarget()}>
          {(target) => (
            <div class="modal-backdrop" onClick={closeWorkspaceDeleteModal}>
              <div
                class="modal-card"
                role="dialog"
                aria-modal="true"
                aria-labelledby="workspace-delete-title"
                onClick={(e) => e.stopPropagation()}
              >
                <h3 id="workspace-delete-title">Delete workspace?</h3>
                <p class="modal-copy">
                  <strong>{target().name}</strong> will be removed from your sidebar. This action
                  cannot be undone.
                </p>
                <div class="modal-actions">
                  <button class="btn" onClick={closeWorkspaceDeleteModal}>
                    Cancel
                  </button>
                  <button class="btn btn-danger" onClick={confirmWorkspaceDelete}>
                    Delete workspace
                  </button>
                </div>
              </div>
            </div>
          )}
        </Show>
      </div>
    </Show>
  );
}
