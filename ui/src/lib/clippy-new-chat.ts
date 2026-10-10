import type { ChatSession, EffortLevel, PermissionMode } from "../api/chat";

/**
 * A new chat is created on its first send, not when Clippy opens or "New
 * chat" is pressed. Creating it up front left most chats titled "New chat":
 * the server only names a chat from its first message, and a chat nobody
 * typed into never gets one.
 *
 * Until that first send, the choices made in the options control live in
 * the composer as these settings, and are applied when the chat is created.
 */
export interface ClippyNewChatSettings {
  /** An empty string leaves the choice to the server, which picks the best available model. */
  model: string;
  permissionMode: PermissionMode;
  effort: EffortLevel;
}

export const DEFAULT_NEW_CHAT_SETTINGS: ClippyNewChatSettings = {
  model: "",
  permissionMode: "ask",
  effort: "auto",
};

export interface ClippyNewChatDraft extends ClippyNewChatSettings {
  companyId: string | null;
  /** Null when there is no page to name, or the context chip was removed. */
  pageContext: string | null;
}

/** CLI models run unattended, so the server always gives them bypass permissions. */
export function isAdapterModel(model: string | null | undefined): boolean {
  return Boolean(model && model.startsWith("adapter:"));
}

interface NewChatApi {
  createSession: (input: {
    companyId?: string | null;
    permissionMode?: PermissionMode;
    model?: string;
    pageContext?: string | null;
  }) => Promise<{ session: ChatSession }>;
  patchSession: (
    id: string,
    patch: { effort?: EffortLevel; model?: string; permissionMode?: PermissionMode },
  ) => Promise<{ session: ChatSession }>;
}

/**
 * Where a new chat's first send got to. The composer keeps one per new chat
 * and passes it back on a retry.
 */
export interface ClippyFirstSendProgress {
  /**
   * The chat, once the server has made it. Kept even when the step after
   * fails, so a retry carries on with this chat instead of making a second
   * one and leaving the first behind as an empty "New chat".
   */
  session: ChatSession | null;
}

/**
 * Create the chat a first message goes to, with everything chosen before
 * it was sent. The server's create call takes no effort, so an effort other
 * than its default is set straight after, before the message is sent. On a
 * retry the chat already exists, so only what differs from it is changed,
 * including anything picked again in the options after the failed try.
 */
export async function createChatForFirstSend(
  api: NewChatApi,
  draft: ClippyNewChatDraft,
  progress: ClippyFirstSendProgress = { session: null },
): Promise<ChatSession> {
  const reusing = progress.session !== null;
  if (!progress.session) {
    const { session } = await api.createSession({
      companyId: draft.companyId,
      permissionMode: draft.permissionMode,
      ...(draft.model ? { model: draft.model } : {}),
      pageContext: draft.pageContext,
    });
    progress.session = session;
  }
  const session: ChatSession = progress.session;
  const patch: { effort?: EffortLevel; model?: string; permissionMode?: PermissionMode } = {};
  if (draft.effort !== session.effort) patch.effort = draft.effort;
  if (reusing) {
    if (draft.model && draft.model !== session.model) patch.model = draft.model;
    if (draft.permissionMode !== session.permissionMode) patch.permissionMode = draft.permissionMode;
  }
  if (Object.keys(patch).length === 0) return session;
  const { session: updated } = await api.patchSession(session.id, patch);
  progress.session = updated;
  return updated;
}
