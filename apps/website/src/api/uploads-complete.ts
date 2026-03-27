import { getRuntimeEnv, requireSession, syncMutate } from "@g3-chat/server";
import { decodeAttachmentRow } from "@g3-chat/domain";

export async function handleUploadComplete(request: Request): Promise<Response> {
  const env = getRuntimeEnv();
  await requireSession(request, env);
  const body = (await request.json()) as { attachment: unknown };
  const attachment = decodeAttachmentRow(body.attachment);
  const object = await env.UPLOADS.head(attachment.objectKey);
  if (!object) return new Response("Uploaded object not found", { status: 404 });

  await syncMutate(env, {
    type: "upsert-attachment",
    row: {
      ...attachment,
      status: "ready",
      sizeBytes: object.size,
    },
  });

  return Response.json({
    ok: true,
    objectKey: attachment.objectKey,
  });
}
