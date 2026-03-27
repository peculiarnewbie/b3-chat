import {
  buildSearchContext,
  createId,
  createMessage,
  createMessagePart,
  nowIso,
  TABLES,
} from "@g3-chat/domain";
import {
  completeTextAttachment,
  collectChatHistory,
  exaSearch,
  exaMcpSearchContext,
  getRuntimeEnv,
  getSignedAttachmentUrl,
  getSyncSnapshot,
  isImageAttachment,
  isInlineTextAttachment,
  requireSession,
  syncMutate,
} from "@g3-chat/server";

type ChatRequest = {
  userMessageId: string;
  text: string;
  modelId: string;
  search: boolean;
};

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function buildOpenAiMessages(
  env: ReturnType<typeof getRuntimeEnv>,
  snapshot: any,
  threadId: string,
  workspaceId: string,
) {
  const workspace = snapshot.tables?.[TABLES.workspaces]?.[workspaceId];
  const history = await collectChatHistory(snapshot, threadId);
  const attachments = Object.values<any>(snapshot.tables?.[TABLES.attachments] ?? {}).filter(
    (attachment) => attachment.threadId === threadId && attachment.status === "ready",
  );

  const messages: Array<Record<string, unknown>> = [];
  if (workspace?.systemPrompt) {
    messages.push({
      role: "system",
      content: workspace.systemPrompt,
    });
  }

  for (const message of history) {
    const inlineParts: Array<Record<string, unknown> | string> = [];
    if (message.text?.trim()) inlineParts.push(message.text);

    if (message.role === "user") {
      for (const attachment of attachments) {
        if (attachment.messageId && attachment.messageId !== message.id) continue;
        if (isImageAttachment(attachment.mimeType)) {
          inlineParts.push({
            type: "image_url",
            image_url: {
              url: await getSignedAttachmentUrl(env, attachment.objectKey),
            },
          });
          continue;
        }
        if (isInlineTextAttachment(attachment.mimeType, attachment.sizeBytes)) {
          const text = await completeTextAttachment(env, attachment.objectKey);
          if (text)
            inlineParts.push(`Attachment ${attachment.fileName}:\n${text.slice(0, 10_000)}`);
        }
      }
    }

    messages.push({
      role: message.role,
      content:
        inlineParts.length <= 1 && typeof inlineParts[0] === "string"
          ? inlineParts[0]
          : inlineParts,
    });
  }

  return messages;
}

export async function handleChatStream(request: Request): Promise<Response> {
  const env = getRuntimeEnv();
  await requireSession(request, env);
  const body = (await request.json()) as ChatRequest;
  const url = new URL(request.url);
  const threadId = decodeURIComponent(url.pathname.split("/").slice(-2, -1)[0] ?? "");
  const snapshot = (await getSyncSnapshot(env)) as any;
  const thread = snapshot.tables?.[TABLES.threads]?.[threadId];
  if (!thread) return new Response("Thread not found", { status: 404 });
  const workspace = snapshot.tables?.[TABLES.workspaces]?.[thread.workspaceId];
  if (!workspace) return new Response("Workspace not found", { status: 404 });

  const assistantMessage = createMessage({
    threadId,
    role: "assistant",
    modelId: body.modelId || workspace.defaultModelId || env.DEFAULT_MODEL_ID,
    status: "streaming",
    searchEnabled: body.search,
  });
  await syncMutate(env, { type: "upsert-message", row: assistantMessage });

  let searchRows: any[] = [];
  let searchContext = "";
  if (body.search) {
    try {
      if (env.EXA_API_KEY) {
        searchRows = (await exaSearch(env, body.text)).map((row: any) => ({
          ...row,
          id: createId("src"),
          messageId: assistantMessage.id,
        }));
        searchContext = buildSearchContext(searchRows);
      } else {
        searchContext = await exaMcpSearchContext(body.text);
      }
    } catch {
      if (searchRows.length === 0) {
        searchContext = await exaMcpSearchContext(body.text);
      }
    }
  }
  if (searchRows.length) {
    await syncMutate(env, {
      type: "replace-search-results",
      messageId: assistantMessage.id,
      rows: searchRows,
    });
  }

  const messages = await buildOpenAiMessages(env, snapshot, threadId, thread.workspaceId);
  if (searchContext) {
    messages.push({
      role: "system",
      content: searchContext,
    });
  }

  const upstream = await fetch(`${env.OPENCODE_GO_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENCODE_GO_API_KEY}`,
    },
    body: JSON.stringify({
      model: body.modelId || workspace.defaultModelId || env.DEFAULT_MODEL_ID,
      stream: true,
      messages,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    await syncMutate(env, {
      type: "upsert-message",
      row: {
        ...assistantMessage,
        status: "failed",
        updatedAt: nowIso(),
        errorCode: String(upstream.status),
        errorMessage: await upstream.text(),
      },
    });
    return new Response("Upstream chat request failed", { status: 502 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";
      let seq = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
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
            const payload = dataLines.join("\n");
            if (payload === "[DONE]") continue;
            const parsed = JSON.parse(payload);
            const delta = parsed.choices?.[0]?.delta?.content ?? "";
            if (!delta) continue;
            accumulated += delta;
            const part = createMessagePart({
              messageId: assistantMessage.id,
              seq: seq++,
              kind: "text",
              text: delta,
            });
            await syncMutate(env, { type: "upsert-message-part", row: part });
            await syncMutate(env, {
              type: "upsert-message",
              row: {
                ...assistantMessage,
                text: accumulated,
                status: "streaming",
                updatedAt: nowIso(),
              },
            });
            controller.enqueue(
              new TextEncoder().encode(sse("delta", { delta, messageId: assistantMessage.id })),
            );
          }
        }

        await syncMutate(env, {
          type: "upsert-message",
          row: {
            ...assistantMessage,
            text: accumulated,
            status: "completed",
            updatedAt: nowIso(),
          },
        });
        controller.enqueue(
          new TextEncoder().encode(sse("done", { messageId: assistantMessage.id })),
        );
        controller.close();
      } catch (error) {
        await syncMutate(env, {
          type: "upsert-message",
          row: {
            ...assistantMessage,
            text: accumulated,
            status: "failed",
            updatedAt: nowIso(),
            errorCode: "stream_error",
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        });
        controller.error(error);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
