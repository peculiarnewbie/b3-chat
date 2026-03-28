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
import {
  createMessage,
  createThread,
  createWorkspace,
  nowIso,
  summarizeThreadTitle,
  TABLES,
  VALUES,
} from "@g3-chat/domain";
import { authClient } from "../lib/auth-client";
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
    modelId: "",
    search: false,
    sending: false,
  });

  // biome-ignore lint: assigned via ref attribute
  // eslint-disable-next-line no-unassigned-vars -- assigned via SolidJS ref
  let timelineRef: HTMLElement | undefined;

  // Apply theme to document
  createEffect(() => {
    document.documentElement.setAttribute("data-theme", theme());
    localStorage.setItem("g3-theme", theme());
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
  });

  // Auto-scroll on new messages
  createEffect(() => {
    const _msgs = messages();
    if (timelineRef) {
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
    () => values()?.[VALUES.activeWorkspaceId] as string | undefined,
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
    () => (values()?.[VALUES.activeThreadId] as string | undefined) ?? threads()[0]?.id,
  );
  const activeThread = createMemo(
    () => threads().find((thread) => thread.id === activeThreadId()) ?? threads()[0],
  );
  const messages = createMemo(() =>
    Object.values<any>(tables()?.[TABLES.messages] ?? {})
      .filter((message) => message.threadId === activeThread()?.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  );
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

  const createNewWorkspace = async () => {
    const workspace = createWorkspace({
      name: `Workspace ${workspaces().length + 1}`,
      defaultModelId: composer.modelId || models()?.models?.[0]?.id || "auto",
    });
    const thread = createThread({ workspaceId: workspace.id });
    await syncClient.mutate({ type: "upsert-workspace", row: workspace });
    await syncClient.mutate({ type: "upsert-thread", row: thread });
    await syncClient.mutate({
      type: "set-value",
      key: VALUES.activeWorkspaceId,
      value: workspace.id,
    });
    await syncClient.mutate({ type: "set-value", key: VALUES.activeThreadId, value: thread.id });
  };

  const createNewThread = async () => {
    if (!activeWorkspace()) return;
    const thread = createThread({ workspaceId: activeWorkspace()!.id });
    await syncClient.mutate({ type: "upsert-thread", row: thread });
    await syncClient.mutate({ type: "set-value", key: VALUES.activeThreadId, value: thread.id });
  };

  const deleteThread = async (threadId: string) => {
    await syncClient.mutate({ type: "archive-thread", id: threadId, archivedAt: nowIso() });
    // If we just deleted the active thread, switch to the first remaining thread
    if (activeThreadId() === threadId) {
      const remaining = threads().filter((t) => t.id !== threadId);
      if (remaining[0]) {
        await syncClient.mutate({
          type: "set-value",
          key: VALUES.activeThreadId,
          value: remaining[0].id,
        });
      }
    }
  };

  const sendMessage = async () => {
    if (!activeThread() || !composer.text.trim() || composer.sending) return;
    setComposer("sending", true);
    try {
      const text = composer.text.trim();
      const userMessage = createMessage({
        threadId: activeThread()!.id,
        role: "user",
        modelId:
          composer.modelId ||
          activeWorkspace()?.defaultModelId ||
          models()?.models?.[0]?.id ||
          "auto",
        text,
        searchEnabled: composer.search,
      });
      const updatedThread = {
        ...activeThread(),
        title:
          activeThread()!.title === "New Chat" ? summarizeThreadTitle(text) : activeThread()!.title,
        updatedAt: nowIso(),
        lastMessageAt: nowIso(),
      };
      await syncClient.mutate({ type: "upsert-thread", row: updatedThread });
      await syncClient.mutate({ type: "upsert-message", row: userMessage });
      setComposer("text", "");

      const response = await fetch(`/api/chat/threads/${activeThread()!.id}/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userMessageId: userMessage.id,
          text,
          modelId:
            composer.modelId || activeWorkspace()?.defaultModelId || models()?.models?.[0]?.id,
          search: composer.search,
        }),
      });
      if (!response.ok || !response.body) throw new Error(await response.text());
      const reader = response.body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
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
            </div>
          </div>

          <div class="sidebar-scroll">
            <p class="section-label">Workspaces</p>
            <For each={workspaces()}>
              {(workspace) => (
                <button
                  classList={{ "nav-item": true, active: workspace.id === activeWorkspace()?.id }}
                  onClick={() => {
                    void syncClient.mutate({
                      type: "set-value",
                      key: VALUES.activeWorkspaceId,
                      value: workspace.id,
                    });
                    setSidebarOpen(false);
                  }}
                >
                  <strong>{workspace.name}</strong>
                </button>
              )}
            </For>

            <p class="section-label">Threads</p>
            <For each={threads()}>
              {(thread) => (
                <div
                  classList={{ "nav-item": true, active: thread.id === activeThread()?.id }}
                  onClick={() => {
                    void syncClient.mutate({
                      type: "set-value",
                      key: VALUES.activeThreadId,
                      value: thread.id,
                    });
                    setSidebarOpen(false);
                  }}
                >
                  <div class="nav-item-header">
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
                  <span>{formatRelativeTime(thread.lastMessageAt)}</span>
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
            <Show when={activeWorkspace()?.systemPrompt}>
              <span class="system-prompt" title={activeWorkspace()?.systemPrompt}>
                {activeWorkspace()?.systemPrompt}
              </span>
            </Show>
          </header>

          <section class="timeline" ref={timelineRef}>
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
                  <p>{message.text || "…"}</p>
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
                </article>
              )}
            </For>
          </section>

          <footer class="composer">
            <textarea
              value={composer.text}
              onInput={(event) => setComposer("text", event.currentTarget.value)}
              onKeyDown={handleKeyDown}
              placeholder="Message..."
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
    </Show>
  );
}
