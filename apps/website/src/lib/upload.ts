import { createClientLogger, serializeError } from "./debug-log";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const logger = createClientLogger("upload");

const ALLOWED_PREFIXES = ["image/", "text/", "application/json"];
const EXTRA_ALLOWED = ["application/pdf", "application/csv"];

export function isAllowedFile(file: File): boolean {
  if (file.size > MAX_FILE_SIZE) return false;
  const mime = file.type || "application/octet-stream";
  return ALLOWED_PREFIXES.some((p) => mime.startsWith(p)) || EXTRA_ALLOWED.includes(mime);
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

export type UploadProgress = "presigning" | "uploading" | "completing" | "ready";

export type UploadResult = {
  attachment: {
    id: string;
    threadId: string;
    messageId: string | null;
    objectKey: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    status: "ready";
  };
  previewUrl?: string;
};

export async function uploadFile(
  file: File,
  threadId: string,
  onProgress?: (status: UploadProgress) => void,
): Promise<UploadResult> {
  logger.log("start", {
    threadId,
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
    sizeBytes: file.size,
  });
  onProgress?.("presigning");

  try {
    const presignRes = await fetch("/api/uploads/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sizeBytes: file.size,
        mimeType: file.type || "application/octet-stream",
        fileName: file.name,
        threadId,
      }),
    });
    logger.log("presign_response", {
      ok: presignRes.ok,
      status: presignRes.status,
      statusText: presignRes.statusText,
    });
    if (!presignRes.ok) throw new Error(`Presign failed: ${presignRes.statusText}`);
    const presignData = (await presignRes.json()) as {
      attachment: UploadResult["attachment"];
      uploadUrl: string;
    };
    const { attachment, uploadUrl } = presignData;
    logger.log("presign_success", {
      attachmentId: attachment.id,
      objectKey: attachment.objectKey,
      threadId: attachment.threadId,
    });

    onProgress?.("uploading");
    const putRes = await fetch(uploadUrl, {
      method: "PUT",
      body: file,
      headers: { "Content-Type": file.type || "application/octet-stream" },
    });
    logger.log("upload_response", {
      attachmentId: attachment.id,
      ok: putRes.ok,
      status: putRes.status,
      statusText: putRes.statusText,
    });
    if (!putRes.ok) throw new Error(`Upload failed: ${putRes.statusText}`);

    onProgress?.("completing");
    const completeRes = await fetch("/api/uploads/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attachment }),
    });
    logger.log("complete_response", {
      attachmentId: attachment.id,
      ok: completeRes.ok,
      status: completeRes.status,
      statusText: completeRes.statusText,
    });
    if (!completeRes.ok) throw new Error(`Complete failed: ${completeRes.statusText}`);

    onProgress?.("ready");

    const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
    logger.log("complete_success", {
      attachmentId: attachment.id,
      objectKey: attachment.objectKey,
      previewReady: Boolean(previewUrl),
    });

    return {
      attachment: { ...attachment, status: "ready" as const },
      previewUrl,
    };
  } catch (error) {
    logger.error("failed", {
      threadId,
      fileName: file.name,
      ...serializeError(error),
    });
    throw error;
  }
}
