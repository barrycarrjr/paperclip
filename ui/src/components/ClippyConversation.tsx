import { useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PanelLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useParams } from "@/lib/router";
import { chatApi, type ChatSession } from "../api/chat";
import { useCompanyOptional } from "../context/CompanyContext";
import { resolveRouteCompanyId } from "../hooks/useRouteCompany";
import { beginClippyTurn, clippyRefreshCallbacks, useChatSession } from "../hooks/useChatSession";
import { clippyStreamManager } from "../lib/clippy-stream-manager";
import { createChatForFirstSend, type ClippyFirstSendProgress } from "../lib/clippy-new-chat";
import { suggestedClippyPrompts, type ClippyPageContext } from "../lib/clippy-page-context";
import { ClippyComposer, type ClippyComposerHandle, type ClippyFirstSendSettings } from "./ClippyComposer";
import { ClippyEmptyState } from "./ClippyEmptyState";
import { ClippyMessageList } from "./ClippyMessageList";

interface Props {
  /** The open chat. Null is a new chat, created on the server by its first send. */
  sessionId: string | null;
  /**
   * The title row over the conversation. The Clippy window has a header of
   * its own and leaves this out; the full Clippy page shows it.
   */
  showHeader?: boolean;
  /**
   * Open the chat list. Only reachable below md, where the list is hidden so
   * the conversation gets the whole width of a phone screen.
   */
  onOpenSessionList?: () => void;
  /**
   * Start a new chat for the company being viewed, offered when the open
   * chat belongs to a different one.
   */
  onNewSessionForCurrentCompany?: () => void;
  /** The company a new chat is created for. */
  newChatCompanyId?: string | null;
  /** A new chat's first send created it. Open it. */
  onSessionCreated?: (session: ChatSession) => void;
  /** The page a new chat is told about, shown as a removable chip. */
  pageContext?: ClippyPageContext | null;
  /** First name for the greeting in an empty chat. */
  greetingName?: string | null;
  /** Questions an empty chat suggests. Defaults to general ones. */
  suggestions?: readonly string[];
  /** Put focus in the message box when shown. */
  autoFocus?: boolean;
}

export function ClippyConversation({
  sessionId,
  showHeader = true,
  onOpenSessionList,
  onNewSessionForCurrentCompany,
  newChatCompanyId = null,
  onSessionCreated,
  pageContext = null,
  greetingName = null,
  suggestions,
  autoFocus = true,
}: Props) {
  const qc = useQueryClient();
  const {
    session,
    transcript,
    streaming,
    pendingPermissions,
    liveToolCalls,
    lastEventAt,
    send,
    abortAndSend,
    decidePermission,
    patchSession,
    abort,
  } = useChatSession(sessionId);
  const composerRef = useRef<ClippyComposerHandle | null>(null);
  // The chat on screen now, for work that finishes after a later render: a
  // first send must not open its chat if the person has moved to another.
  const shownSessionIdRef = useRef(sessionId);
  shownSessionIdRef.current = sessionId;

  const companyContext = useCompanyOptional();
  const companies = companyContext?.companies ?? [];
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();
  const routeCompanyId = useMemo(
    () => resolveRouteCompanyId({ companyPrefix, companies }),
    [companyPrefix, companies],
  );
  const activeCompanyId = routeCompanyId ?? companyContext?.selectedCompanyId ?? null;

  const sessionCompany = useMemo(
    () => (session?.companyId ? companies.find((c) => c.id === session.companyId) ?? null : null),
    [session?.companyId, companies],
  );

  const activeCompany = useMemo(
    () => (activeCompanyId ? companies.find((c) => c.id === activeCompanyId) ?? null : null),
    [activeCompanyId, companies],
  );

  const isCompanyMismatch = Boolean(
    sessionId &&
    activeCompany &&
    session?.companyId &&
    activeCompany.id !== session.companyId
  );

  /**
   * A new chat's first send: create it with the choices made so far. The
   * composer passes the same `progress` back on a retry, so a chat made by a
   * try that failed later on is reused rather than made twice.
   */
  const createSession = async (
    settings: ClippyFirstSendSettings,
    progress: ClippyFirstSendProgress,
  ): Promise<string> => {
    const created = await createChatForFirstSend(chatApi, { companyId: newChatCompanyId, ...settings }, progress);
    // Seed what the chat's view reads, so opening it fetches nothing and
    // shows the message being sent from the first frame.
    qc.setQueryData(["clippy", "session", created.id], created);
    if (!qc.getQueryData(["clippy", "messages", created.id])) {
      qc.setQueryData(["clippy", "messages", created.id], []);
    }
    // The view that subscribes to the stream mounts a moment after the turn
    // starts; register its refresh hooks now so no early event is missed.
    clippyStreamManager.setRefreshCallbacks(created.id, clippyRefreshCallbacks(qc, created.id));
    return created.id;
  };

  const handleSend = async (text: string, attachmentIds: string[], createdSessionId?: string) => {
    if (!createdSessionId) return send(text, attachmentIds);
    const { done } = await beginClippyTurn(qc, createdSessionId, text, attachmentIds);
    qc.invalidateQueries({ queryKey: ["clippy", "sessions"] });
    // Open the chat now, while its reply streams in, so the reply and any
    // permission prompt in it are on screen. Not if the person has already
    // gone to another chat: the reply carries on there in the background.
    const created = qc.getQueryData<ChatSession>(["clippy", "session", createdSessionId]);
    if (created && shownSessionIdRef.current === null) onSessionCreated?.(created);
    await done;
  };

  const shownSuggestions = useMemo(
    () => suggestions ?? suggestedClippyPrompts({ pathname: "", companyName: activeCompany?.name ?? null }),
    [suggestions, activeCompany?.name],
  );

  const title = session?.title ?? (sessionId ? "Loading…" : "New chat");

  return (
    <div className="flex h-full min-h-0 flex-col">
      {showHeader ? (
        // The same height as the chat list's header beside it, so the two
        // bottom edges line up.
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-4 text-sm font-medium">
          <div className="flex min-w-0 items-center gap-2">
            {onOpenSessionList ? (
              <Button
                variant="ghost"
                size="icon-sm"
                className="-ml-2 shrink-0 md:hidden"
                aria-label="Show the chat list"
                onClick={onOpenSessionList}
              >
                <PanelLeft className="h-4 w-4" />
              </Button>
            ) : null}
            <span className="min-w-0 truncate">{title}</span>
          </div>
          {sessionCompany ? (
            <div
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted/60 px-2.5 py-0.5 text-xs font-normal text-muted-foreground"
              data-testid="session-company-badge"
            >
              {sessionCompany.brandColor ? (
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: sessionCompany.brandColor }}
                />
              ) : null}
              <span className="truncate max-w-[140px]">{sessionCompany.name}</span>
            </div>
          ) : session ? (
            <div
              className="shrink-0 rounded-full border border-border bg-muted/60 px-2.5 py-0.5 text-xs font-normal text-muted-foreground"
              data-testid="session-company-badge"
            >
              All companies
            </div>
          ) : null}
        </div>
      ) : null}
      {/* One quiet line, not a warning banner: looking at a chat from another
          company is allowed and often deliberate. */}
      {isCompanyMismatch && sessionCompany && activeCompany && (
        <div
          data-testid="company-mismatch-note"
          className="flex items-center gap-1.5 border-b border-border px-4 py-1.5 text-xs text-muted-foreground"
        >
          <span className="min-w-0 truncate">This chat is in {sessionCompany.name}.</span>
          {onNewSessionForCurrentCompany && (
            <button
              type="button"
              className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
              onClick={onNewSessionForCurrentCompany}
            >
              Start one in {activeCompany.name}
            </button>
          )}
        </div>
      )}
      <ClippyMessageList
        transcript={transcript}
        pendingPermissions={pendingPermissions}
        onPermissionDecision={decidePermission}
        streaming={streaming}
        liveToolCalls={liveToolCalls}
        lastEventAt={lastEventAt}
        isAdapterModel={Boolean(session?.model?.startsWith("adapter:"))}
        emptyState={
          <ClippyEmptyState
            greetingName={greetingName}
            suggestions={shownSuggestions}
            onPickSuggestion={(suggestion) => composerRef.current?.submitText(suggestion)}
            disabled={streaming}
          />
        }
      />
      <ClippyComposer
        ref={composerRef}
        // Remount on a chat switch: the composer's draft text and pending
        // attachment uploads are local state that otherwise survives across
        // sessionId changes (this component doesn't unmount between chats),
        // so an unsent draft or in-flight upload for one chat could get sent
        // to a different one after switching (F11's "independent chat scope
        // and drafts"). A new chat gets its own key, so it starts empty too.
        key={sessionId ?? "new-chat"}
        sessionId={sessionId}
        permissionMode={session?.permissionMode ?? "ask"}
        awaitingPermission={pendingPermissions.length === 1}
        effort={session?.effort ?? "auto"}
        // The session's own model. Until the session loads there is none to
        // show, and naming a guessed model here would put a stale id on screen.
        model={session?.model ?? ""}
        streaming={streaming}
        onSend={handleSend}
        onStopAndSend={abortAndSend}
        onAbort={abort}
        onPatch={(patch) => {
          void patchSession(patch);
        }}
        onCreateSession={sessionId ? undefined : createSession}
        pageContext={sessionId ? null : pageContext}
        autoFocus={autoFocus}
      />
    </div>
  );
}
