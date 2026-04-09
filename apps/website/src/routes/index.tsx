import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { createStore } from "solid-js/store";
import { createId, LOCAL_VALUES, TABLES, nowIso } from "@b3-chat/domain";
import Markdown from "../components/Markdown";
import { authClient } from "../lib/auth-client";
import { BUILD_INFO } from "../lib/build-info";
import { isAllowedFile, isImageMime, uploadFile } from "../lib/upload";
import { syncClient } from "../lib/sync-client";

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

function getInitialModelId(): string {
  if (typeof localStorage !== "undefined") {
    return localStorage.getItem("b3-modelId") ?? "";
  }
  return "";
}

function getInitialSearch(): boolean {
  if (typeof localStorage !== "undefined") {
    return localStorage.getItem("b3-search") === "true";
  }
  return false;
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

function useStoreVersion() {
  const [version, setVersion] = createSignal(0);
  onMount(() => {
    syncClient.start().catch(console.error);
    const listener = syncClient.store.addDidFinishTransactionListener(() =>
      setVersion((v) => v + 1),
    );
    onCleanup(() => syncClient.store.delListener(listener));
  });
  return version;
}

export default function Home() {
  const [session] = createResource(fetchSession);
  const [models] = createResource(fetchModels);
  const version = useStoreVersion();
  const [theme, setTheme] = createSignal<Theme>(getInitialTheme());
  const [sidebarOpen, setSidebarOpen] = createSignal(false);
  const [composer, setComposer] = createStore({
    text: "",
    modelId: getInitialModelId(),
    search: getInitialSearch(),
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
        setComposer("attachments", (att) => att.localId === localId, {
          attachmentId: result.attachment.id,
          status: "ready",
        });
        syncClient.registerAttachment(result.attachment as any);
        syncClient.completeAttachment(result.attachment as any);
      } catch (err) {
        console.error("Upload failed:", err);
        setComposer("attachments", (att) => att.localId === localId, "status", "failed");
      }
    }
    if (fileInputRef) fileInputRef.value = "";
  };

  const removeAttachment = (localId: string) => {
    const att = composer.attachments.find((a) => a.localId === localId);
    if (att?.previewUrl) URL.revokeObjectURL(att.previewUrl);
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

  // Persist model selection
  createEffect(() => {
    if (composer.modelId) {
      localStorage.setItem("b3-modelId", composer.modelId);
    }
  });

  // Persist search toggle
  createEffect(() => {
    localStorage.setItem("b3-search", String(composer.search));
  });

  // Sync system prompt draft when settings opens or workspace changes
  createEffect(() => {
    if (settingsOpen()) {
      setSystemPromptDraft(activeWorkspace()?.systemPrompt ?? "");
    }
  });

  const tables = createMemo(() => {
    version();
    return syncClient.tables;
  });

  const values = createMemo(() => {
    version();
    return syncClient.values;
  });

  createEffect(() => {
    const modelList = models()?.models ?? [];
    if (!composer.modelId && modelList[0]) setComposer("modelId", modelList[0].id);
    // If we have a persisted model, validate it still exists
    if (composer.modelId && modelList.length > 0) {
      const exists = modelList.some((m) => m.id === composer.modelId);
      if (!exists) setComposer("modelId", modelList[0].id);
    }
  });

  // Auto-scroll only when user is already near the bottom
  createEffect(() => {
    const _msgs = messages();
    if (timelineRef && isNearBottom()) {
      requestAnimationFrame(() => {
        timelineRef!.scrollTop = timelineRef!.scrollHeight;
      });
    }
  });

  const workspaces = createMemo(() =>
    Object.values<any>(tables()?.[TABLES.workspaces] ?? {})
      .filter((workspace) => !workspace.archivedAt)
      .sort((a, b) => b.sortKey - a.sortKey),
  );
  const activeWorkspaceId = createMemo(
    () => values()?.[LOCAL_VALUES.activeWorkspaceId] as string | undefined,
  );
  const activeWorkspace = createMemo(
    () => workspaces().find((workspace) => workspace.id === activeWorkspaceId()) ?? workspaces()[0],
  );
  const threads = createMemo(() =>
    Object.values<any>(tables()?.[TABLES.threads] ?? {})
      .filter((thread) => thread.workspaceId === activeWorkspace()?.id && !thread.archivedAt)
      .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt)),
  );
  const activeThreadId = createMemo(
    () => (values()?.[LOCAL_VALUES.activeThreadId] as string | undefined) ?? threads()[0]?.id,
  );
  const activeThread = createMemo(
    () => threads().find((thread) => thread.id === activeThreadId()) ?? threads()[0],
  );
  const messages = createMemo(() =>
    Object.values<any>(tables()?.[TABLES.messages] ?? {})
      .filter((message) => message.threadId === activeThread()?.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  );
  const streamingThreadIds = createMemo(() => {
    const ids = new Set<string>();
    for (const msg of Object.values<any>(tables()?.[TABLES.messages] ?? {})) {
      if (msg.status === "streaming" || msg.status === "pending" || msg.status === "queued") {
        ids.add(msg.threadId);
      }
    }
    return ids;
  });
  const searchRuns = createMemo(() => {
    const resultsByRun = new Map<string, any[]>();
    for (const row of Object.values<any>(tables()?.[TABLES.searchResults] ?? {})) {
      const list = resultsByRun.get(row.searchRunId) ?? [];
      list.push(row);
      resultsByRun.set(row.searchRunId, list);
    }

    const byMessage = new Map<
      string,
      Array<{
        [key: string]: any;
        results: any[];
      }>
    >();
    for (const row of Object.values<any>(tables()?.[TABLES.searchRuns] ?? {})) {
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

  const userAttachments = (messageId: string) => {
    const allAttachments = tables()?.[TABLES.attachments] ?? {};
    return Object.values<any>(allAttachments).filter(
      (a) => a.messageId === messageId && a.status !== "failed",
    );
  };
  const userImageAttachments = (messageId: string) =>
    userAttachments(messageId).filter((attachment) => isImageMime(attachment.mimeType));
  const userFileAttachments = (messageId: string) =>
    userAttachments(messageId).filter((attachment) => !isImageMime(attachment.mimeType));

  const signIn = async () => {
    await authClient.signIn.social({
      provider: "google",
      callbackURL: "/",
    });
  };

  const createNewWorkspace = async () => {
    syncClient.createWorkspace(
      `Workspace ${workspaces().length + 1}`,
      composer.modelId || models()?.models?.[0]?.id || "auto",
    );
  };

  const createNewThread = async () => {
    if (!activeWorkspace()) return;
    syncClient.createThread(activeWorkspace()!.id);
  };

  const deleteThread = async (threadId: string) => {
    syncClient.archiveThread(threadId);
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
    const row = syncClient.store.getRow(TABLES.threads, threadId) as any;
    if (!row || row.title === newTitle) return;
    syncClient.updateThread({ ...row, title: newTitle, updatedAt: nowIso() });
  };

  const startEditingWorkspace = (workspaceId: string, currentName: string) => {
    setEditingWorkspaceId(workspaceId);
    setEditValue(currentName);
  };

  const commitWorkspaceRename = (workspaceId: string) => {
    const newName = editValue().trim();
    setEditingWorkspaceId(null);
    if (!newName || newName === "") return;
    const row = syncClient.store.getRow(TABLES.workspaces, workspaceId) as any;
    if (!row || row.name === newName) return;
    syncClient.updateWorkspace({ ...row, name: newName, updatedAt: nowIso() });
  };

  const saveSystemPrompt = () => {
    const workspace = activeWorkspace();
    if (!workspace) return;
    const row = syncClient.store.getRow(TABLES.workspaces, workspace.id) as any;
    if (!row) return;
    syncClient.updateWorkspace({
      ...row,
      systemPrompt: systemPromptDraft(),
      updatedAt: nowIso(),
    });
    setSettingsOpen(false);
  };

  const sendMessage = async () => {
    if (
      !activeThread() ||
      (!composer.text.trim() && composer.attachments.length === 0) ||
      composer.sending
    )
      return;
    setComposer("sending", true);
    try {
      const text = composer.text.trim();
      const attachmentIds = composer.attachments
        .filter((a) => a.status === "ready" && a.attachmentId)
        .map((a) => a.attachmentId!);
      syncClient.sendMessage({
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
                    syncClient.setActiveWorkspaceId(workspace.id);
                    const wsThreads = Object.values<any>(tables()?.[TABLES.threads] ?? {})
                      .filter((t) => t.workspaceId === workspace.id && !t.archivedAt)
                      .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
                    if (wsThreads[0]) {
                      syncClient.setActiveThreadId(wsThreads[0].id);
                    }
                    setSidebarOpen(false);
                  }}
                >
                  <Show
                    when={editingWorkspaceId() === workspace.id}
                    fallback={
                      <div class="nav-item-header">
                        <strong>{workspace.name}</strong>
                        <span
                          class="action-btn"
                          title="Rename workspace"
                          onClick={(e) => {
                            e.stopPropagation();
                            startEditingWorkspace(workspace.id, workspace.name);
                          }}
                        >
                          ✎
                        </span>
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
                          syncClient.setActiveThreadId(thread.id);
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
              <For each={messages()}>
                {(message) => (
                  <article
                    classList={{
                      msg: true,
                      assistant: message.role === "assistant",
                      user: message.role === "user",
                    }}
                  >
                    <div class="msg-meta">
                      <span class="msg-role">{message.role === "assistant" ? "AI" : "You"}</span>
                      <Show when={message.status && message.status !== "done"}>
                        <span class="msg-status">{message.status}</span>
                      </Show>
                    </div>
                    <Show
                      when={message.role === "assistant"}
                      fallback={
                        <div class="msg-user-stack">
                          <Show when={userImageAttachments(message.id).length > 0}>
                            <div class="msg-attachment-gallery">
                              <For each={userImageAttachments(message.id)}>
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
                          <Show when={message.text?.trim()}>
                            <div class="msg-user-body">
                              <p>{message.text}</p>
                            </div>
                          </Show>
                          <Show when={userFileAttachments(message.id).length > 0}>
                            <div class="msg-attachments msg-attachments-files">
                              <For each={userFileAttachments(message.id)}>
                                {(att: any) => (
                                  <span class="msg-attachment-file">{att.fileName}</span>
                                )}
                              </For>
                            </div>
                          </Show>
                        </div>
                      }
                    >
                      <Markdown text={message.text || "…"} />
                      <Show when={message.status === "streaming"}>
                        <span class="streaming-cursor" />
                      </Show>
                    </Show>
                    <Show when={searchRuns().get(message.id)?.length}>
                      <div class="search-results">
                        <span class="sr-label">Web search</span>
                        <For each={searchRuns().get(message.id)}>
                          {(run) => (
                            <div>
                              <span class="sr-label">
                                #{run.step} {run.query}
                              </span>
                              <Show
                                when={run.results.length > 0}
                                fallback={<p>{run.previewText || run.status}</p>}
                              >
                                <For each={run.results}>
                                  {(result) => (
                                    <a href={result.url} target="_blank" rel="noreferrer">
                                      {result.title}
                                    </a>
                                  )}
                                </For>
                              </Show>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                    <Show
                      when={
                        message.role === "assistant" &&
                        message.status === "completed" &&
                        message.durationMs
                      }
                    >
                      <div class="msg-stats">
                        <Show when={message.ttftMs != null}>
                          <span>TTFT {message.ttftMs}ms</span>
                        </Show>
                        <span>{formatDuration(message.durationMs)}</span>
                        <Show when={message.completionTokens != null}>
                          <span>{message.completionTokens} tokens</span>
                        </Show>
                        <Show when={message.completionTokens != null && message.durationMs}>
                          <span>
                            {((message.completionTokens / message.durationMs) * 1000).toFixed(1)}{" "}
                            tok/s
                          </span>
                        </Show>
                      </div>
                    </Show>
                  </article>
                )}
              </For>
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
                  onChange={(event) => setComposer("modelId", event.currentTarget.value)}
                >
                  <For each={models()?.models ?? []}>
                    {(model) => <option value={model.id}>{model.name}</option>}
                  </For>
                </select>
                <label class="search-toggle">
                  <input
                    type="checkbox"
                    checked={composer.search}
                    onChange={(event) => setComposer("search", event.currentTarget.checked)}
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
      </div>
    </Show>
  );
}
