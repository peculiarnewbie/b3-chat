import { getRuntimeEnv, requireSession, verifyUploadToken } from "@b3-chat/server";

function readObjectKey(url: URL) {
  const index = url.pathname.indexOf("/api/uploads/blob/");
  return decodeURIComponent(url.pathname.slice(index + "/api/uploads/blob/".length));
}

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

export async function handleUploadBlobPut(request: Request): Promise<Response> {
  const env = getRuntimeEnv();
  await requireSession(request, env);
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) return new Response("Missing token", { status: 401 });
  const payload = await verifyUploadToken(env, token);
  if (!payload) return new Response("Invalid token", { status: 401 });
  if (Number(payload.expiresAt ?? 0) < Date.now())
    return new Response("Expired token", { status: 401 });

  const objectKey = readObjectKey(url);
  if (objectKey !== payload.objectKey) return new Response("Key mismatch", { status: 401 });

  const contentType =
    request.headers.get("content-type") ?? asString(payload.mimeType, "application/octet-stream");
  await env.UPLOADS.put(objectKey, request.body, {
    httpMetadata: {
      contentType,
    },
    customMetadata: {
      fileName: asString(payload.fileName),
      threadId: asString(payload.threadId),
      attachmentId: asString(payload.attachmentId),
    },
  });

  return Response.json({ ok: true, objectKey });
}

export async function handleUploadBlobGet(request: Request): Promise<Response> {
  const env = getRuntimeEnv();
  const url = new URL(request.url);
  const objectKey = readObjectKey(url);
  const token = url.searchParams.get("token");

  if (token) {
    const payload = await verifyUploadToken(env, token);
    if (!payload) return new Response("Invalid token", { status: 401 });
    if (payload.action !== "read_attachment")
      return new Response("Invalid token action", { status: 401 });
    if (Number(payload.expiresAt ?? 0) < Date.now())
      return new Response("Expired token", { status: 401 });
    if (payload.objectKey !== objectKey) return new Response("Key mismatch", { status: 401 });
  } else {
    await requireSession(request, env);
  }

  const object = await env.UPLOADS.get(objectKey);
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  return new Response(object.body, { headers });
}
