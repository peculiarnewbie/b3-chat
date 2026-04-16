import { createSignal } from "solid-js";
import {
  createThread,
  nowIso,
  type ReasoningLevel,
  type Thread,
  type Workspace,
} from "@b3-chat/domain";

export type DraftAttachmentChip = {
  localId: string;
  attachmentId: string | null;
  threadId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  status: "uploading" | "ready" | "failed";
  previewUrl?: string;
};

export type DraftChatState = {
  workspaceId: string;
  thread: Thread;
  text: string;
  modelId: string;
  reasoningLevel: ReasoningLevel;
  search: boolean;
  attachments: DraftAttachmentChip[];
  updatedAt: string;
};

export type WorkspaceConversationView = "thread" | "draft";

type PersistedDraftAttachmentChip = Omit<DraftAttachmentChip, "previewUrl">;
type PersistedDraftChatState = Omit<DraftChatState, "attachments"> & {
  attachments: PersistedDraftAttachmentChip[];
};
type DraftAttachmentCleanup = Pick<DraftAttachmentChip, "localId" | "attachmentId" | "previewUrl">;

const DRAFTS_KEY = "b3.workspaceDrafts";
const VIEWS_KEY = "b3.workspaceDraftViews";

function readJson<T>(key: string, fallback: T): T {
  if (typeof localStorage === "undefined") return fallback;
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function persistJson(key: string, value: unknown) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(key, JSON.stringify(value));
}

function omit<T extends object>(value: T, key: string) {
  const next = { ...value } as Record<string, unknown>;
  delete next[key];
  return next as T;
}

let restoredCleanup: DraftAttachmentCleanup[] = [];
let strippedPersistedAttachments = false;

function readDrafts() {
  const parsed = readJson<Record<string, PersistedDraftChatState>>(DRAFTS_KEY, {});
  const drafts: Record<string, DraftChatState> = {};

  for (const [workspaceId, draft] of Object.entries(parsed)) {
    if (!draft?.thread?.id) continue;
    if (draft.attachments.length > 0) {
      restoredCleanup.push(
        ...draft.attachments.map((attachment) => ({
          localId: attachment.localId,
          attachmentId: attachment.attachmentId,
        })),
      );
      strippedPersistedAttachments = true;
    }
    drafts[workspaceId] = {
      ...draft,
      attachments: [],
    };
  }

  return drafts;
}

function readViews() {
  return readJson<Record<string, WorkspaceConversationView>>(VIEWS_KEY, {});
}

function serializeDrafts(drafts: Record<string, DraftChatState>) {
  return Object.fromEntries(
    Object.entries(drafts).map(([workspaceId, draft]) => [
      workspaceId,
      {
        ...draft,
        attachments: draft.attachments.map(({ previewUrl: _, ...attachment }) => attachment),
      },
    ]),
  );
}

const [draftsSignal, setDraftsSignal] = createSignal<Record<string, DraftChatState>>(readDrafts());
const [viewsSignal, setViewsSignal] =
  createSignal<Record<string, WorkspaceConversationView>>(readViews());
const [pendingCleanupVersion, setPendingCleanupVersion] = createSignal(0);

if (strippedPersistedAttachments) {
  persistJson(DRAFTS_KEY, serializeDrafts(draftsSignal()));
}

function writeDrafts(next: Record<string, DraftChatState>) {
  setDraftsSignal(next);
  persistJson(DRAFTS_KEY, serializeDrafts(next));
}

function writeViews(next: Record<string, WorkspaceConversationView>) {
  setViewsSignal(next);
  persistJson(VIEWS_KEY, next);
}

function queueAttachmentCleanup(attachments: DraftAttachmentCleanup[]) {
  if (attachments.length === 0) return;
  restoredCleanup = [...restoredCleanup, ...attachments];
  setPendingCleanupVersion((value) => value + 1);
}

function collectAttachmentCleanup(draft: DraftChatState | undefined) {
  if (!draft) return [];
  return draft.attachments.map((attachment) => ({
    localId: attachment.localId,
    attachmentId: attachment.attachmentId,
    previewUrl: attachment.previewUrl,
  }));
}

export function draftsByWorkspace() {
  return draftsSignal();
}

export function workspaceConversationViews() {
  return viewsSignal();
}

export function getWorkspaceDraft(workspaceId: string | null | undefined) {
  if (!workspaceId) return null;
  return draftsSignal()[workspaceId] ?? null;
}

export function getWorkspaceConversationView(workspaceId: string | null | undefined) {
  if (!workspaceId) return "thread" as const;
  return viewsSignal()[workspaceId] ?? "thread";
}

export function ensureWorkspaceDraft(input: {
  workspace: Workspace;
  modelId: string;
  reasoningLevel: ReasoningLevel;
  search: boolean;
}) {
  const existing = getWorkspaceDraft(input.workspace.id);
  if (existing) return existing;

  const draft: DraftChatState = {
    workspaceId: input.workspace.id,
    thread: createThread({ workspaceId: input.workspace.id }),
    text: "",
    modelId: input.modelId,
    reasoningLevel: input.reasoningLevel,
    search: input.search,
    attachments: [],
    updatedAt: nowIso(),
  };
  writeDrafts({
    ...draftsSignal(),
    [input.workspace.id]: draft,
  });
  return draft;
}

export function updateWorkspaceDraft(
  workspaceId: string,
  updater: (draft: DraftChatState) => DraftChatState,
) {
  const current = getWorkspaceDraft(workspaceId);
  if (!current) return null;
  const next = updater(current);
  writeDrafts({
    ...draftsSignal(),
    [workspaceId]: {
      ...next,
      updatedAt: next.updatedAt ?? nowIso(),
    },
  });
  return next;
}

export function replaceWorkspaceDraftAttachments(
  workspaceId: string,
  attachments: DraftAttachmentChip[],
) {
  return updateWorkspaceDraft(workspaceId, (draft) => ({
    ...draft,
    attachments,
    updatedAt: nowIso(),
  }));
}

export function upsertWorkspaceDraftAttachment(
  workspaceId: string,
  attachment: DraftAttachmentChip,
) {
  return updateWorkspaceDraft(workspaceId, (draft) => {
    const existing = draft.attachments.some((item) => item.localId === attachment.localId);
    return {
      ...draft,
      attachments: existing
        ? draft.attachments.map((item) => (item.localId === attachment.localId ? attachment : item))
        : [...draft.attachments, attachment],
      updatedAt: nowIso(),
    };
  });
}

export function removeWorkspaceDraftAttachment(workspaceId: string, localId: string) {
  const draft = getWorkspaceDraft(workspaceId);
  if (!draft) return null;
  const removed = draft.attachments.find((attachment) => attachment.localId === localId) ?? null;
  if (!removed) return null;
  replaceWorkspaceDraftAttachments(
    workspaceId,
    draft.attachments.filter((attachment) => attachment.localId !== localId),
  );
  return removed;
}

export function activateWorkspaceDraftView(workspaceId: string) {
  writeViews({
    ...viewsSignal(),
    [workspaceId]: "draft",
  });
}

export function activateWorkspaceThreadView(workspaceId: string) {
  writeViews({
    ...viewsSignal(),
    [workspaceId]: "thread",
  });
}

export function clearWorkspaceDraft(workspaceId: string) {
  const draft = getWorkspaceDraft(workspaceId);
  queueAttachmentCleanup(collectAttachmentCleanup(draft ?? undefined));
  writeDrafts(omit(draftsSignal(), workspaceId));
  writeViews({
    ...viewsSignal(),
    [workspaceId]: "thread",
  });
}

export function finalizeWorkspaceDraft(workspaceId: string) {
  writeDrafts(omit(draftsSignal(), workspaceId));
  writeViews({
    ...viewsSignal(),
    [workspaceId]: "thread",
  });
}

export function clearAllDraftState() {
  restoredCleanup = [];
  setPendingCleanupVersion(0);
  setDraftsSignal({});
  setViewsSignal({});
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(DRAFTS_KEY);
    localStorage.removeItem(VIEWS_KEY);
  }
}

export function reconcileDraftState(workspaces: Workspace[], _threads: Thread[]) {
  const validWorkspaceIds = new Set(
    workspaces.filter((workspace) => !workspace.archivedAt).map((workspace) => workspace.id),
  );

  let nextDrafts = draftsSignal();
  let nextViews = viewsSignal();

  for (const workspaceId of Object.keys(nextDrafts)) {
    if (validWorkspaceIds.has(workspaceId)) continue;
    queueAttachmentCleanup(collectAttachmentCleanup(nextDrafts[workspaceId]));
    nextDrafts = omit(nextDrafts, workspaceId);
  }

  for (const workspaceId of Object.keys(nextViews)) {
    if (validWorkspaceIds.has(workspaceId)) continue;
    nextViews = omit(nextViews, workspaceId);
  }

  if (nextDrafts !== draftsSignal()) {
    writeDrafts(nextDrafts);
  }
  if (nextViews !== viewsSignal()) {
    writeViews(nextViews);
  }
}

export function pendingDraftAttachmentCleanupTick() {
  return pendingCleanupVersion();
}

export function consumePendingDraftAttachmentCleanup() {
  const next = restoredCleanup;
  restoredCleanup = [];
  return next;
}
