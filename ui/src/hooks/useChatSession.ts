import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  chatApi,
  type ChatContentBlock,
  type ChatMessage,
  type ChatSession,
} from "../api/chat";
import {
  clippyStreamManager,
  EMPTY_STREAM_STATE,
  type ClippyTranscriptEntry,
  type LiveToolCall,
  type PendingPermission,
  type SessionStreamState,
} from "../lib/clippy-stream-manager";
import { mergeTranscript } from "../lib/clippy-transcript";
import { parseInlineConsentReply } from "@paperclipai/shared";

export type { ClippyTranscriptEntry } from "../lib/clippy-stream-manager";

export interface UseChatSessionResult {
  session: ChatSession | null;
  messages: ChatMessage[];
  transcript: ClippyTranscriptEntry[];
  loading: boolean;
  streaming: boolean;
  pendingPermissions: PendingPermission[];
  /** Live per-tool-call state (badges, streamed results, timing). */
  liveToolCalls: Record<string, LiveToolCall>;
  /** Epoch ms of the last stream event, for the quiet-stream indicator. */
  lastEventAt: number | null;
  send: (text: string, attachmentIds?: string[]) => Promise<void>;
  /** Abort the in-flight stream and immediately start a new turn. */
  abortAndSend: (text: string, attachmentIds?: string[]) => Promise<void>;
  decidePermission: (toolUseId: string, decision: "approve" | "deny") => Promise<void>;
  patchSession: (
    patch: Parameters<typeof chatApi.patchSession>[1],
  ) => Promise<ChatSession | null>;
  abort: () => void;
}

const EMPTY_STATE: SessionStreamState = EMPTY_STREAM_STATE;

/**
 * What the stream manager pokes when the server says something changed: the
 * chat's messages and its own record (a first turn renames it), and the chat
 * lists once the turn is over.
 */
export function clippyRefreshCallbacks(qc: QueryClient, sessionId: string) {
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["clippy", "messages", sessionId] });
    qc.invalidateQueries({ queryKey: ["clippy", "session", sessionId] });
  };
  return {
    onMessage: refresh,
    onDone: () => {
      refresh();
      qc.invalidateQueries({ queryKey: ["clippy", "sessions"] });
    },
  };
}

/**
 * Put the person's message on screen straight away and start the turn.
 * Resolves as soon as the turn has started, with `done` for when it ends.
 *
 * `done` comes back inside an object on purpose. An async function that
 * returns a promise directly hands back that promise's own result, so
 * awaiting this would have waited for the whole reply, and a chat made by its
 * first send only opened once the reply had finished.
 *
 * Any fetch of the messages still in flight is cancelled first. A chat made
 * by its first send is opened while that message goes out, and its first
 * fetch can answer "no messages yet" after the message was written here,
 * which wiped it off the screen until the reply arrived.
 */
export async function beginClippyTurn(
  qc: QueryClient,
  sessionId: string,
  text: string,
  attachmentIds: string[],
): Promise<{ done: Promise<void> }> {
  const messagesKey = ["clippy", "messages", sessionId];
  await qc.cancelQueries({ queryKey: messagesKey });
  // Optimistically add the user message so it renders immediately. The
  // canonical version replaces it once `message_completed` fires and the
  // refresh callback re-pulls messages.
  const optimisticBlocks: ChatContentBlock[] = [];
  if (text.length > 0) optimisticBlocks.push({ type: "text", text });
  qc.setQueryData<ChatMessage[] | undefined>(messagesKey, (prev) => [
    ...(prev ?? []),
    {
      id: `optimistic-user-${Date.now()}`,
      sessionId,
      role: "user",
      content: optimisticBlocks,
      createdAt: new Date().toISOString(),
    },
  ]);
  const handle = clippyStreamManager.startTurn(sessionId, text, attachmentIds);
  return { done: handle.done };
}

export function useChatSession(sessionId: string | null): UseChatSessionResult {
  const qc = useQueryClient();
  const sessionQuery = useQuery({
    queryKey: ["clippy", "session", sessionId],
    queryFn: () => chatApi.getSession(sessionId as string).then((r) => r.session),
    enabled: !!sessionId,
  });
  const messagesQuery = useQuery({
    queryKey: ["clippy", "messages", sessionId],
    queryFn: () => chatApi.listMessages(sessionId as string).then((r) => r.messages),
    enabled: !!sessionId,
  });

  // Subscribe to the stream manager. The manager owns the SSE connection, so
  // it survives this hook unmounting (closing Clippy, switching its layout).
  // It is not shared with other browser windows: a pop-out cannot see a turn
  // this window is streaming, which is why pop-out waits for it to finish.
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!sessionId) return () => {};
      return clippyStreamManager.subscribe(sessionId, listener);
    },
    [sessionId],
  );
  const getSnapshot = useCallback((): SessionStreamState => {
    if (!sessionId) return EMPTY_STATE;
    return clippyStreamManager.getSnapshot(sessionId);
  }, [sessionId]);
  const streamState = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Register the refresh hooks so the manager can poke react-query when
  // server-side state changes (message persisted, session renamed, etc).
  useEffect(() => {
    if (!sessionId) return;
    clippyStreamManager.setRefreshCallbacks(sessionId, clippyRefreshCallbacks(qc, sessionId));
  }, [qc, sessionId]);

  const send = useCallback(
    async (text: string, attachmentIds: string[] = [], opts: { force?: boolean } = {}) => {
      if (!sessionId) throw new Error("No active session");
      const current = clippyStreamManager.getSnapshot(sessionId);
      if (!opts.force && current.streaming && current.pendingPermissions.length === 1 && attachmentIds.length === 0) {
        const decision = parseInlineConsentReply(text);
        if (decision) {
          await chatApi.decidePermission(sessionId, current.pendingPermissions[0].toolUseId, decision, text);
          await qc.invalidateQueries({ queryKey: ["clippy", "messages", sessionId] });
          return;
        }
      }
      if (current.streaming && !opts.force) {
        throw new Error("A turn is already streaming");
      }
      if (opts.force) clippyStreamManager.abortLocal(sessionId);

      const { done } = await beginClippyTurn(qc, sessionId, text, attachmentIds);
      await done;
    },
    [qc, sessionId],
  );

  const decidePermission = useCallback(
    async (toolUseId: string, decision: "approve" | "deny") => {
      if (!sessionId) return;
      try {
        await chatApi.decidePermission(sessionId, toolUseId, decision);
        // No optimistic local mutation: the resulting `tool_result_block` or
        // next stream event clears the pending permission through the stream
        // manager.
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Surface as an inline error; the manager doesn't expose a generic
        // "append to pending" helper so we just log — react-query will pick
        // up the canonical state on the next refresh.
        console.error("Failed to record permission decision:", message);
      }
    },
    [sessionId],
  );

  const patchSession = useCallback(
    async (patch: Parameters<typeof chatApi.patchSession>[1]) => {
      if (!sessionId) return null;
      const { session } = await chatApi.patchSession(sessionId, patch);
      qc.setQueryData(["clippy", "session", sessionId], session);
      qc.invalidateQueries({ queryKey: ["clippy", "sessions"] });
      return session;
    },
    [qc, sessionId],
  );

  const messages = messagesQuery.data ?? [];
  const transcript: ClippyTranscriptEntry[] = mergeTranscript(
    messages,
    streamState.pendingAssistant,
  );

  return {
    session: sessionQuery.data ?? null,
    messages,
    transcript,
    loading: sessionQuery.isLoading || messagesQuery.isLoading,
    streaming: streamState.streaming,
    pendingPermissions: streamState.pendingPermissions,
    liveToolCalls: streamState.toolCalls,
    lastEventAt: streamState.lastEventAt,
    send,
    abortAndSend: (text, attachmentIds) => send(text, attachmentIds, { force: true }),
    decidePermission,
    patchSession,
    abort: () => {
      if (!sessionId) return;
      clippyStreamManager.abortLocal(sessionId);
    },
  };
}
