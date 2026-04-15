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
import { createId, nowIso, sortConversationMessages } from "@b3-chat/domain";
import type {
  Workspace,
  Thread,
  Message,
  MessagePart,
  Attachment,
  SearchRun,
  SearchResult,
} from "@b3-chat/domain";
import Markdown from "../components/Markdown";
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
} from "../lib/collections";
import {
  createWorkspaceAction,
  createThreadAction,
  archiveThreadAction,
  archiveWorkspaceAction,
  updateThreadAction,
  updateWorkspaceAction,
  deleteAttachmentAction,
  sendMessageAction,
  resetAllData,
} from "../lib/actions";
import {
  activeWorkspaceId,
  setActiveWorkspaceId,
  activeThreadId,
  setActiveThreadId,
} from "../lib/ui-state";
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
  const [theme, setTheme] = createSignal<Theme>(getInitialTheme());
  const [sidebarOpen, setSidebarOpen] = createSignal(false);
  const [collapsedProgressByMessage, setCollapsedProgressByMessage] = createStore<
    Record<string, boolean>
  >({});
  const [didAutoCollapseProgressByMessage, setDidAutoCollapseProgressByMessage] = createStore<
    Record<string, boolean>
  >({});
  const [composer, setComposer] = createStore({
    text: "",
    modelId: "",
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

  // File upload handlers
  const handleFileSelect = async (files: FileList | null) => {
    if (!files || !activeThread()) return;
    for (const file of Array.from(files)) {
      if (!isAllowedFile(file)) continue;
      const localId = createId("local");
      const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;

      setComposer("attachments", (prev) => [
        ...prev,
        {
          localId,
          attachmentId: null,
          fileName: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          status: "uploading",
          previewUrl,
        },
      ]);

      try {
        const result = await uploadFile(file, activeThread()!.id);
        if (removedUploadLocalIds.delete(localId)) {
          deleteAttachmentAction(result.attachment.id);
          continue;
        }
        setComposer("attachments", (att) => att.localId === localId, {
          attachmentId: result.attachment.id,
          status: "ready",
        });
      } catch (err) {
        if (removedUploadLocalIds.delete(localId)) {
          continue;
        }
        console.error("Upload failed:", err);
        setComposer("attachments", (att) => att.localId === localId, "status", "failed");
      }
    }
    if (fileInputRef) fileInputRef.value = "";
  };

  const removeAttachment = (localId: string) => {
    const att = composer.attachments.find((a) => a.localId === localId);
    if (att?.previewUrl) URL.revokeObjectURL(att.previewUrl);
    if (att?.attachmentId) {
      deleteAttachmentAction(att.attachmentId);
    } else {
      removedUploadLocalIds.add(localId);
    }
    setComposer("attachments", (prev) => prev.filter((a) => a.localId !== localId));
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
    setComposer("modelId", workspace.defaultModelId);
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
  const messageIds = createMemo(() =>
    sortConversationMessages(
      (allMessages() as Message[]).filter((message) => message.threadId === activeThread()?.id),
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
      thinkingTokens(message.id) != null);
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
    if (isWaitingForVisibleAnswer(message)) {
      parts.push("live");
    }

    return parts.join(" • ") || "Live model activity";
  };

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
                  <button
                    class="msg-retry-btn"
                    title="Retry with current model"
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
                    >
                      <polyline points="1 4 1 10 7 10" />
                      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                    </svg>
                  </button>
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
                    <Show when={message().text?.trim()}>
                      <div class="msg-user-body">
                        <p>{message().text}</p>
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
                            {(activity) => (
                              <div
                                classList={{
                                  "assistant-progress-item": true,
                                  "is-active": activity().state === "active",
                                  "is-failed": activity().state === "failed",
                                }}
                              >
                                <span class="assistant-progress-marker" aria-hidden="true" />
                                <span>{activity().label}</span>
                              </div>
                            )}
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
                    </div>
                  </Show>
                </div>
              </Show>
              <Show when={hasAssistantAnswerCard(message())}>
                <div class="assistant-answer-card">
                  <Show when={message().text?.trim()}>
                    <Show
                      when={message().status === "streaming"}
                      fallback={<Markdown text={message().text} />}
                    >
                      <div class="assistant-streaming-text">
                        <span>{message().text}</span>
                        <span class="streaming-cursor" />
                      </div>
                    </Show>
                  </Show>
                  <Show when={searchRunsMemo().get(message().id)?.length}>
                    <div class="search-results">
                      <span class="sr-label">Web search</span>
                      <Index each={searchRunsMemo().get(message().id) ?? []}>
                        {(run) => (
                          <div>
                            <span class="sr-label">
                              #{run().step} {run().query}
                            </span>
                            <Show
                              when={run().results.length > 0}
                              fallback={<p>{run().previewText || run().status}</p>}
                            >
                              <Index each={run().results}>
                                {(result) => (
                                  <a href={result().url} target="_blank" rel="noreferrer">
                                    {result().title}
                                  </a>
                                )}
                              </Index>
                            </Show>
                          </div>
                        )}
                      </Index>
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
      defaultModelId: composer.modelId || models()?.models?.[0]?.id || "auto",
      defaultSearchMode: composer.search,
    });
  };

  const createNewThread = async () => {
    if (!activeWorkspace()) return;
    createThreadAction(activeWorkspace()!.id);
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
    changes: Partial<Pick<Workspace, "defaultModelId" | "defaultSearchMode">>,
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
    setComposer("modelId", modelId);
    updateWorkspacePreferences({ defaultModelId: modelId });
  };

  const handleSearchChange = (search: boolean) => {
    setComposer("search", search);
    updateWorkspacePreferences({ defaultSearchMode: search });
  };

  const retryMessage = (msg: any) => {
    if (!activeThread() || !msg.text?.trim()) return;
    const attachmentIds = userAttachments(msg.id)
      .filter((attachment) => attachment.status === "ready")
      .map((attachment) => attachment.id);
    const modelId =
      composer.modelId || activeWorkspace()?.defaultModelId || models()?.models?.[0]?.id || "auto";
    sendMessageAction({
      thread: activeThread()!,
      text: msg.text.trim(),
      modelId,
      search: composer.search,
      attachmentIds,
    });
  };

  const sendMessage = async () => {
    console.log("[send] attempt", {
      activeThread: activeThread(),
      activeWorkspace: activeWorkspace(),
      text: composer.text.trim(),
      attachments: composer.attachments.length,
      sending: composer.sending,
      workspacesCount: workspaces().length,
      threadsCount: threads().length,
    });
    if (
      !activeThread() ||
      (!composer.text.trim() && composer.attachments.length === 0) ||
      composer.sending
    ) {
      console.log("[send] blocked", {
        noThread: !activeThread(),
        noContent: !composer.text.trim() && composer.attachments.length === 0,
        alreadySending: composer.sending,
      });
      return;
    }
    setComposer("sending", true);
    try {
      const text = composer.text.trim();
      const attachmentIds = composer.attachments
        .filter((a) => a.status === "ready" && a.attachmentId)
        .map((a) => a.attachmentId!);
      sendMessageAction({
        thread: activeThread()!,
        text,
        modelId:
          composer.modelId ||
          activeWorkspace()?.defaultModelId ||
          models()?.models?.[0]?.id ||
          "auto",
        search: composer.search,
        attachmentIds,
      });
      for (const att of composer.attachments) {
        if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
      }
      setComposer("text", "");
      setComposer("attachments", []);
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
                        classList={{ "nav-item": true, active: thread.id === activeThread()?.id }}
                        onClick={() => {
                          if (editingThreadId() === thread.id) return;
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
              <h2>{activeThread()?.title ?? "New Chat"}</h2>
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
              <Show when={composer.attachments.length > 0}>
                <div class="attachment-strip">
                  <For each={composer.attachments}>
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
                value={composer.text}
                onInput={(event) => setComposer("text", event.currentTarget.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={
                  composer.attachments.length > 0 ? "Add a message (optional)..." : "Message..."
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
                  value={composer.modelId}
                  onChange={(event) => handleModelChange(event.currentTarget.value)}
                >
                  <For each={models()?.models ?? []}>
                    {(model) => <option value={model.id}>{model.name}</option>}
                  </For>
                </select>
                <label class="search-toggle">
                  <input
                    type="checkbox"
                    checked={composer.search}
                    onChange={(event) => handleSearchChange(event.currentTarget.checked)}
                  />
                  Search
                </label>
                <span class="kbd-hint">Enter to send</span>
                <button
                  class="btn btn-primary"
                  disabled={
                    composer.sending || composer.attachments.some((a) => a.status === "uploading")
                  }
                  onClick={sendMessage}
                >
                  {composer.sending ? "Sending…" : "Send"}
                </button>
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
