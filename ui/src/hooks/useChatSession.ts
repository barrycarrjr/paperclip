import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  chatApi,
  type ChatContentBlock,
  type ChatMessage,
  type ChatSession,
} from "../api/chat";
import {
  clippyStreamManager,
  type ClippyTranscriptEntry,
  type PendingPermission,
  type SessionStreamState,
} from "../lib/clippy-stream-manager";

export type { ClippyTranscriptEntry } from "../lib/clippy-stream-manager";

export interface UseChatSessionResult {
  session: ChatSession | null;
  messages: ChatMessage[];
  transcript: ClippyTranscriptEntry[];
  loading: boolean;
  streaming: boolean;
  pendingPermissions: PendingPermission[];
  send: (text: string, attachmentIds?: string[]) => Promise<void>;
  /** Abort the in-flight stream and immediately start a new turn. */
  abortAndSend: (text: string, attachmentIds?: string[]) => Promise<void>;
  decidePermission: (toolUseId: string, decision: "approve" | "deny") => Promise<void>;
  patchSession: (
    patch: Parameters<typeof chatApi.patchSession>[1],
  ) => Promise<ChatSession | null>;
  abort: () => void;
}

const EMPTY_STATE: SessionStreamState = {
  streaming: false,
  pendingAssistant: null,
  pendingPermissions: [],
};

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

  // Subscribe to the cross-window stream manager. The manager owns the SSE
  // connection so it survives drawer unmounts (e.g. when the user pops out
  // mid-stream) and is mirrored to other windows over BroadcastChannel.
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

  const refresh = useCallback(() => {
    if (!sessionId) return;
    qc.invalidateQueries({ queryKey: ["clippy", "messages", sessionId] });
    qc.invalidateQueries({ queryKey: ["clippy", "session", sessionId] });
  }, [qc, sessionId]);

  const refreshSessionsList = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["clippy", "sessions"] });
  }, [qc]);

  // Register the refresh hooks so the manager can poke react-query when
  // server-side state changes (message persisted, session renamed, etc).
  useEffect(() => {
    if (!sessionId) return;
    clippyStreamManager.setRefreshCallbacks(sessionId, {
      onMessage: refresh,
      onDone: () => {
        refresh();
        refreshSessionsList();
      },
    });
  }, [sessionId, refresh, refreshSessionsList]);

  const send = useCallback(
    async (text: string, attachmentIds: string[] = [], opts: { force?: boolean } = {}) => {
      if (!sessionId) throw new Error("No active session");
      const current = clippyStreamManager.getSnapshot(sessionId);
      if (current.streaming && !opts.force) {
        throw new Error("A turn is already streaming");
      }
      if (opts.force) clippyStreamManager.abortLocal(sessionId);

      // Optimistically add the user message so it renders immediately. The
      // canonical version replaces it once `message_completed` fires and the
      // refresh callback re-pulls messages.
      const optimisticBlocks: ChatContentBlock[] = [];
      if (text.length > 0) optimisticBlocks.push({ type: "text", text });
      qc.setQueryData<ChatMessage[] | undefined>(
        ["clippy", "messages", sessionId],
        (prev) => [
          ...(prev ?? []),
          {
            id: `optimistic-user-${Date.now()}`,
            sessionId,
            role: "user",
            content: optimisticBlocks,
            createdAt: new Date().toISOString(),
          },
        ],
      );

      const handle = clippyStreamManager.startTurn(sessionId, text, attachmentIds);
      await handle.done;
    },
    [qc, sessionId],
  );

  const decidePermission = useCallback(
    async (toolUseId: string, decision: "approve" | "deny") => {
      if (!sessionId) return;
      try {
        await chatApi.decidePermission(sessionId, toolUseId, decision);
        // No optimistic local mutation: the resulting `tool_result_block` or
        // next stream event clears the pending permission across all windows
        // via the BroadcastChannel mirror.
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
  const transcript: ClippyTranscriptEntry[] = messages.map((m) => ({
    id: m.id,
    role: m.role,
    blocks: m.content,
  }));
  if (streamState.pendingAssistant) {
    if (!messages.some((m) => m.id === streamState.pendingAssistant!.id)) {
      transcript.push(streamState.pendingAssistant);
    }
  }

  return {
    session: sessionQuery.data ?? null,
    messages,
    transcript,
    loading: sessionQuery.isLoading || messagesQuery.isLoading,
    streaming: streamState.streaming,
    pendingPermissions: streamState.pendingPermissions,
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
