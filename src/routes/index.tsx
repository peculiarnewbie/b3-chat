import {
  For,
  Index,
  Match,
  Show,
  Switch,
  createEffect,
  lazy,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  Suspense,
} from "solid-js";
import { createStore } from "solid-js/store";
import { useLiveQuery } from "@tanstack/solid-db";
import { createId, nowIso, resolveThreadMessagePath } from "@b3-chat/domain";
import type {
  Attachment,
  ExtractRun,
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
import type { Citation } from "../components/Markdown";
import type { TraceDrawerTrace } from "../components/TraceDrawerContent";
import { explainAssistantError } from "../lib/assistant-errors";
import { BUILD_INFO } from "../lib/build-info";
import { ensureThemeFont } from "../lib/theme-fonts";
import { isAllowedFile, isImageMime, uploadFile } from "../lib/upload";
import {
  workspaces as workspacesCollection,
  threads as threadsCollection,
  messages as messagesCollection,
  messageParts as messagePartsCollection,
  attachments as attachmentsCollection,
  searchRuns as searchRunsCollection,
  searchResults as searchResultsCollection,
  extractRuns as extractRunsCollection,
  traceRuns as traceRunsCollection,
  traceSpans as traceSpansCollection,
} from "../lib/collections";
import {
  createWorkspaceAction,
  archiveThreadAction,
  archiveWorkspaceAction,
  updateThreadAction,
  updateWorkspaceAction,
  cancelAssistantTurnAction,
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
import { start as startConnection, isConnected } from "../lib/ws-connection";
import { init as initSyncAdapter } from "../lib/sync-adapter";

type SessionPayload = {
  user?: {
    email?: string;
  };
};

type BootstrapPayload = {
  session: SessionPayload | null;
  models: ModelsPayload | null;
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
  /**
   * Which tool produced this activity. Missing on older parts (pre-extract
   * wiring) or on non-tool activities like "Response failed"; we treat
   * missing-with-a-step as `search` for back-compat, and missing-without-a-
   * step as a generic activity.
   */
  tool: "search" | "extract" | null;
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

type TraceTreeView = {
  run: TraceRun;
  spans: ParsedTraceSpan[];
  attrs: Record<string, unknown>;
  copyText: string;
};

const Markdown = lazy(() => import("../components/Markdown"));
const SettingsPage = lazy(() => import("../components/SettingsPage"));
const MessageAttachments = lazy(() => import("../components/MessageAttachments"));
const TraceDrawerContent = lazy(() => import("../components/TraceDrawerContent"));

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

function isBusyMessageStatus(status: Message["status"] | undefined) {
  return status === "queued" || status === "pending" || status === "streaming";
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
          tool: null,
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

    // Back-compat for activities emitted before the tool discriminator
    // landed: a stepped activity with no `tool` field must have been search
    // (extract wasn't wired then). An unstepped activity with no tool field
    // is a top-level marker ("Response failed", budget reached).
    const rawTool = parsed.tool;
    const step = typeof parsed.step === "number" ? parsed.step : null;
    const tool: AssistantActivity["tool"] =
      rawTool === "search" || rawTool === "extract" ? rawTool : step != null ? "search" : null;

    return {
      tool,
      label,
      state: parsed.state === "completed" || parsed.state === "failed" ? parsed.state : "active",
      step,
      query: typeof parsed.query === "string" && parsed.query.trim() ? parsed.query.trim() : null,
      detail:
        typeof parsed.detail === "string" && parsed.detail.trim() ? parsed.detail.trim() : null,
    } satisfies AssistantActivity;
  } catch {
    return fallbackLabel
      ? {
          tool: null,
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

function isTerminalTraceStatus(
  status: string | undefined,
): status is "completed" | "failed" | "cancelled" {
  return status === "completed" || status === "failed" || status === "cancelled";
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

function spanToCopyShape(span: ParsedTraceSpan): Record<string, unknown> {
  return {
    name: span.name,
    kind: span.kind,
    status: span.status,
    startedAt: span.startedAt,
    endedAt: span.endedAt,
    durationMs: span.durationMs,
    errorCode: span.errorCode,
    errorMessage: span.errorMessage,
    attrs: span.attrs,
    events: span.events,
    children: span.children.map(spanToCopyShape),
  };
}

function buildTraceCopyText(trace: {
  run: TraceRun;
  spans: ParsedTraceSpan[];
  attrs: Record<string, unknown>;
}): string {
  return JSON.stringify(
    {
      run: {
        traceId: trace.run.traceId,
        status: trace.run.status,
        modelId: trace.run.modelId,
        startedAt: trace.run.startedAt,
        endedAt: trace.run.endedAt,
        durationMs: trace.run.durationMs,
        errorCode: trace.run.errorCode,
        errorMessage: trace.run.errorMessage,
        attrs: trace.attrs,
      },
      spans: trace.spans.map(spanToCopyShape),
    },
    null,
    2,
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

function getInitialExpandReasoning(): boolean {
  if (typeof localStorage !== "undefined") {
    return localStorage.getItem("b3-expand-reasoning") === "1";
  }
  return false;
}

function getInitialPreferFreeSearch(): boolean {
  if (typeof localStorage !== "undefined") {
    return localStorage.getItem("b3-prefer-free-search") === "1";
  }
  return false;
}

const fetchBootstrap = async () => {
  const response = await fetch("/api/bootstrap");
  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new Error(message || "Failed to load app bootstrap");
  }
  return (await response.json()) as BootstrapPayload;
};

function MarkdownFallback(props: { text: string }) {
  return (
    <div class="md-content">
      <p style={{ "white-space": "pre-wrap" }}>{props.text}</p>
    </div>
  );
}

function LazyMarkdownBlock(props: { text: string; streaming?: boolean; citations?: Citation[] }) {
  return (
    <Suspense fallback={<MarkdownFallback text={props.text} />}>
      <Markdown text={props.text} streaming={props.streaming} citations={props.citations} />
    </Suspense>
  );
}

export default function Home() {
  const [bootstrap] = createResource(fetchBootstrap);
  const session = createMemo(() => bootstrap()?.session ?? null);
  const models = createMemo(() => bootstrap()?.models ?? null);

  // Initialize sync layer
  onMount(async () => {
    await initSyncAdapter();
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
  const allExtractRuns = useLiveQuery(() => extractRunsCollection);
  const allTraceRuns = useLiveQuery(() => traceRunsCollection);
  const allTraceSpans = useLiveQuery(() => traceSpansCollection);
  const [theme, setTheme] = createSignal<Theme>(getInitialTheme());
  const [expandReasoningByDefault, setExpandReasoningByDefault] = createSignal<boolean>(
    getInitialExpandReasoning(),
  );
  const [preferFreeSearch, setPreferFreeSearch] = createSignal<boolean>(
    getInitialPreferFreeSearch(),
  );
  const [sidebarOpen, setSidebarOpen] = createSignal(false);
  const [showComposerMenu, setShowComposerMenu] = createSignal(false);
  const [showTraces, setShowTraces] = createSignal(false);
  const [headerVisible, setHeaderVisible] = createSignal(true);
  const [collapsedProgressByMessage, setCollapsedProgressByMessage] = createStore<
    Record<string, boolean>
  >({});
  const [didAutoCollapseProgressByMessage, setDidAutoCollapseProgressByMessage] = createStore<
    Record<string, boolean>
  >({});
  const [collapsedTraceByMessage, setCollapsedTraceByMessage] = createStore<
    Record<string, boolean>
  >({});
  /**
   * Per-chip collapse state for the interleaved-layout message parts
   * (search chips, thinking chips). Keys are `${messageId}:${chipId}`.
   * Chips default to collapsed; users can click to expand details like
   * search results.
   */
  const [collapsedChipByKey, setCollapsedChipByKey] = createStore<Record<string, boolean>>({});
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
  // eslint-disable-next-line no-unassigned-vars -- assigned via SolidJS ref attribute
  let composerInputRef: HTMLTextAreaElement | undefined;

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

  let lastScrollTop = 0;

  const handleTimelineScroll = () => {
    if (!timelineRef) return;
    const { scrollTop, scrollHeight, clientHeight } = timelineRef;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const nearBottom = distanceFromBottom <= SCROLL_THRESHOLD;
    setIsNearBottom(nearBottom);
    setShowScrollBtn(!nearBottom);

    // Mobile header show/hide on scroll direction
    if (window.innerWidth <= 700) {
      const scrollUp = scrollTop < lastScrollTop;
      const scrollDown = scrollTop > lastScrollTop;
      const notAtTop = scrollTop > 60;

      if (scrollUp && notAtTop) {
        setHeaderVisible(true);
      } else if (scrollDown) {
        setHeaderVisible(false);
      } else if (scrollTop <= 10) {
        setHeaderVisible(true);
      }
      lastScrollTop = scrollTop;
    }
  };

  const scrollToBottom = () => {
    if (!timelineRef) return;
    timelineRef.scrollTo({ top: timelineRef.scrollHeight, behavior: "smooth" });
  };

  // Apply theme to document
  createEffect(() => {
    document.documentElement.setAttribute("data-theme", theme());
    localStorage.setItem("b3-theme", theme());
    ensureThemeFont(theme());
  });

  createEffect(() => {
    localStorage.setItem("b3-expand-reasoning", expandReasoningByDefault() ? "1" : "0");
  });

  createEffect(() => {
    localStorage.setItem("b3-prefer-free-search", preferFreeSearch() ? "1" : "0");
  });

  // Auto-resize composer input
  createEffect(() => {
    composerText();
    const el = composerInputRef;
    if (!el) return;
    requestAnimationFrame(() => {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 160) + "px";
    });
  });

  // Close composer menu on outside click
  createEffect(() => {
    if (!showComposerMenu()) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".composer-dropdown")) {
        setShowComposerMenu(false);
      }
    };
    document.addEventListener("click", handler);
    onCleanup(() => document.removeEventListener("click", handler));
  });

  // Sync system prompt draft when settings opens or workspace changes
  createEffect(() => {
    if (settingsOpen()) {
      setSystemPromptDraft(activeWorkspace()?.systemPrompt ?? "");
    }
  });

  createEffect(() => {
    const workspace = activeWorkspace();
    const thread = activeThread();
    if (!workspace) return;
    if (getWorkspaceConversationView(workspace.id) === "draft" && getWorkspaceDraft(workspace.id)) {
      return;
    }
    // Use thread-level preferences if set, otherwise fall back to workspace defaults
    setComposer("modelId", thread?.modelId ?? workspace.defaultModelId);
    setComposer(
      "reasoningLevel",
      thread?.reasoningLevel ?? workspace.defaultReasoningLevel ?? "off",
    );
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
  const effectiveComposerReasoningLevel = createMemo<ReasoningLevel>(() =>
    selectedModelSupportsReasoning() ? composerReasoningLevel() : "off",
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
  const messageIds = createMemo(
    () =>
      resolveThreadMessagePath(
        (allMessages() as Message[]).filter(
          (message) => message.threadId === selectedConversationThread()?.id,
        ),
        selectedConversationThread()?.headMessageId ?? null,
      ).map((message) => message.id),
    undefined,
    { equals: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]) },
  );
  const selectedMessageIdSet = createMemo(() => new Set(messageIds()));
  const messagesById = createMemo(() => {
    const byId = new Map<string, Message>();
    for (const message of allMessages() as Message[]) {
      byId.set(message.id, message);
    }
    return byId;
  });
  const messageById = (messageId: string) => messagesById().get(messageId);
  const terminalTraceStatusByMessage = createMemo(() => {
    const byMessage = new Map<string, "completed" | "failed" | "cancelled">();
    const startedAtByMessage = new Map<string, string>();
    for (const run of allTraceRuns() as TraceRun[]) {
      if (!run.messageId || !isTerminalTraceStatus(run.status)) continue;
      const previousStartedAt = startedAtByMessage.get(run.messageId);
      if (previousStartedAt && previousStartedAt > run.startedAt) continue;
      byMessage.set(run.messageId, run.status);
      startedAtByMessage.set(run.messageId, run.startedAt);
    }
    return byMessage;
  });
  const effectiveMessageStatus = (message: Message): Message["status"] => {
    if (message.role !== "assistant" || !isBusyMessageStatus(message.status)) return message.status;
    const traceStatus = terminalTraceStatusByMessage().get(message.id);
    if (!traceStatus) return message.status;
    return traceStatus === "completed" ? "completed" : traceStatus;
  };
  const busyThreadIds = createMemo(
    () => {
      const messagesByThread = new Map<string, Message[]>();
      for (const msg of allMessages() as Message[]) {
        const list = messagesByThread.get(msg.threadId) ?? [];
        list.push(msg);
        messagesByThread.set(msg.threadId, list);
      }

      const ids = new Set<string>();
      for (const thread of threads()) {
        const path = resolveThreadMessagePath(
          messagesByThread.get(thread.id) ?? [],
          thread.headMessageId ?? null,
        );
        if (path.some((msg) => isBusyMessageStatus(effectiveMessageStatus(msg)))) {
          ids.add(thread.id);
        }
      }
      return ids;
    },
    undefined,
    {
      equals: (a, b) => {
        if (a === b) return true;
        if (a.size !== b.size) return false;
        for (const v of a) if (!b.has(v)) return false;
        return true;
      },
    },
  );
  const searchRunsMemo = createMemo(() => {
    const selectedMessageIds = selectedMessageIdSet();
    const resultsByRun = new Map<string, SearchResult[]>();
    const selectedRunIds = new Set<string>();

    for (const row of allSearchRuns() as SearchRun[]) {
      if (!selectedMessageIds.has(row.messageId)) continue;
      selectedRunIds.add(row.id);
    }

    for (const row of allSearchResults() as SearchResult[]) {
      if (!selectedRunIds.has(row.searchRunId)) continue;
      const list = resultsByRun.get(row.searchRunId) ?? [];
      list.push(row);
      resultsByRun.set(row.searchRunId, list);
    }

    const byMessage = new Map<string, Array<SearchRun & { results: SearchResult[] }>>();
    for (const row of allSearchRuns() as SearchRun[]) {
      if (!selectedMessageIds.has(row.messageId)) continue;
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
  /**
   * Parallel to searchRunsMemo: keys messageId → ExtractRun[] sorted by step.
   * The extract chip reads from this to render "Reading…" vs "Read … (N
   * chars)" states, and to expose final char counts after streaming.
   */
  const extractRunsMemo = createMemo(() => {
    const selectedMessageIds = selectedMessageIdSet();
    const byMessage = new Map<string, ExtractRun[]>();
    for (const row of allExtractRuns() as ExtractRun[]) {
      if (!selectedMessageIds.has(row.messageId)) continue;
      const list = byMessage.get(row.messageId) ?? [];
      list.push(row);
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
    const selectedMessageIds = selectedMessageIdSet();
    const byMessage = new Map<string, { seq: number; tokens: number }>();
    for (const row of allMessageParts() as MessagePart[]) {
      if (!selectedMessageIds.has(row.messageId)) continue;
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
    const selectedMessageIds = selectedMessageIdSet();
    const byMessage = new Map<string, Array<AssistantActivity & { seq: number }>>();
    for (const row of allMessageParts() as MessagePart[]) {
      if (!selectedMessageIds.has(row.messageId)) continue;
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
  /** All message parts (any kind) grouped by messageId, sorted by seq. */
  const messagePartsByMessage = createMemo(() => {
    const selectedMessageIds = selectedMessageIdSet();
    const byMessage = new Map<string, MessagePart[]>();
    for (const row of allMessageParts() as MessagePart[]) {
      if (!selectedMessageIds.has(row.messageId)) continue;
      const list = byMessage.get(row.messageId) ?? [];
      list.push(row);
      byMessage.set(row.messageId, list);
    }
    for (const list of byMessage.values()) {
      list.sort((a, b) => a.seq - b.seq);
    }
    return byMessage;
  });
  const messagePartsForMessage = (messageId: string) =>
    messagePartsByMessage().get(messageId) ?? [];
  /**
   * A message uses the new interleaved (T3-style) layout if it has at least
   * one `text` message_part. The server emits an empty `text` part at the
   * start of every new streaming turn as a format marker, so this flips
   * true as soon as streaming begins. Legacy messages (before this
   * refactor) never have text parts and fall through to the grouped-
   * activity layout.
   */
  const isInterleavedMessage = (messageId: string) =>
    messagePartsForMessage(messageId).some((part) => part.kind === "text");

  /**
   * Items that make up the interleaved timeline for an assistant message.
   * Produced by walking `message_parts` in seq order and grouping adjacent
   * text chunks / same-step search activities.
   */
  type TimelineItem =
    | { kind: "markdown"; text: string; streaming: boolean; key: string }
    | {
        kind: "search";
        step: number;
        query: string;
        status: "active" | "completed" | "failed";
        resultCount: number;
        detail: string | null;
        key: string;
      }
    | {
        kind: "extract";
        step: number;
        /** URL the model asked to extract. Falls back to the activity's URL
         *  if the ExtractRun row hasn't landed yet. */
        url: string;
        /** Hostname extracted from `url`, for the compact chip label. */
        host: string;
        status: "active" | "completed" | "failed";
        charCount: number;
        originalLength: number | null;
        truncated: boolean;
        detail: string | null;
        key: string;
      }
    | { kind: "thinking"; tokens: number; key: string }
    | {
        kind: "reasoning";
        /** Concatenated text across consecutive `reasoning` parts. */
        text: string;
        /** True while the model is still streaming reasoning for this
         *  segment (i.e., the segment has not been closed by a
         *  subsequent text/tool part and the message is not finished). */
        streaming: boolean;
        /** Stable key derived from the first part's seq so the DOM
         *  node is preserved across streaming updates. */
        key: string;
      }
    | { kind: "failure"; key: string };

  const assistantTimelineByMessage = createMemo(() => {
    const byMessage = new Map<string, TimelineItem[]>();
    const searchRunsByMsg = searchRunsMemo();
    const extractRunsByMsg = extractRunsMemo();

    for (const [messageId, parts] of messagePartsByMessage()) {
      const items: TimelineItem[] = [];
      let pendingText = "";
      let pendingTextSeq = -1;
      /** Accumulator for a run of consecutive `reasoning` parts. We
       *  collapse them into a single collapsible chip so the UI shows
       *  one "Reasoning" pill per segment rather than one per chunk. */
      let pendingReasoning = "";
      let pendingReasoningSeq = -1;
      /** When a message has any real `reasoning` parts, we suppress
       *  the token-count-only `thinking_tokens` summary chip — the
       *  text-bearing Reasoning chip already communicates that the
       *  model thought about the answer. The token count chip remains
       *  for legacy messages (and providers) that don't surface the
       *  underlying reasoning text. */
      const hasReasoningParts = parts.some((part) => part.kind === "reasoning");

      const flushText = (streaming: boolean) => {
        if (!pendingText) return;
        items.push({
          kind: "markdown",
          text: pendingText,
          streaming,
          key: `text:${pendingTextSeq}`,
        });
        pendingText = "";
        pendingTextSeq = -1;
      };

      const flushReasoning = (streaming: boolean) => {
        if (!pendingReasoning) return;
        items.push({
          kind: "reasoning",
          text: pendingReasoning,
          streaming,
          key: `reasoning:${pendingReasoningSeq}`,
        });
        pendingReasoning = "";
        pendingReasoningSeq = -1;
      };

      /** Track the latest activity seen for each search step so we can
       *  collapse (Searching…, Found X results) into a single chip. */
      const renderedSearchSteps = new Set<number>();
      /** Parallel tracker for extract steps — search and extract share the
       *  same step-number space from the model's POV (each tool starts at 1
       *  independently) so we key their chips separately. */
      const renderedExtractSteps = new Set<number>();

      for (const part of parts) {
        if (part.kind === "text") {
          // Text closes any open reasoning segment before it.
          flushReasoning(false);
          if (pendingTextSeq < 0) pendingTextSeq = part.seq;
          pendingText += part.text;
          continue;
        }

        if (part.kind === "reasoning") {
          // Reasoning closes any open text run before it so the
          // reasoning chip renders at the correct seq position.
          flushText(false);
          if (pendingReasoningSeq < 0) pendingReasoningSeq = part.seq;
          pendingReasoning += part.text;
          continue;
        }

        if (part.kind === "activity") {
          const activity = parseAssistantActivity(part);
          if (!activity) continue;

          // Suppress the lifecycle chips in the interleaved layout —
          // streaming text itself is sufficient feedback.
          if (activity.label === "Response streaming") continue;
          if (activity.label === "Response complete") continue;

          // Top-level failure activity emitted by the stream consumer's
          // failMessage and the sync-engine's runAssistantTurn catch.
          // Render at most one failure card per message — both paths can
          // emit a "Response failed" activity when a stream ends in error,
          // and the card reads its text from message.errorMessage anyway.
          if (activity.label === "Response failed") {
            flushReasoning(false);
            flushText(false);
            if (!items.some((item) => item.kind === "failure")) {
              items.push({ kind: "failure", key: `failure:${part.seq}` });
            }
            continue;
          }

          if (activity.step != null) {
            // For a given tool step we may see multiple activities
            // (active → completed, or active → failed). Only emit the
            // chip once; its live status and result count are read from
            // the run row, which reflects the latest state.
            flushReasoning(false);
            flushText(false);

            if (activity.tool === "extract") {
              if (renderedExtractSteps.has(activity.step)) continue;
              renderedExtractSteps.add(activity.step);
              const run = (extractRunsByMsg.get(messageId) ?? []).find(
                (r) => r.step === activity.step,
              );
              const url = run?.url ?? "";
              let host = "";
              if (url) {
                try {
                  host = new URL(url).hostname;
                } catch {
                  host = url;
                }
              }
              items.push({
                kind: "extract",
                step: activity.step,
                url,
                host,
                status: run ? run.status : activity.state,
                charCount: run?.charCount ?? 0,
                originalLength: run?.originalLength ?? null,
                truncated: run?.truncated ?? false,
                detail: activity.detail ?? run?.errorMessage ?? null,
                key: `extract:${activity.step}`,
              });
              continue;
            }

            // Default to search — covers explicit `tool: "search"` and the
            // back-compat path (stepped activity with no tool field).
            if (renderedSearchSteps.has(activity.step)) continue;
            renderedSearchSteps.add(activity.step);
            const run = (searchRunsByMsg.get(messageId) ?? []).find(
              (r) => r.step === activity.step,
            );
            items.push({
              kind: "search",
              step: activity.step,
              query: activity.query ?? run?.query ?? "",
              status: run ? run.status : activity.state,
              resultCount: run?.resultCount ?? 0,
              detail: activity.detail,
              key: `search:${activity.step}`,
            });
            continue;
          }

          // Activity with state="failed" but no step — treat as a top-
          // level failure marker (e.g. budget reached). Dedupe across a
          // message as above.
          if (activity.state === "failed") {
            flushReasoning(false);
            flushText(false);
            if (!items.some((item) => item.kind === "failure")) {
              items.push({ kind: "failure", key: `failure:${part.seq}` });
            }
            continue;
          }

          // Anything else: skip silently. Streaming text is the primary
          // feedback channel in the interleaved layout.
          continue;
        }

        if (part.kind === "thinking_tokens") {
          // Legacy summary pill: skip when the message already carries
          // real reasoning text to avoid a duplicate "Reasoning" chip.
          if (hasReasoningParts) continue;
          const tokens = parseThinkingTokens(part);
          if (tokens == null) continue;
          flushReasoning(false);
          flushText(false);
          items.push({ kind: "thinking", tokens, key: `thinking:${part.seq}` });
          continue;
        }
      }

      // Anything beyond the last committed text part is "live" streaming
      // tail. We compute how much text has been committed as parts and
      // show the remainder as a trailing markdown block.
      const message = messagesById().get(messageId);
      if (message?.role === "assistant") {
        const committedLength = parts
          .filter((part) => part.kind === "text")
          .reduce((sum, part) => sum + (part.text?.length ?? 0), 0);
        const fullText = message.text ?? "";
        const tail = fullText.slice(committedLength);
        if (tail) {
          // Text tail closes an in-flight reasoning segment — the model
          // has moved from thinking to answering.
          flushReasoning(false);
          pendingText += tail;
          if (pendingTextSeq < 0) pendingTextSeq = Number.MAX_SAFE_INTEGER;
        }
        const status = effectiveMessageStatus(message);
        const streaming = status === "streaming" || status === "pending" || status === "queued";
        // If reasoning is still open and the message is mid-stream,
        // leave the chip in its streaming state so the user sees live
        // updates. Once the status flips to completed/failed it closes.
        flushReasoning(streaming && !pendingText && !items.some((it) => it.kind === "markdown"));
        flushText(streaming);
      } else {
        flushReasoning(false);
        flushText(false);
      }

      byMessage.set(messageId, items);
    }
    return byMessage;
  });

  const assistantTimeline = (messageId: string) =>
    assistantTimelineByMessage().get(messageId) ?? [];
  const searchResultsForStep = (messageId: string, step: number) => {
    const runs = searchRunsMemo().get(messageId) ?? [];
    const run = runs.find((r) => r.step === step);
    if (!run) return null;
    let offset = 0;
    for (const r of runs) {
      if (r.step < step) offset += r.results.length;
    }
    return { run, startIndex: offset + 1 };
  };
  const chipCollapseKey = (messageId: string, key: string) => `${messageId}:${key}`;
  const isChipCollapsed = (messageId: string, key: string) =>
    collapsedChipByKey[chipCollapseKey(messageId, key)] ?? true;
  const toggleChipCollapse = (messageId: string, key: string) => {
    setCollapsedChipByKey(chipCollapseKey(messageId, key), !isChipCollapsed(messageId, key));
  };
  /**
   * Reasoning chips follow a different default than search chips: while
   * the model is actively streaming thoughts we auto-expand so the user
   * can follow along (like t3-chat). Once the user explicitly toggles
   * the chip we honor that choice forever after, including after
   * streaming completes.
   */
  const isReasoningCollapsed = (messageId: string, key: string, streaming: boolean) => {
    const explicit = collapsedChipByKey[chipCollapseKey(messageId, key)];
    if (explicit !== undefined) return explicit;
    if (expandReasoningByDefault()) return false;
    return !streaming;
  };

  const expandedStreamingReasoningFingerprint = createMemo(() => {
    const messageId = messageIds().find((id) => {
      const msg = messageById(id);
      if (!msg || msg.role !== "assistant") return false;
      const status = effectiveMessageStatus(msg);
      return status === "streaming" || status === "pending" || status === "queued";
    });
    if (!messageId) return "";
    const reasoning = assistantTimeline(messageId).find(
      (item): item is Extract<TimelineItem, { kind: "reasoning" }> =>
        item.kind === "reasoning" &&
        item.streaming &&
        !isReasoningCollapsed(messageId, item.key, item.streaming),
    );
    return reasoning ? `${messageId}:${reasoning.key}:${reasoning.text.length}` : "";
  });

  // Auto-scroll only when user is already near the bottom.
  // Fingerprint isolates the scroll trigger so the effect doesn't re-run
  // on every unrelated message or activity change.
  const scrollFingerprint = createMemo(() => {
    const ids = messageIds();
    const lastId = ids[ids.length - 1];
    if (!lastId) return "";
    const msg = messageById(lastId);
    if (!msg) return "";
    return `${msg.id}:${msg.status}:${msg.text?.length ?? 0}`;
  });
  createEffect(() => {
    scrollFingerprint();
    expandedStreamingReasoningFingerprint();
    if (timelineRef && isNearBottom()) {
      requestAnimationFrame(() => {
        timelineRef!.scrollTop = timelineRef!.scrollHeight;
      });
    }
  });

  const traceRunsByMessage = createMemo(() => {
    const selectedMessageIds = selectedMessageIdSet();
    const byMessage = new Map<string, TraceRun[]>();
    for (const row of allTraceRuns() as TraceRun[]) {
      if (!row.messageId || !selectedMessageIds.has(row.messageId)) continue;
      const list = byMessage.get(row.messageId) ?? [];
      list.push(row);
      byMessage.set(row.messageId, list);
    }
    for (const list of byMessage.values()) {
      list.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    }
    return byMessage;
  });

  const thinkingTokens = (messageId: string) => thinkingTokensByMessage().get(messageId) ?? null;
  const activitiesForMessage = (messageId: string) => assistantActivities().get(messageId) ?? [];
  const isWaitingForVisibleAnswer = (message: Message) => {
    const status = effectiveMessageStatus(message);
    return (
      message.role === "assistant" &&
      (status === "queued" || status === "pending" || status === "streaming") &&
      !message.text?.trim()
    );
  };
  const hasAssistantPrelude = (message: Message) =>
    message.role === "assistant" &&
    !isInterleavedMessage(message.id) &&
    (activitiesForMessage(message.id).length > 0 ||
      isWaitingForVisibleAnswer(message) ||
      thinkingTokens(message.id) != null ||
      (showTraces() && traceRunsForMessage(message.id).length > 0));
  const hasAssistantStats = (message: Message) =>
    message.role === "assistant" &&
    (thinkingTokens(message.id) != null ||
      message.promptTokens != null ||
      message.ttftMs != null ||
      message.durationMs != null ||
      message.completionTokens != null);
  const hasAssistantAnswerCard = (message: Message) =>
    message.role === "assistant" &&
    !isInterleavedMessage(message.id) &&
    (Boolean(message.text?.trim()) ||
      effectiveMessageStatus(message) === "failed" ||
      (searchRunsMemo().get(message.id)?.length ?? 0) > 0 ||
      (extractRunsMemo().get(message.id)?.length ?? 0) > 0 ||
      hasAssistantStats(message));
  /**
   * True when an assistant message should render with the new interleaved
   * T3-style layout (text + inline activity chips in seq order). Controls
   * which rendering branch runs inside `renderMessage`.
   */
  const hasAssistantInterleavedBody = (message: Message) =>
    message.role === "assistant" && isInterleavedMessage(message.id);
  const thinkingLabel = (messageId: string) => {
    const tokens = thinkingTokens(messageId);
    return tokens != null ? `${formatTokenCount(tokens)} thinking tokens` : "Thinking…";
  };
  const isAssistantPreludeCollapsed = (messageId: string) =>
    collapsedProgressByMessage[messageId] ?? false;
  const toggleAssistantPrelude = (messageId: string) =>
    setCollapsedProgressByMessage(messageId, !isAssistantPreludeCollapsed(messageId));
  const assistantPreludeSummary = (message: Message) => {
    const parts: string[] = [];
    const activities = activitiesForMessage(message.id);
    const tokens = thinkingTokens(message.id);

    if (activities.length > 0) {
      parts.push(`${activities.length} step${activities.length === 1 ? "" : "s"}`);
    }
    if (tokens != null) {
      parts.push(`${formatTokenCount(tokens)} thinking tokens`);
    }
    if (showTraces() && traceRunsForMessage(message.id).length > 0) {
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
  const openTraceMessageIdSet = createMemo(() => {
    if (!showTraces()) return new Set<string>();

    const openIds = new Set<string>();
    for (const messageId of messageIds()) {
      if (!isTraceCollapsed(messageId) && traceRunsForMessage(messageId).length > 0) {
        openIds.add(messageId);
      }
    }
    return openIds;
  });
  const traceSpansByRun = createMemo(() => {
    const openMessageIds = openTraceMessageIdSet();
    if (openMessageIds.size === 0) return new Map<string, TraceSpan[]>();

    const openRunIds = new Set<string>();
    for (const messageId of openMessageIds) {
      for (const run of traceRunsForMessage(messageId)) {
        openRunIds.add(run.id);
      }
    }

    const byRun = new Map<string, TraceSpan[]>();
    for (const row of allTraceSpans() as TraceSpan[]) {
      if (!row.traceRunId || !openRunIds.has(row.traceRunId)) continue;
      const list = byRun.get(row.traceRunId) ?? [];
      list.push(row);
      byRun.set(row.traceRunId, list);
    }
    for (const list of byRun.values()) {
      list.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    }
    return byRun;
  });
  const traceTreesByMessage = createMemo(() => {
    const trees = new Map<string, TraceTreeView[]>();
    for (const messageId of openTraceMessageIdSet()) {
      const runs = traceRunsByMessage().get(messageId) ?? [];
      trees.set(
        messageId,
        runs.map((run) => {
          const spans = buildTraceTree(traceSpansByRun().get(run.id) ?? []);
          const attrs = parseTraceJson(run.attrsJson);
          return {
            run,
            spans,
            attrs,
            copyText: buildTraceCopyText({ run, spans, attrs }),
          };
        }),
      );
    }
    return trees;
  });
  const traceTreesForMessage = (messageId: string) => traceTreesByMessage().get(messageId) ?? [];
  const traceSummaryForMessage = (messageId: string) => {
    const firstRun = traceRunsForMessage(messageId)[0];
    return firstRun
      ? `${formatTraceStatus(firstRun.status)} • ${shortTraceId(firstRun.traceId)}`
      : "Developer trace";
  };
  const traceDrawerDataForMessage = (messageId: string): TraceDrawerTrace[] =>
    traceTreesForMessage(messageId).map((trace) => ({
      traceId: trace.run.traceId,
      status: trace.run.status,
      modelId: trace.run.modelId,
      durationMs: trace.run.durationMs ?? null,
      errorMessage: trace.run.errorMessage,
      attrs: trace.attrs,
      spans: trace.spans,
      copyText: trace.copyText,
    }));

  // Auto-collapse assistant prelude once text arrives.
  // Fingerprint isolates the trigger so the effect doesn't re-run
  // on every streaming delta or unrelated activity.
  const autoCollapseFingerprint = createMemo(() => {
    const ids: string[] = [];
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
      ids.push(message.id);
    }
    return ids.join(",");
  });
  createEffect(() => {
    autoCollapseFingerprint();
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

  // Pre-index attachments by messageId so filtering is O(1) per message
  const attachmentsByMessage = createMemo(() => {
    const selectedMessageIds = selectedMessageIdSet();
    const byMessage = new Map<string, Attachment[]>();
    for (const att of allAttachments() as Attachment[]) {
      if (att.status === "failed" || !att.messageId || !selectedMessageIds.has(att.messageId)) {
        continue;
      }
      const list = byMessage.get(att.messageId) ?? [];
      list.push(att);
      byMessage.set(att.messageId, list);
    }
    return byMessage;
  });

  const userAttachments = (messageId: string) => attachmentsByMessage().get(messageId) ?? [];
  const userImageAttachments = (messageId: string) =>
    userAttachments(messageId).filter((attachment) => isImageMime(attachment.mimeType));
  const userFileAttachments = (messageId: string) =>
    userAttachments(messageId).filter((attachment) => !isImageMime(attachment.mimeType));

  const renderMessage = (messageId: string) => {
    const message = () => messageById(messageId);

    return (
      <Show when={message()}>
        {(message) =>
          (() => {
            const status = () => effectiveMessageStatus(message());
            return (
              <article
                classList={{
                  msg: true,
                  assistant: message().role === "assistant",
                  user: message().role === "user",
                }}
              >
                <div class="msg-meta">
                  <span class="msg-role">{message().role === "assistant" ? "AI" : "You"}</span>
                  <Show when={status() && status() !== "completed"}>
                    <span class="msg-status">{status()}</span>
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
                          <Suspense fallback={null}>
                            <MessageAttachments
                              images={userImageAttachments(message().id)}
                              files={[]}
                            />
                          </Suspense>
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
                              <button
                                type="button"
                                onClick={() => commitUserMessageEdit(message())}
                              >
                                Save
                              </button>
                            </div>
                          </div>
                        </Show>
                        <Show when={userFileAttachments(message().id).length > 0}>
                          <Suspense fallback={null}>
                            <MessageAttachments
                              images={[]}
                              files={userFileAttachments(message().id)}
                            />
                          </Suspense>
                        </Show>
                      </div>
                    </div>
                  }
                >
                  <Show when={hasAssistantInterleavedBody(message())}>
                    <div class="assistant-interleaved-body">
                      <Show
                        when={
                          isWaitingForVisibleAnswer(message()) &&
                          assistantTimeline(message().id).length === 0
                        }
                      >
                        <div class="thinking-indicator">
                          <span class="thinking-spinner" />
                          <span>Thinking…</span>
                        </div>
                      </Show>
                      <Index each={assistantTimeline(message().id)}>
                        {(row) => (
                          <Show when={row()}>
                            {(item) => (
                              <Switch>
                                <Match
                                  when={
                                    item().kind === "markdown"
                                      ? (item() as Extract<TimelineItem, { kind: "markdown" }>)
                                      : null
                                  }
                                >
                                  {(data) => {
                                    const cites = () => citationsForMessage(message().id);
                                    return (
                                      <Show
                                        when={data().streaming}
                                        fallback={
                                          <LazyMarkdownBlock
                                            text={data().text}
                                            citations={cites()}
                                          />
                                        }
                                      >
                                        <LazyMarkdownBlock
                                          text={data().text}
                                          streaming
                                          citations={cites()}
                                        />
                                      </Show>
                                    );
                                  }}
                                </Match>
                                <Match
                                  when={
                                    item().kind === "search"
                                      ? (item() as Extract<TimelineItem, { kind: "search" }>)
                                      : null
                                  }
                                >
                                  {(data) => {
                                    const collapsed = () =>
                                      isChipCollapsed(message().id, data().key);
                                    const resultsData = () =>
                                      searchResultsForStep(message().id, data().step);
                                    const hasResults = () =>
                                      (resultsData()?.run.results.length ?? 0) > 0;
                                    const runMode = () => resultsData()?.run.mode;
                                    const rawPreview = () => {
                                      if (runMode() !== "mcp") return "";
                                      return resultsData()?.run.previewText ?? "";
                                    };
                                    const hasRawPreview = () => rawPreview().length > 0;
                                    const statusLabel = () => {
                                      if (data().status === "failed") return "Search failed";
                                      if (data().status === "active") return "Searching the web";
                                      return "Searched the web";
                                    };
                                    const countLabel = () => {
                                      const count =
                                        resultsData()?.run.results.length ?? data().resultCount;
                                      if (!count) return null;
                                      return `${count} result${count === 1 ? "" : "s"}`;
                                    };
                                    return (
                                      <div
                                        classList={{
                                          "assistant-chip": true,
                                          "assistant-chip-search": true,
                                          "is-active": data().status === "active",
                                          "is-failed": data().status === "failed",
                                        }}
                                      >
                                        <button
                                          type="button"
                                          class="assistant-chip-toggle"
                                          aria-expanded={!collapsed()}
                                          onClick={() =>
                                            toggleChipCollapse(message().id, data().key)
                                          }
                                          disabled={
                                            !hasResults() &&
                                            !hasRawPreview() &&
                                            data().status !== "failed"
                                          }
                                        >
                                          <span class="assistant-chip-icon" aria-hidden="true">
                                            <Show
                                              when={data().status === "active"}
                                              fallback={
                                                <svg
                                                  width="12"
                                                  height="12"
                                                  viewBox="0 0 24 24"
                                                  fill="none"
                                                  stroke="currentColor"
                                                  stroke-width="2"
                                                  stroke-linecap="round"
                                                  stroke-linejoin="round"
                                                >
                                                  <circle cx="11" cy="11" r="8" />
                                                  <path d="m21 21-4.3-4.3" />
                                                </svg>
                                              }
                                            >
                                              <span class="thinking-spinner" />
                                            </Show>
                                          </span>
                                          <span class="assistant-chip-label">{statusLabel()}</span>
                                          <Show when={runMode() === "mcp"}>
                                            <span
                                              class="assistant-chip-badge"
                                              title="Search ran through Exa's free public endpoint — returns raw text, no ranked link results."
                                            >
                                              raw text
                                            </span>
                                          </Show>
                                          <Show when={data().query}>
                                            <span class="assistant-chip-detail">
                                              "{data().query}"
                                            </span>
                                          </Show>
                                          <Show when={countLabel()}>
                                            {(label) => (
                                              <span class="assistant-chip-meta">{label()}</span>
                                            )}
                                          </Show>
                                          <Show
                                            when={
                                              hasResults() ||
                                              hasRawPreview() ||
                                              data().status === "failed"
                                            }
                                          >
                                            <span
                                              classList={{
                                                "assistant-chip-chevron": true,
                                                "is-collapsed": collapsed(),
                                              }}
                                              aria-hidden="true"
                                            >
                                              ▾
                                            </span>
                                          </Show>
                                        </button>
                                        <Show
                                          when={!collapsed() && hasRawPreview() && !hasResults()}
                                        >
                                          <div class="search-raw-preview">{rawPreview()}</div>
                                        </Show>
                                        <Show when={!collapsed() && hasResults()}>
                                          <Show when={resultsData()}>
                                            {(d) => (
                                              <div class="search-results-inline">
                                                <Index each={d().run.results}>
                                                  {(result, idx) => (
                                                    <a
                                                      class="search-result-link"
                                                      href={result().url}
                                                      target="_blank"
                                                      rel="noreferrer"
                                                    >
                                                      <span class="search-result-num">
                                                        {d().startIndex + idx}
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
                                        </Show>
                                        <Show
                                          when={
                                            !collapsed() &&
                                            data().status === "failed" &&
                                            data().detail
                                          }
                                        >
                                          <div class="assistant-chip-error">{data().detail}</div>
                                        </Show>
                                      </div>
                                    );
                                  }}
                                </Match>
                                <Match
                                  when={
                                    item().kind === "extract"
                                      ? (item() as Extract<TimelineItem, { kind: "extract" }>)
                                      : null
                                  }
                                >
                                  {(data) => {
                                    const collapsed = () =>
                                      isChipCollapsed(message().id, data().key);
                                    const hasDetail = () =>
                                      Boolean(data().url) ||
                                      (data().status === "failed" && Boolean(data().detail));
                                    const statusLabel = () => {
                                      if (data().status === "failed") return "Read failed";
                                      if (data().status === "active") return "Reading page";
                                      return "Read page";
                                    };
                                    const metaLabel = () => {
                                      if (data().status !== "completed") return null;
                                      const chars = data().originalLength ?? data().charCount;
                                      if (!chars) return null;
                                      return data().truncated
                                        ? `${chars.toLocaleString()} chars (truncated)`
                                        : `${chars.toLocaleString()} chars`;
                                    };
                                    return (
                                      <div
                                        classList={{
                                          "assistant-chip": true,
                                          "assistant-chip-search": true,
                                          "assistant-chip-extract": true,
                                          "is-active": data().status === "active",
                                          "is-failed": data().status === "failed",
                                        }}
                                      >
                                        <button
                                          type="button"
                                          class="assistant-chip-toggle"
                                          aria-expanded={!collapsed()}
                                          onClick={() =>
                                            toggleChipCollapse(message().id, data().key)
                                          }
                                          disabled={!hasDetail()}
                                        >
                                          <span class="assistant-chip-icon" aria-hidden="true">
                                            <Show
                                              when={data().status === "active"}
                                              fallback={
                                                <svg
                                                  width="12"
                                                  height="12"
                                                  viewBox="0 0 24 24"
                                                  fill="none"
                                                  stroke="currentColor"
                                                  stroke-width="2"
                                                  stroke-linecap="round"
                                                  stroke-linejoin="round"
                                                >
                                                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                                  <path d="M14 2v6h6" />
                                                  <path d="M16 13H8" />
                                                  <path d="M16 17H8" />
                                                  <path d="M10 9H8" />
                                                </svg>
                                              }
                                            >
                                              <span class="thinking-spinner" />
                                            </Show>
                                          </span>
                                          <span class="assistant-chip-label">{statusLabel()}</span>
                                          <Show when={data().host}>
                                            <span class="assistant-chip-detail">{data().host}</span>
                                          </Show>
                                          <Show when={metaLabel()}>
                                            {(label) => (
                                              <span class="assistant-chip-meta">{label()}</span>
                                            )}
                                          </Show>
                                          <Show when={hasDetail()}>
                                            <span
                                              classList={{
                                                "assistant-chip-chevron": true,
                                                "is-collapsed": collapsed(),
                                              }}
                                              aria-hidden="true"
                                            >
                                              ▾
                                            </span>
                                          </Show>
                                        </button>
                                        <Show when={!collapsed() && data().url}>
                                          <div class="search-results-inline">
                                            <a
                                              class="search-result-link"
                                              href={data().url}
                                              target="_blank"
                                              rel="noreferrer"
                                            >
                                              <span class="search-result-title">{data().url}</span>
                                            </a>
                                          </div>
                                        </Show>
                                        <Show
                                          when={
                                            !collapsed() &&
                                            data().status === "failed" &&
                                            data().detail
                                          }
                                        >
                                          <div class="assistant-chip-error">{data().detail}</div>
                                        </Show>
                                      </div>
                                    );
                                  }}
                                </Match>
                                <Match
                                  when={
                                    item().kind === "reasoning"
                                      ? (item() as Extract<TimelineItem, { kind: "reasoning" }>)
                                      : null
                                  }
                                >
                                  {(data) => {
                                    const collapsed = () =>
                                      isReasoningCollapsed(
                                        message().id,
                                        data().key,
                                        data().streaming,
                                      );
                                    return (
                                      <div
                                        classList={{
                                          "assistant-chip": true,
                                          "assistant-chip-reasoning": true,
                                          "is-active": data().streaming,
                                        }}
                                      >
                                        <button
                                          type="button"
                                          class="assistant-chip-toggle"
                                          aria-expanded={!collapsed()}
                                          onClick={() =>
                                            toggleChipCollapse(message().id, data().key)
                                          }
                                        >
                                          <span class="assistant-chip-icon" aria-hidden="true">
                                            <Show
                                              when={data().streaming}
                                              fallback={
                                                <svg
                                                  width="12"
                                                  height="12"
                                                  viewBox="0 0 24 24"
                                                  fill="none"
                                                  stroke="currentColor"
                                                  stroke-width="2"
                                                  stroke-linecap="round"
                                                  stroke-linejoin="round"
                                                >
                                                  <path d="M12 2a4.5 4.5 0 0 0-4.5 4.5c0 .9.27 1.75.73 2.46A4.5 4.5 0 0 0 8 17.5V19a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-1.5a4.5 4.5 0 0 0-.23-8.54A4.5 4.5 0 0 0 16.5 6.5 4.5 4.5 0 0 0 12 2Z" />
                                                  <path d="M12 2v19" />
                                                  <path d="M9 7h.01" />
                                                  <path d="M15 7h.01" />
                                                </svg>
                                              }
                                            >
                                              <span class="thinking-spinner" />
                                            </Show>
                                          </span>
                                          <span class="assistant-chip-label">Reasoning</span>
                                          <span
                                            classList={{
                                              "assistant-chip-chevron": true,
                                              "is-collapsed": collapsed(),
                                            }}
                                            aria-hidden="true"
                                          >
                                            ▾
                                          </span>
                                        </button>
                                        <Show when={!collapsed()}>
                                          <div class="assistant-chip-reasoning-text">
                                            {data().text}
                                            <Show when={data().streaming}>
                                              <span
                                                class="assistant-chip-reasoning-caret"
                                                aria-hidden="true"
                                              />
                                            </Show>
                                          </div>
                                        </Show>
                                      </div>
                                    );
                                  }}
                                </Match>
                                <Match
                                  when={
                                    item().kind === "thinking"
                                      ? (item() as Extract<TimelineItem, { kind: "thinking" }>)
                                      : null
                                  }
                                >
                                  {(data) => (
                                    <div class="assistant-chip assistant-chip-thinking">
                                      <span class="assistant-chip-icon" aria-hidden="true">
                                        <svg
                                          width="12"
                                          height="12"
                                          viewBox="0 0 24 24"
                                          fill="none"
                                          stroke="currentColor"
                                          stroke-width="2"
                                          stroke-linecap="round"
                                          stroke-linejoin="round"
                                        >
                                          <path d="M9.663 17h4.673M12 3v1M5.64 5.64l.71.71M3 12h1M20 12h1M18.36 5.64l-.71.71M12 18a6 6 0 0 0 3.5-10.9A6 6 0 0 0 8.5 7.1 6 6 0 0 0 12 18Z" />
                                        </svg>
                                      </span>
                                      <span class="assistant-chip-label">Reasoning</span>
                                      <span class="assistant-chip-meta">
                                        {formatTokenCount(data().tokens)} tokens
                                      </span>
                                    </div>
                                  )}
                                </Match>
                                <Match when={item().kind === "failure"}>
                                  <div class="assistant-error-card" role="alert">
                                    <div class="assistant-error-title">
                                      {assistantError(message()).title}
                                    </div>
                                    <div class="assistant-error-summary">
                                      {assistantError(message()).summary}
                                    </div>
                                    <p class="assistant-error-explanation">
                                      {assistantError(message()).explanation}
                                    </p>
                                    <details class="assistant-error-details">
                                      <summary>Technical details</summary>
                                      <pre>{assistantError(message()).details}</pre>
                                    </details>
                                  </div>
                                </Match>
                              </Switch>
                            )}
                          </Show>
                        )}
                      </Index>
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
                              {(
                                (message().completionTokens! / message().durationMs!) *
                                1000
                              ).toFixed(1)}{" "}
                              tok/s
                            </span>
                          </Show>
                          <Show when={message().modelId}>
                            <span class="msg-stats-model">{message().modelId}</span>
                          </Show>
                        </div>
                      </Show>
                      <Show when={showTraces() && traceRunsForMessage(message().id).length > 0}>
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
                                {traceSummaryForMessage(message().id)}
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
                              <Suspense fallback={null}>
                                <TraceDrawerContent
                                  traces={traceDrawerDataForMessage(message().id)}
                                  formatDuration={formatDuration}
                                  formatTraceStatus={formatTraceStatus}
                                  shortTraceId={shortTraceId}
                                />
                              </Suspense>
                            </div>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  </Show>
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
                        <div
                          class="assistant-progress-stack"
                          id={`assistant-progress-${message().id}`}
                        >
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
                                          when={assistantProgressFailureSummary(
                                            message(),
                                            activity(),
                                          )}
                                        >
                                          {(summary) => (
                                            <span class="assistant-progress-detail">
                                              {summary()}
                                            </span>
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
                          <Show when={showTraces() && traceRunsForMessage(message().id).length > 0}>
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
                                    {traceSummaryForMessage(message().id)}
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
                                  <Suspense fallback={null}>
                                    <TraceDrawerContent
                                      traces={traceDrawerDataForMessage(message().id)}
                                      formatDuration={formatDuration}
                                      formatTraceStatus={formatTraceStatus}
                                      shortTraceId={shortTraceId}
                                    />
                                  </Suspense>
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
                              when={effectiveMessageStatus(message()) === "streaming"}
                              fallback={
                                <LazyMarkdownBlock text={message().text} citations={cites()} />
                              }
                            >
                              <LazyMarkdownBlock
                                text={message().text}
                                streaming
                                citations={cites()}
                              />
                            </Show>
                          );
                        })()}
                      </Show>
                      <Show when={effectiveMessageStatus(message()) === "failed"}>
                        <div class="assistant-error-card" role="alert">
                          <div class="assistant-error-title">{assistantError(message()).title}</div>
                          <div class="assistant-error-summary">
                            {assistantError(message()).summary}
                          </div>
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
                              {(
                                (message().completionTokens! / message().durationMs!) *
                                1000
                              ).toFixed(1)}{" "}
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
            );
          })()
        }
      </Show>
    );
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
    const thread = activeThread();
    if (workspace && isDraftViewActive()) {
      updateWorkspaceDraft(workspace.id, (draft) => ({
        ...draft,
        modelId,
        updatedAt: nowIso(),
      }));
    } else {
      setComposer("modelId", modelId);
      // Save to current thread for per-thread persistence
      if (thread) {
        updateThreadAction({ ...thread, modelId, updatedAt: nowIso() });
      }
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
    const thread = activeThread();
    if (workspace && isDraftViewActive()) {
      updateWorkspaceDraft(workspace.id, (draft) => ({
        ...draft,
        reasoningLevel,
        updatedAt: nowIso(),
      }));
    } else {
      setComposer("reasoningLevel", reasoningLevel);
      // Save to current thread for per-thread persistence
      if (thread) {
        updateThreadAction({ ...thread, reasoningLevel, updatedAt: nowIso() });
      }
    }
    updateWorkspacePreferences({ defaultReasoningLevel: reasoningLevel });
  };

  const isSelectedThreadBusy = createMemo(() => {
    const thread = selectedConversationThread();
    return thread ? busyThreadIds().has(thread.id) : false;
  });

  /**
   * The assistant message currently streaming in the selected thread, if any.
   * Used to target the Stop button at the right message id.
   */
  const streamingAssistantMessageId = createMemo(() => {
    const thread = selectedConversationThread();
    if (!thread) return null;
    for (const id of messageIds()) {
      const msg = messageById(id);
      if (!msg || msg.role !== "assistant") continue;
      const status = effectiveMessageStatus(msg);
      if (status === "streaming" || status === "pending" || status === "queued") {
        return msg.id;
      }
    }
    return null;
  });

  const cancelActiveResponse = () => {
    const messageId = streamingAssistantMessageId();
    if (!messageId) return;
    cancelAssistantTurnAction(messageId);
  };

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
    const modelId =
      msg.modelId || activeWorkspace()?.defaultModelId || models()?.models?.[0]?.id || "auto";
    const attachmentIds = userAttachments(msg.id)
      .filter((attachment) => attachment.status === "ready")
      .map((attachment) => attachment.id);
    editUserMessageAction({
      thread,
      sourceMessage: msg,
      text,
      modelId,
      modelInterleavedField: modelInterleavedFieldFor(modelId),
      reasoningLevel: (msg.reasoningLevel ?? "off") as ReasoningLevel,
      search: Boolean(msg.searchEnabled),
      preferFreeSearch: preferFreeSearch(),
      attachmentIds,
    });
  };

  const retryMessage = (msg: Message) => {
    const thread = selectedConversationThread();
    if (!thread || !msg.text?.trim() || isSelectedThreadBusy()) return;
    const modelId =
      composerModelId() || activeWorkspace()?.defaultModelId || models()?.models?.[0]?.id || "auto";
    retryMessageAction({
      thread,
      userMessage: msg,
      modelId,
      modelInterleavedField: modelInterleavedFieldFor(modelId),
      reasoningLevel: effectiveComposerReasoningLevel(),
      search: composerSearch(),
      preferFreeSearch: preferFreeSearch(),
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
      const modelId =
        composerModelId() || workspace?.defaultModelId || models()?.models?.[0]?.id || "auto";
      const attachmentIds = composerAttachments()
        .filter((a) => a.status === "ready" && a.attachmentId)
        .map((a) => a.attachmentId!);
      sendMessageAction({
        thread,
        text,
        modelId,
        modelInterleavedField: modelInterleavedFieldFor(modelId),
        reasoningLevel: effectiveComposerReasoningLevel(),
        search: composerSearch(),
        preferFreeSearch: preferFreeSearch(),
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

  const ComposerOptions = () => (
    <>
      <Show when={selectedModelSupportsReasoning()}>
        <label>Reasoning</label>
        <select
          value={composerReasoningLevel()}
          title="Reasoning level"
          aria-label="Reasoning level"
          onChange={(event) => handleReasoningChange(event.currentTarget.value as ReasoningLevel)}
        >
          <For each={REASONING_OPTIONS}>
            {(option) => <option value={option.value}>{option.label}</option>}
          </For>
        </select>
      </Show>
      <label class="composer-menu-row">
        <input
          type="checkbox"
          checked={showTraces()}
          onChange={(event) => setShowTraces(event.currentTarget.checked)}
        />
        <span>Show traces</span>
      </label>
    </>
  );

  return (
    <Show
      when={session()}
      fallback={
        <main class="auth-shell">
          <Show
            when={!bootstrap.loading}
            fallback={
              <section class="auth-card">
                <p class="eyebrow">Personal deployment</p>
                <h1>b3 chat</h1>
                <p>Checking session...</p>
                <p class="app-version" title={BUILD_INFO.tooltip}>
                  {BUILD_INFO.label}
                </p>
              </section>
            }
          >
            <section class="auth-card">
              <p class="eyebrow">Personal deployment</p>
              <h1>b3 chat</h1>
              <p>Sign in to continue.</p>
              <p class="app-version" title={BUILD_INFO.tooltip}>
                {BUILD_INFO.label}
              </p>
              <a
                class="btn btn-primary"
                href="/api/auth/login"
                onClick={(event) => {
                  event.preventDefault();
                  window.location.assign("/api/auth/login");
                }}
                style="text-align:center;text-decoration:none"
              >
                Sign in with Google
              </a>
            </section>
          </Show>
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
                              <Show when={busyThreadIds().has(thread.id)}>
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

        <main class="main-pane" classList={{ "header-hidden": !headerVisible() }}>
          <Show
            when={!settingsOpen()}
            fallback={
              <Suspense fallback={null}>
                <SettingsPage
                  workspaceName={activeWorkspace()?.name}
                  systemPromptDraft={systemPromptDraft()}
                  onSystemPromptInput={setSystemPromptDraft}
                  onBack={() => setSettingsOpen(false)}
                  onCancel={() => setSettingsOpen(false)}
                  onSave={saveSystemPrompt}
                  expandReasoningByDefault={expandReasoningByDefault()}
                  onExpandReasoningChange={setExpandReasoningByDefault}
                  preferFreeSearch={preferFreeSearch()}
                  onPreferFreeSearchChange={setPreferFreeSearch}
                  onResetAllData={() => {
                    if (confirm("Delete ALL data? This cannot be undone.")) {
                      resetAllData();
                    }
                  }}
                />
              </Suspense>
            }
          >
            <Show when={!headerVisible()}>
              <button class="menu-btn-floating" onClick={() => setSidebarOpen(true)} title="Menu">
                ☰
              </button>
            </Show>
            <header class="thread-header" classList={{ "is-hidden": !headerVisible() }}>
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

            <Show when={!isConnected()}>
              <div class="connection-banner">Connecting…</div>
            </Show>

            <footer
              class="composer"
              classList={{ "composer-dragging": isDragging(), "composer-disabled": !isConnected() }}
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
            >
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
                ref={composerInputRef!}
                class="composer-input"
                value={composerText()}
                onInput={(event) => {
                  setComposerTextValue(event.currentTarget.value);
                  const el = event.currentTarget;
                  el.style.height = "auto";
                  el.style.height = Math.min(el.scrollHeight, 160) + "px";
                }}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={
                  composerAttachments().length > 0 ? "Add a message (optional)..." : "Message..."
                }
                disabled={!isConnected()}
                rows={1}
              />
              <div class="composer-row">
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
                  class="composer-model"
                  value={composerModelId()}
                  onChange={(event) => handleModelChange(event.currentTarget.value)}
                >
                  <For each={models()?.models ?? []}>
                    {(model) => <option value={model.id}>{model.name}</option>}
                  </For>
                </select>
                <div class="composer-actions">
                  <button
                    type="button"
                    class="composer-action-btn"
                    classList={{ "is-active": composerSearch() }}
                    title={composerSearch() ? "Disable search" : "Enable search"}
                    onClick={() => handleSearchChange(!composerSearch())}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <line x1="2" y1="12" x2="22" y2="12" />
                      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                    </svg>
                  </button>
                  <div class="composer-inline-options">
                    <ComposerOptions />
                  </div>
                  <div class="composer-dropdown">
                    <button
                      type="button"
                      class="composer-action-btn"
                      title="More options"
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowComposerMenu((v) => !v);
                      }}
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <circle cx="12" cy="5" r="1.5" fill="currentColor" stroke="none" />
                        <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
                        <circle cx="12" cy="19" r="1.5" fill="currentColor" stroke="none" />
                      </svg>
                    </button>
                    <Show when={showComposerMenu()}>
                      <div class="composer-dropdown-panel" onClick={(e) => e.stopPropagation()}>
                        <ComposerOptions />
                      </div>
                    </Show>
                  </div>
                  <Show
                    when={isSelectedThreadBusy() && streamingAssistantMessageId()}
                    fallback={
                      <button
                        type="button"
                        class="composer-send-btn"
                        disabled={
                          !isConnected() ||
                          composer.sending ||
                          composerAttachments().some(
                            (attachment) => attachment.status === "uploading",
                          )
                        }
                        onClick={sendMessage}
                        title={
                          !isConnected() ? "Connecting…" : composer.sending ? "Sending…" : "Send"
                        }
                      >
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <line x1="22" y1="2" x2="11" y2="13" />
                          <polygon points="22 2 15 22 11 13 2 9 22 2" />
                        </svg>
                      </button>
                    }
                  >
                    <button
                      type="button"
                      class="composer-stop-btn"
                      aria-label="Stop response"
                      title="Stop response"
                      onClick={cancelActiveResponse}
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        stroke="none"
                      >
                        <rect x="6" y="6" width="12" height="12" rx="2" />
                      </svg>
                    </button>
                  </Show>
                </div>
              </div>
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
