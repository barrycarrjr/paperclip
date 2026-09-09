import { PanelLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
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
}

export function ClippyConversation({ sessionId, onOpenSessionList }: Props) {
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
      <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-sm font-medium">
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
      <ClippyMessageList
        transcript={transcript}
        pendingPermissions={pendingPermissions}
        onPermissionDecision={decidePermission}
        streaming={streaming}
        liveToolCalls={liveToolCalls}
        lastEventAt={lastEventAt}
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
        effort={session?.effort ?? "auto"}
        model={session?.model ?? "claude-opus-4-7"}
        streaming={streaming}
        onSend={(text, attachmentIds) => {
          void send(text, attachmentIds);
        }}
        onStopAndSend={(text, attachmentIds) => {
          void abortAndSend(text, attachmentIds);
        }}
        onAbort={abort}
        onPatch={(patch) => {
          void patchSession(patch);
        }}
      />
    </div>
  );
}
