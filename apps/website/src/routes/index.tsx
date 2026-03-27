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

const fetchSession = async () => {
  const response = await fetch("/api/session");
  if (response.status === 401) return null;
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
  const [composer, setComposer] = createStore({
    text: "",
    modelId: "",
    search: false,
    sending: false,
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

  return (
    <Show
      when={session()}
      fallback={
        <main class="auth-shell">
          <section class="auth-card">
            <p class="eyebrow">Personal deployment</p>
            <h1>g3 chat</h1>
            <p>
              Google OAuth is required. Access is granted only if the email matches this deployment.
            </p>
            <button class="primary-button" onClick={signIn}>
              Continue with Google
            </button>
          </section>
        </main>
      }
    >
      <div class="shell">
        <aside class="sidebar">
          <div class="brand">
            <span class="brand-mark">g3</span>
            <div>
              <h1>g3.chat</h1>
              <p>{session()?.user?.email}</p>
            </div>
          </div>
          <button class="primary-button" onClick={createNewThread}>
            New Chat
          </button>
          <button class="ghost-button" onClick={createNewWorkspace}>
            New Workspace
          </button>
          <div class="sidebar-section">
            <p class="section-label">Workspaces</p>
            <For each={workspaces()}>
              {(workspace) => (
                <button
                  classList={{ "nav-item": true, active: workspace.id === activeWorkspace()?.id }}
                  onClick={() =>
                    syncClient.mutate({
                      type: "set-value",
                      key: VALUES.activeWorkspaceId,
                      value: workspace.id,
                    })
                  }
                >
                  <strong>{workspace.name}</strong>
                  <span>{workspace.defaultSearchMode ? "Search on" : "Search off"}</span>
                </button>
              )}
            </For>
          </div>
          <div class="sidebar-section">
            <p class="section-label">Threads</p>
            <For each={threads()}>
              {(thread) => (
                <button
                  classList={{ "nav-item": true, active: thread.id === activeThread()?.id }}
                  onClick={() =>
                    syncClient.mutate({
                      type: "set-value",
                      key: VALUES.activeThreadId,
                      value: thread.id,
                    })
                  }
                >
                  <strong>{thread.title}</strong>
                  <span>{new Date(thread.updatedAt).toLocaleString()}</span>
                </button>
              )}
            </For>
          </div>
        </aside>

        <main class="main-pane">
          <header class="workspace-header">
            <div>
              <p class="eyebrow">Workspace</p>
              <h2>{activeWorkspace()?.name}</h2>
              <p>
                {activeWorkspace()?.systemPrompt || "No system prompt set for this workspace yet."}
              </p>
            </div>
          </header>

          <section class="timeline">
            <For each={messages()}>
              {(message) => (
                <article
                  classList={{
                    bubble: true,
                    assistant: message.role === "assistant",
                    user: message.role === "user",
                  }}
                >
                  <header>
                    <strong>{message.role === "assistant" ? "Assistant" : "You"}</strong>
                    <span>{message.status}</span>
                  </header>
                  <p>{message.text || "…"}</p>
                  <Show when={searchResults().get(message.id)?.length}>
                    <div class="search-block">
                      <p>Searched the web</p>
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
              placeholder="Type your message here..."
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
              <button class="primary-button" disabled={composer.sending} onClick={sendMessage}>
                {composer.sending ? "Sending…" : "Send"}
              </button>
            </div>
          </footer>
        </main>
      </div>
    </Show>
  );
}
