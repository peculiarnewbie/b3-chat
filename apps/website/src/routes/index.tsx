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
import { LOCAL_VALUES, TABLES } from "@g3-chat/domain";
import Markdown from "../components/Markdown";
import { authClient } from "../lib/auth-client";
import { syncClient } from "../lib/sync-client";

type SessionPayload = {
  user?: {
    id?: string;
    email?: string;
  };
  runtimeConfig?: {
    hasOpencodeKey: boolean;
    hasExaKey: boolean;
    defaultModelId: string | null;
    availableFeatures: {
      chat: boolean;
      search: boolean;
    };
  };
};

type ModelsPayload = {
  models: Array<{
    id: string;
    name: string;
  }>;
  runtimeConfig?: SessionPayload["runtimeConfig"];
};

type ProviderSettingsPayload = {
  hasOpencodeKey: boolean;
  hasExaKey: boolean;
  updatedAt: string | null;
  lastValidatedOpencodeAt?: string | null;
  lastValidatedExaAt?: string | null;
  lastOpencodeError?: string | null;
  lastExaError?: string | null;
};

type Theme = "clean" | "night" | "warm";

function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
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
    const saved = localStorage.getItem("g3-theme") as Theme | null;
    if (saved && THEMES.some((t) => t.id === saved)) return saved;
  }
  return "clean";
}

function getInitialModelId(): string {
  if (typeof localStorage !== "undefined") {
    return localStorage.getItem("g3-modelId") ?? "";
  }
  return "";
}

function getInitialSearch(): boolean {
  if (typeof localStorage !== "undefined") {
    return localStorage.getItem("g3-search") === "true";
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

const fetchProviderSettings = async () => {
  const response = await fetch("/api/settings/providers");
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("Failed to load provider settings");
  return (await response.json()) as ProviderSettingsPayload;
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
  const [providerSettings, { mutate: setProviderSettings, refetch: refetchProviderSettings }] =
    createResource(() => session()?.user?.id ?? null, fetchProviderSettings);
  const version = useStoreVersion();
  const [theme, setTheme] = createSignal<Theme>(getInitialTheme());
  const [sidebarOpen, setSidebarOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [composer, setComposer] = createStore({
    text: "",
    modelId: getInitialModelId(),
    search: getInitialSearch(),
    sending: false,
  });
  const [providerForm, setProviderForm] = createStore({
    opencodeApiKey: "",
    exaApiKey: "",
    saving: false,
    error: "",
  });
  const [editingThreadId, setEditingThreadId] = createSignal<string | null>(null);
  const [editingWorkspaceId, setEditingWorkspaceId] = createSignal<string | null>(null);
  const [editText, setEditText] = createSignal("");
  const [showScrollBtn, setShowScrollBtn] = createSignal(false);

  // biome-ignore lint: assigned via ref attribute
  // eslint-disable-next-line no-unassigned-vars -- assigned via SolidJS ref
  let timelineRef: HTMLElement | undefined;
  let userScrolledUp = false;

  // Apply theme to document
  createEffect(() => {
    document.documentElement.setAttribute("data-theme", theme());
    localStorage.setItem("g3-theme", theme());
  });

  // Persist model selection
  createEffect(() => {
    if (composer.modelId) localStorage.setItem("g3-modelId", composer.modelId);
  });

  // Persist search toggle
  createEffect(() => {
    localStorage.setItem("g3-search", String(composer.search));
  });

  const tables = createMemo(() => {
    version();
    return syncClient.tables;
  });

  const values = createMemo(() => {
    version();
    return syncClient.values;
  });

  const runtimeConfig = createMemo(
    () => providerSettings() ?? session()?.runtimeConfig ?? models()?.runtimeConfig ?? null,
  );
  const chatConfigured = createMemo(() => Boolean(runtimeConfig()?.hasOpencodeKey));
  const searchConfigured = createMemo(() => Boolean(runtimeConfig()?.hasExaKey));

  createEffect(() => {
    const modelList = models()?.models ?? [];
    const savedId = getInitialModelId();
    if (savedId && modelList.some((m) => m.id === savedId)) {
      if (!composer.modelId) setComposer("modelId", savedId);
    } else if (!composer.modelId && modelList[0]) {
      setComposer("modelId", modelList[0].id);
    }
  });

  const isNearBottom = () => {
    if (!timelineRef) return true;
    const threshold = 80;
    return timelineRef.scrollHeight - timelineRef.scrollTop - timelineRef.clientHeight < threshold;
  };

  const scrollToBottom = () => {
    if (timelineRef) {
      timelineRef.scrollTo({ top: timelineRef.scrollHeight, behavior: "smooth" });
      userScrolledUp = false;
      setShowScrollBtn(false);
    }
  };

  const handleTimelineScroll = () => {
    if (isNearBottom()) {
      userScrolledUp = false;
      setShowScrollBtn(false);
    } else {
      userScrolledUp = true;
      setShowScrollBtn(true);
    }
  };

  // Auto-scroll on new messages — only if user hasn't scrolled up
  createEffect(() => {
    const _msgs = messages();
    if (timelineRef && !userScrolledUp) {
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
  const searchResults = createMemo(() => {
    const byMessage = new Map<string, any[]>();
    for (const row of Object.values<any>(tables()?.[TABLES.searchResults] ?? {})) {
      const list = byMessage.get(row.messageId) ?? [];
      list.push(row);
      byMessage.set(row.messageId, list);
    }
    return byMessage;
  });

  const signIn = async () => {
    await authClient.signIn.social({
      provider: "google",
      callbackURL: "/",
    });
  };

  const saveProviderSettings = async () => {
    setProviderForm("saving", true);
    setProviderForm("error", "");
    try {
      const response = await fetch("/api/settings/providers", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          opencodeApiKey: providerForm.opencodeApiKey || undefined,
          exaApiKey: providerForm.exaApiKey || undefined,
        }),
      });
      if (!response.ok) throw new Error("Failed to save settings");
      const next = (await response.json()) as ProviderSettingsPayload;
      setProviderSettings(next);
      setProviderForm("opencodeApiKey", "");
      setProviderForm("exaApiKey", "");
    } catch (error) {
      setProviderForm("error", error instanceof Error ? error.message : "Failed to save settings");
    } finally {
      setProviderForm("saving", false);
    }
  };

  const clearProviderKey = async (provider: "opencodeApiKey" | "exaApiKey") => {
    setProviderForm("saving", true);
    setProviderForm("error", "");
    try {
      const response = await fetch("/api/settings/providers", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          [provider]: null,
        }),
      });
      if (!response.ok) throw new Error("Failed to clear key");
      const next = (await response.json()) as ProviderSettingsPayload;
      setProviderSettings(next);
    } catch (error) {
      setProviderForm("error", error instanceof Error ? error.message : "Failed to clear key");
    } finally {
      setProviderForm("saving", false);
    }
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

  const sendMessage = async () => {
    if (!activeThread() || !composer.text.trim() || composer.sending || !chatConfigured()) return;
    setComposer("sending", true);
    try {
      const text = composer.text.trim();
      syncClient.sendMessage({
        thread: activeThread()!,
        text,
        modelId:
          composer.modelId ||
          activeWorkspace()?.defaultModelId ||
          models()?.models?.[0]?.id ||
          "auto",
        search: composer.search,
      });
      setComposer("text", "");
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
            <h1>g3 chat</h1>
            <p>Sign in with Google to continue.</p>
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
              <span class="brand-mark">g3</span>
              <div style="min-width:0">
                <h1>g3.chat</h1>
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
              <button class="btn" onClick={() => setSettingsOpen(true)}>
                Keys
              </button>
            </div>
          </div>

          <div class="sidebar-scroll">
            <p class="section-label">Workspaces</p>
            <For each={workspaces()}>
              {(workspace) => (
                <Show
                  when={editingWorkspaceId() === workspace.id}
                  fallback={
                    <button
                      classList={{
                        "nav-item": true,
                        active: workspace.id === activeWorkspace()?.id,
                      }}
                      onClick={() => {
                        syncClient.setActiveWorkspaceId(workspace.id);
                        // Focus the newest thread in this workspace
                        const wsThreads = Object.values<any>(tables()?.[TABLES.threads] ?? {})
                          .filter((t: any) => t.workspaceId === workspace.id && !t.archivedAt)
                          .sort((a: any, b: any) => b.lastMessageAt.localeCompare(a.lastMessageAt));
                        if (wsThreads[0]) syncClient.setActiveThreadId(wsThreads[0].id);
                        setSidebarOpen(false);
                      }}
                      onDblClick={(e) => {
                        e.preventDefault();
                        setEditText(workspace.name);
                        setEditingWorkspaceId(workspace.id);
                      }}
                    >
                      <strong>{workspace.name}</strong>
                    </button>
                  }
                >
                  <div class="nav-item active">
                    <input
                      class="inline-edit"
                      value={editText()}
                      onInput={(e) => setEditText(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          const trimmed = editText().trim();
                          if (trimmed && trimmed !== workspace.name) {
                            syncClient.renameWorkspace(workspace.id, trimmed);
                          }
                          setEditingWorkspaceId(null);
                        } else if (e.key === "Escape") {
                          setEditingWorkspaceId(null);
                        }
                      }}
                      onBlur={() => {
                        const trimmed = editText().trim();
                        if (trimmed && trimmed !== workspace.name) {
                          syncClient.renameWorkspace(workspace.id, trimmed);
                        }
                        setEditingWorkspaceId(null);
                      }}
                      ref={(el) => setTimeout(() => el.focus(), 0)}
                    />
                  </div>
                </Show>
              )}
            </For>

            <p class="section-label">Threads</p>
            <For each={threads()}>
              {(thread) => (
                <div
                  classList={{ "nav-item": true, active: thread.id === activeThread()?.id }}
                  onClick={() => {
                    syncClient.setActiveThreadId(thread.id);
                    setSidebarOpen(false);
                  }}
                >
                  <Show
                    when={editingThreadId() === thread.id}
                    fallback={
                      <div
                        class="nav-item-header"
                        onDblClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setEditText(thread.title);
                          setEditingThreadId(thread.id);
                        }}
                      >
                        <strong>{thread.title}</strong>
                        <button
                          class="delete-btn"
                          title="Delete thread"
                          onClick={(e) => {
                            e.stopPropagation();
                            void deleteThread(thread.id);
                          }}
                        >
                          ×
                        </button>
                      </div>
                    }
                  >
                    <input
                      class="inline-edit"
                      value={editText()}
                      onInput={(e) => setEditText(e.currentTarget.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          const trimmed = editText().trim();
                          if (trimmed && trimmed !== thread.title) {
                            syncClient.renameThread(thread.id, trimmed);
                          }
                          setEditingThreadId(null);
                        } else if (e.key === "Escape") {
                          setEditingThreadId(null);
                        }
                      }}
                      onBlur={() => {
                        const trimmed = editText().trim();
                        if (trimmed && trimmed !== thread.title) {
                          syncClient.renameThread(thread.id, trimmed);
                        }
                        setEditingThreadId(null);
                      }}
                      ref={(el) => setTimeout(() => el.focus(), 0)}
                    />
                  </Show>
                  <span>
                    <Show when={streamingThreadIds().has(thread.id)}>
                      <span class="thread-spinner" />
                    </Show>
                    {formatRelativeTime(thread.lastMessageAt)}
                  </span>
                </div>
              )}
            </For>
          </div>

          <div class="sidebar-footer">
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
          </div>
        </aside>

        <main class="main-pane">
          <header class="thread-header">
            <button class="menu-btn" onClick={() => setSidebarOpen(true)}>
              ☰
            </button>
            <span class="workspace-label">{activeWorkspace()?.name}</span>
            <h2>{activeThread()?.title ?? "New Chat"}</h2>
            <Show when={!chatConfigured()}>
              <span class="status-pill warning">OpenCode key required</span>
            </Show>
            <Show when={chatConfigured() && !searchConfigured()}>
              <span class="status-pill muted">Search disabled</span>
            </Show>
            <Show when={activeWorkspace()?.systemPrompt}>
              <span class="system-prompt" title={activeWorkspace()?.systemPrompt}>
                {activeWorkspace()?.systemPrompt}
              </span>
            </Show>
          </header>

          <Show when={!chatConfigured()}>
            <section class="setup-banner">
              <div>
                <strong>Chat is blocked until your OpenCode API key is configured.</strong>
                <p>Keys are stored encrypted inside your personal Durable Object.</p>
              </div>
              <button class="btn btn-primary" onClick={() => setSettingsOpen(true)}>
                Configure keys
              </button>
            </section>
          </Show>

          <Show when={chatConfigured() && !searchConfigured()}>
            <section class="setup-banner subtle">
              <div>
                <strong>Web search is unavailable.</strong>
                <p>Add an Exa API key to re-enable search enrichment.</p>
              </div>
              <button class="btn" onClick={() => setSettingsOpen(true)}>
                Add Exa key
              </button>
            </section>
          </Show>

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
                  <Show when={message.role === "assistant"} fallback={<p>{message.text || "…"}</p>}>
                    <Markdown text={message.text || "…"} />
                    <Show when={message.status === "streaming"}>
                      <span class="streaming-cursor" />
                    </Show>
                  </Show>
                  <Show when={searchResults().get(message.id)?.length}>
                    <div class="search-results">
                      <span class="sr-label">Web results</span>
                      <For each={searchResults().get(message.id)}>
                        {(result) => (
                          <a href={result.url} target="_blank" rel="noreferrer">
                            {result.title}
                          </a>
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
              ↓
            </button>
          </Show>

          <footer class="composer">
            <textarea
              value={composer.text}
              onInput={(event) => setComposer("text", event.currentTarget.value)}
              onKeyDown={handleKeyDown}
              placeholder={chatConfigured() ? "Message..." : "Configure your OpenCode key to chat"}
              disabled={!chatConfigured()}
            />
            <div class="composer-bar">
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
                  disabled={!searchConfigured()}
                />
                Search
              </label>
              <span class="kbd-hint">Enter to send</span>
              <button class="btn btn-primary" disabled={composer.sending} onClick={sendMessage}>
                {composer.sending ? "Sending…" : "Send"}
              </button>
            </div>
          </footer>
        </main>
      </div>

      <Show when={settingsOpen()}>
        <div class="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <section class="settings-modal" onClick={(event) => event.stopPropagation()}>
            <div class="settings-header">
              <div>
                <p class="eyebrow">Provider keys</p>
                <h3>Personal runtime settings</h3>
              </div>
              <button class="btn" onClick={() => setSettingsOpen(false)}>
                Close
              </button>
            </div>

            <div class="settings-grid">
              <label class="settings-field">
                <span>OpenCode API key</span>
                <input
                  type="password"
                  value={providerForm.opencodeApiKey}
                  onInput={(event) => setProviderForm("opencodeApiKey", event.currentTarget.value)}
                  placeholder="sk-..."
                />
                <small>
                  Status: {providerSettings()?.hasOpencodeKey ? "configured" : "missing"}
                </small>
              </label>

              <label class="settings-field">
                <span>Exa API key</span>
                <input
                  type="password"
                  value={providerForm.exaApiKey}
                  onInput={(event) => setProviderForm("exaApiKey", event.currentTarget.value)}
                  placeholder="exa_..."
                />
                <small>Status: {providerSettings()?.hasExaKey ? "configured" : "missing"}</small>
              </label>
            </div>

            <Show when={providerSettings()?.lastOpencodeError || providerSettings()?.lastExaError}>
              <p class="settings-error">
                OpenCode: {providerSettings()?.lastOpencodeError ?? "ok"} | Exa:{" "}
                {providerSettings()?.lastExaError ?? "ok"}
              </p>
            </Show>
            <Show when={providerForm.error}>
              <p class="settings-error">{providerForm.error}</p>
            </Show>

            <p class="settings-copy">
              Saved keys are encrypted at rest and isolated to this user account.
            </p>

            <div class="settings-actions">
              <button
                class="btn btn-primary"
                disabled={providerForm.saving}
                onClick={saveProviderSettings}
              >
                {providerForm.saving ? "Saving…" : "Save keys"}
              </button>
              <button
                class="btn"
                disabled={providerForm.saving || !providerSettings()?.hasOpencodeKey}
                onClick={() => void clearProviderKey("opencodeApiKey")}
              >
                Clear OpenCode
              </button>
              <button
                class="btn"
                disabled={providerForm.saving || !providerSettings()?.hasExaKey}
                onClick={() => void clearProviderKey("exaApiKey")}
              >
                Clear Exa
              </button>
              <button
                class="btn"
                disabled={providerForm.saving}
                onClick={() => void refetchProviderSettings()}
              >
                Refresh
              </button>
            </div>
          </section>
        </div>
      </Show>
    </Show>
  );
}
