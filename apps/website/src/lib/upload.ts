const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

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
  onProgress?.("presigning");

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
  if (!presignRes.ok) throw new Error(`Presign failed: ${presignRes.statusText}`);
  const presignData = (await presignRes.json()) as {
    attachment: UploadResult["attachment"];
    uploadUrl: string;
  };
  const { attachment, uploadUrl } = presignData;

  onProgress?.("uploading");
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    body: file,
    headers: { "Content-Type": file.type || "application/octet-stream" },
  });
  if (!putRes.ok) throw new Error(`Upload failed: ${putRes.statusText}`);

  onProgress?.("completing");
  const completeRes = await fetch("/api/uploads/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ attachment }),
  });
  if (!completeRes.ok) throw new Error(`Complete failed: ${completeRes.statusText}`);

  onProgress?.("ready");

  const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;

  return {
    attachment: { ...attachment, status: "ready" as const },
    previewUrl,
  };
}
