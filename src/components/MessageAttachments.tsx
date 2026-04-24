import { For, Show } from "solid-js";

type ImageAttachment = {
  objectKey: string;
  fileName: string;
};

type FileAttachment = {
  fileName: string;
};

type MessageAttachmentsProps = {
  images: ImageAttachment[];
  files: FileAttachment[];
};

export default function MessageAttachments(props: MessageAttachmentsProps) {
  return (
    <>
      <Show when={props.images.length > 0}>
        <div class="msg-attachment-gallery">
          <For each={props.images}>
            {(att) => (
              <a
                class="msg-attachment-card"
                href={`/api/uploads/blob/${att.objectKey}`}
                target="_blank"
                rel="noreferrer"
              >
                <img
                  class="msg-attachment-img"
                  src={`/api/uploads/blob/${att.objectKey}`}
                  alt={att.fileName}
                  loading="lazy"
                />
              </a>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.files.length > 0}>
        <div class="msg-attachments msg-attachments-files">
          <For each={props.files}>
            {(att) => <span class="msg-attachment-file">{att.fileName}</span>}
          </For>
        </div>
      </Show>
    </>
  );
}
