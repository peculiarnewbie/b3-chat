import { createAttachment } from "@b3-chat/domain";
import { createUploadUrl, getRuntimeEnv, requireSession, signUploadToken } from "@b3-chat/server";

const MAX_FILE_SIZE = 10 * 1024 * 1024;

function asString(value: unknown, fallback: string) {
  return typeof value === "string" ? value : fallback;
}

export async function handleUploadPresign(request: Request): Promise<Response> {
  const env = getRuntimeEnv();
  await requireSession(request, env);
  const body = (await request.json()) as {
    sizeBytes?: unknown;
    mimeType?: unknown;
    fileName?: unknown;
    threadId?: unknown;
  };
  const sizeBytes = Number(body.sizeBytes ?? 0);
  const mimeType = asString(body.mimeType, "application/octet-stream");
  const fileName = asString(body.fileName, "upload.bin");
  const threadId = asString(body.threadId, "");

  if (!threadId) return new Response("Missing threadId", { status: 400 });
  if (sizeBytes <= 0 || sizeBytes > MAX_FILE_SIZE)
    return new Response("Invalid file size", { status: 400 });

  const objectKey = `${threadId}/${crypto.randomUUID()}-${fileName.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
  const attachment = createAttachment({
    threadId,
    objectKey,
    fileName,
    mimeType,
    sizeBytes,
  });
  const token = await signUploadToken(env, {
    attachmentId: attachment.id,
    objectKey,
    threadId,
    fileName,
    mimeType,
    sizeBytes,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  const uploadUrl = await createUploadUrl(request, objectKey);

  return Response.json({
    attachment,
    uploadUrl: `${uploadUrl}?token=${encodeURIComponent(token)}`,
    method: "PUT",
  });
}
