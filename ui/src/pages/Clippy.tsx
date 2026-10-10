import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ChatSession } from "../api/chat";
import { useActiveCompanyId } from "../hooks/useRouteCompany";
import { useClippyGreetingName } from "../hooks/useClippyPage";
import { ClippyConversation } from "../components/ClippyConversation";
import { ClippySessionRail, useClippySessionList } from "../components/ClippySessionRail";
import { resolveActiveClippySessionId } from "../lib/clippy-company-scope";
import { cn } from "../lib/utils";

export function Clippy() {
  const qc = useQueryClient();
  // URL-derived, not useCompany()'s selection state (P4 sweep, 2026-09-03):
  // this page WRITES (a new chat session is tagged with this companyId on
  // its first send). See Calendar.tsx's/NewAgent.tsx's identical fix.
  const selectedCompanyId = useActiveCompanyId();
  const greetingName = useClippyGreetingName();
  const list = useClippySessionList();
  const { sessions, filters } = list;

  const initialUrlParams = useMemo(() => {
    if (typeof window === "undefined") return { session: null, newChat: false };
    const params = new URLSearchParams(window.location.search);
    return { session: params.get("session"), newChat: params.get("new") === "1" };
  }, []);
  const [activeId, setActiveId] = useState<string | null>(initialUrlParams.session);
  // A new chat the person started. It has no id until its first send, and
  // must not be replaced by the latest chat in the meantime.
  const [drafting, setDrafting] = useState(initialUrlParams.newChat && !initialUrlParams.session);
  /** Only meaningful below md, where the chat list slides over the conversation. */
  const [sessionListOpen, setSessionListOpen] = useState(false);

  useEffect(() => {
    const resolved = resolveActiveClippySessionId({
      companyScope: filters.companyScope,
      activeId,
      sessionIds: sessions.map((s) => s.id),
      drafting,
    });
    if (resolved !== activeId) setActiveId(resolved);
  }, [activeId, sessions, filters.companyScope, drafting]);

  const openChat = (id: string) => {
    setDrafting(false);
    setActiveId(id);
    // Picking a chat on a phone should show it, not leave the list sitting
    // over the top of it.
    setSessionListOpen(false);
  };

  const startNewChat = () => {
    setDrafting(true);
    setActiveId(null);
    setSessionListOpen(false);
  };

  const onSessionCreated = (session: ChatSession) => {
    // Into the list as filtered now, so the company scope check above finds
    // it before the list's own refetch comes back.
    qc.setQueryData<ChatSession[]>(list.queryKey, (prev) =>
      prev ? [session, ...prev.filter((s) => s.id !== session.id)] : prev,
    );
    openChat(session.id);
  };

  return (
    <div className="relative flex h-full min-h-0">
      {/* On a phone the chat list would otherwise take a third of the screen
          for good, so below md it slides over the conversation instead. */}
      {sessionListOpen ? (
        <button
          type="button"
          aria-label="Close the chat list"
          onClick={() => setSessionListOpen(false)}
          className="absolute inset-0 z-20 bg-black/50 md:hidden"
        />
      ) : null}
      <ClippySessionRail
        list={list}
        activeId={activeId}
        onSelect={openChat}
        onNewChat={startNewChat}
        onDeleted={(id) => {
          if (activeId === id) setActiveId(null);
        }}
        onArchiveChanged={(session) => {
          // Drop the active session if archiving made it disappear from the
          // current filter. The user can switch filters or pick another chat.
          if (activeId === session.id && filters.status === "active" && session.archivedAt) {
            setActiveId(null);
          }
        }}
        className={cn(
          "absolute inset-y-0 left-0 z-30 md:static md:z-auto md:flex",
          sessionListOpen ? "flex" : "hidden",
        )}
      />
      <main className="min-w-0 flex-1">
        <ClippyConversation
          sessionId={activeId}
          onOpenSessionList={() => setSessionListOpen(true)}
          onNewSessionForCurrentCompany={startNewChat}
          newChatCompanyId={selectedCompanyId}
          onSessionCreated={onSessionCreated}
          greetingName={greetingName}
        />
      </main>
    </div>
  );
}
