import { getRuntimeEnv, requireSession, sendInternalSyncCommand } from "@g3-chat/server";
import { decodeAttachmentRow } from "@g3-chat/domain";

export async function handleUploadComplete(request: Request): Promise<Response> {
  const env = getRuntimeEnv();
  await requireSession(request, env);
  const body = (await request.json()) as { attachment: unknown };
  const attachment = decodeAttachmentRow(body.attachment);
  const object = await env.UPLOADS.head(attachment.objectKey);
  if (!object) return new Response("Uploaded object not found", { status: 404 });

  await sendInternalSyncCommand(env, "complete_attachment", {
    attachment: {
      ...attachment,
      status: "ready",
      sizeBytes: object.size,
      updatedAt: new Date().toISOString(),
      optimistic: false,
      opId: attachment.opId,
    },
  });

  return Response.json({
    ok: true,
    objectKey: attachment.objectKey,
  });
}
