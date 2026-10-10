import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { chatApi, type ChatSession } from "../api/chat";
import { clippyStreamManager } from "../lib/clippy-stream-manager";

interface ClippySessionActionOptions {
  onDeleted?: (id: string) => void;
  onArchiveChanged?: (session: ChatSession) => void;
}

/** Every cached chat list, with one chat replaced or taken out. */
function updateCachedLists(
  qc: ReturnType<typeof useQueryClient>,
  update: (sessions: ChatSession[]) => ChatSession[],
) {
  qc.setQueriesData<ChatSession[]>({ queryKey: ["clippy", "sessions"] }, (prev) =>
    Array.isArray(prev) ? update(prev) : prev,
  );
}

/**
 * Rename, archive and delete for a Clippy chat. The window's chat menu, its
 * full screen list and the full Clippy page all use this, so a change made in
 * one shows in the others straight away rather than after their next fetch.
 */
export function useClippySessionActions(options: ClippySessionActionOptions = {}) {
  const qc = useQueryClient();
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const afterSessionChange = (session: ChatSession) => {
    qc.setQueryData(["clippy", "session", session.id], session);
    updateCachedLists(qc, (sessions) => sessions.map((s) => (s.id === session.id ? session : s)));
    qc.invalidateQueries({ queryKey: ["clippy", "sessions"] });
  };

  const renameMutation = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      chatApi.patchSession(id, { title }).then((r) => r.session),
    onSuccess: afterSessionChange,
  });

  const archiveMutation = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      chatApi.patchSession(id, { archived }).then((r) => r.session),
    onSuccess: (session) => {
      afterSessionChange(session);
      optionsRef.current.onArchiveChanged?.(session);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => chatApi.deleteSession(id),
    onSuccess: (_, id) => {
      // Drop any in-flight stream state for the deleted session so a
      // pending permission prompt stops counting toward the launcher badge.
      clippyStreamManager.disposeSession(id);
      updateCachedLists(qc, (sessions) => sessions.filter((s) => s.id !== id));
      qc.invalidateQueries({ queryKey: ["clippy", "sessions"] });
      optionsRef.current.onDeleted?.(id);
    },
  });

  return {
    rename: (id: string, title: string) => renameMutation.mutate({ id, title }),
    setArchived: (id: string, archived: boolean) => archiveMutation.mutate({ id, archived }),
    remove: (id: string) => deleteMutation.mutate(id),
  };
}
