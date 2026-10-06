import { useMemo } from "react";
import { AlertCircle, PanelLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useParams } from "@/lib/router";
import { useCompanyOptional } from "../context/CompanyContext";
import { resolveRouteCompanyId } from "../hooks/useRouteCompany";
import { useChatSession } from "../hooks/useChatSession";
import { ClippyComposer } from "./ClippyComposer";
import { ClippyMessageList } from "./ClippyMessageList";

interface Props {
  sessionId: string | null;
  /**
   * Open the chat list. Only reachable below md, where the list is hidden so
   * the conversation gets the whole width of a phone screen.
   */
  onOpenSessionList?: () => void;
  /**
   * Action to create a new session for the currently viewed company.
   */
  onNewSessionForCurrentCompany?: () => void;
}

export function ClippyConversation({
  sessionId,
  onOpenSessionList,
  onNewSessionForCurrentCompany,
}: Props) {
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
    activeCompany &&
    session?.companyId &&
    activeCompany.id !== session.companyId
  );

  if (!sessionId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
        <p>Pick a chat from the list — or start a new one — to talk to Clippy.</p>
        {onOpenSessionList ? (
          <Button variant="outline" size="sm" className="md:hidden" onClick={onOpenSessionList}>
            <PanelLeft className="mr-1 h-3.5 w-3.5" /> Show chats
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2 text-sm font-medium">
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
          <span className="min-w-0 truncate">{session?.title ?? "Loading…"}</span>
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
      {isCompanyMismatch && sessionCompany && activeCompany && (
        <div
          data-testid="company-mismatch-banner"
          className="flex items-center justify-between gap-3 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs text-amber-900 dark:text-amber-200"
        >
          <div className="flex min-w-0 items-center gap-2">
            <AlertCircle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <span className="truncate">
              This chat is attached to <strong>{sessionCompany.name}</strong>, but you are viewing <strong>{activeCompany.name}</strong>.
            </span>
          </div>
          {onNewSessionForCurrentCompany && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 shrink-0 border-amber-500/30 bg-background text-[11px] hover:bg-amber-500/20"
              onClick={onNewSessionForCurrentCompany}
            >
              New chat in {activeCompany.name}
            </Button>
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
      />
      <ClippyComposer
        // Remount on a chat switch: the composer's draft text and pending
        // attachment uploads are local state that otherwise survives across
        // sessionId changes (this component doesn't unmount between chats),
        // so an unsent draft or in-flight upload for one chat could get sent
        // to a different one after switching (F11's "independent chat scope
        // and drafts").
        key={sessionId}
        sessionId={sessionId}
        permissionMode={session?.permissionMode ?? "ask"}
        awaitingPermission={pendingPermissions.length === 1}
        effort={session?.effort ?? "auto"}
        // The session's own model. Until the session loads there is none to
        // show, and naming a guessed model here would put a stale id on screen.
        model={session?.model ?? ""}
        streaming={streaming}
        onSend={send}
        onStopAndSend={abortAndSend}
        onAbort={abort}
        onPatch={(patch) => {
          void patchSession(patch);
        }}
      />
    </div>
  );
}
