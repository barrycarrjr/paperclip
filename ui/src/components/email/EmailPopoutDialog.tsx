import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  Forward,
  Loader2,
  Mail,
  MailOpen,
  MoveRight,
  Printer,
  Reply,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { makeEmailToolsApi, type MailHeader } from "../../api/emailTools";
import { AttachmentChipList } from "../attachments/AttachmentChipList";
import { visibleEmailAttachments } from "../../lib/attachments";
import { agentsApi } from "../../api/agents";
import { useEmailMessageActions, type EmailMessageActionHooks } from "./useEmailMessageActions";
import { usePrintEmail } from "./usePrintEmail";
import { resolveActionHeader } from "./emailActionHeader";
import { inlineFailureText } from "./actionFailure";
import { cn } from "@/lib/utils";

export interface EmailPopoutRequest {
  pluginId: string;
  companyId: string;
  /** Shown in the header so it is clear which company's mailbox this is. */
  companyName?: string;
  mailbox: string;
  mailboxName?: string;
  folder: string;
  uid: number;
  /** List row for the same message, when the opener has one. */
  header?: MailHeader;
}

interface EmailPopoutDialogProps {
  request: EmailPopoutRequest | null;
  onClose: () => void;
  /** Bookkeeping the opening surface needs, e.g. hiding a row it just deleted. */
  actionHooks?: EmailMessageActionHooks;
}

type Composer = { kind: "reply"; replyAll: boolean } | { kind: "forward" } | null;

/**
 * Inline failure notice for a composer, styled as an error rather than a hint.
 *
 * The dialog used to have no error surface of its own and relied entirely on
 * the page that opened it wiring `onToast`. The portfolio list does not, so a
 * forward that the server rejected left the composer sitting there unchanged,
 * which is indistinguishable from the button not working.
 */
function ComposerError({ error }: { error: unknown }) {
  return (
    <p role="alert" className="text-xs font-medium text-destructive">
      {inlineFailureText(error)}
    </p>
  );
}

/**
 * An email opened at full size, on top of wherever the operator already was.
 *
 * Every surface that lists mail could previously only preview it. Opening one
 * properly meant a click that switched company and landed on the Email page,
 * where the message still shared the width with a mailbox column and a message
 * column, and where several actions lived that no other surface offered. This
 * shows the message large and carries the whole toolbar, so "open this email"
 * means the same thing from the portfolio list, from search, or from the Email
 * page itself, and does not move the operator off the page they were working on.
 */
export function EmailPopoutDialog({ request, onClose, actionHooks }: EmailPopoutDialogProps) {
  const [composer, setComposer] = useState<Composer>(null);
  const [body, setBody] = useState("");
  const [forwardTo, setForwardTo] = useState("");
  const [handOffOpen, setHandOffOpen] = useState(false);
  const [handOffAgentId, setHandOffAgentId] = useState<string | null>(null);
  const [handOffNote, setHandOffNote] = useState("");
  // Outcome of the last print click. Printing keeps the dialog open (unlike
  // delete or move), and not every opener wires a toast, so the dialog shows
  // its own confirmation inline.
  const [printNote, setPrintNote] = useState<string | null>(null);
  // Read state as this dialog knows it, once something in here has changed it.
  // The opening list row is the starting point, but `request` is a snapshot
  // taken when the dialog opened and never updates, so the read/unread toggle
  // and a reply (which marks read) have to record the new state themselves.
  const [readStateChange, setReadStateChange] = useState<boolean | null>(null);

  // A different message means a different draft; carrying the old text over
  // would risk sending it to the wrong person.
  useEffect(() => {
    setComposer(null);
    setBody("");
    setForwardTo("");
    setHandOffOpen(false);
    setHandOffAgentId(null);
    setHandOffNote("");
    setPrintNote(null);
    setReadStateChange(null);
  }, [request?.uid, request?.mailbox, request?.companyId]);

  useEffect(() => {
    if (!printNote) return;
    const timer = setTimeout(() => setPrintNote(null), 4000);
    return () => clearTimeout(timer);
  }, [printNote]);

  const api = useMemo(
    () => (request ? makeEmailToolsApi(request.pluginId, request.companyId) : null),
    [request?.pluginId, request?.companyId],
  );

  const { data: message, isLoading } = useQuery({
    queryKey: [
      "email-popout",
      request?.pluginId,
      request?.companyId,
      request?.mailbox,
      request?.folder,
      request?.uid,
    ],
    queryFn: () => api!.fetchMessage(request!.mailbox, request!.uid, request!.folder),
    enabled: Boolean(api && request),
  });

  const { data: folders } = useQuery({
    queryKey: ["email-popout-folders", request?.pluginId, request?.companyId, request?.mailbox],
    queryFn: () => api!.listFolders(request!.mailbox),
    enabled: Boolean(api && request),
    staleTime: 60_000,
  });

  const { data: agents } = useQuery({
    queryKey: ["email-popout-agents", request?.companyId],
    queryFn: () => agentsApi.list(request!.companyId),
    enabled: Boolean(request && handOffOpen),
  });

  const actions = useEmailMessageActions(
    request
      ? {
          pluginId: request.pluginId,
          companyId: request.companyId,
          mailbox: request.mailbox,
          folder: request.folder,
        }
      : null,
    actionHooks,
  );

  const printer = usePrintEmail(request?.companyId ?? null, {
    onDone: (text) => setPrintNote(text),
  });

  // Actions that dispose of the message close the pop-out; there is nothing
  // left to look at, and leaving it open invites acting on it twice.
  function runAndClose(run: () => void) {
    run();
    onClose();
  }

  // Opening or closing a composer starts a fresh attempt, so the notice from
  // the last failed one must not be sitting above the new draft.
  function clearComposerErrors() {
    actions.reply.reset();
    actions.forward.reset();
    actions.handOff.reset();
  }

  const isUnread = readStateChange ?? request?.header?.unseen ?? false;

  /**
   * One button for both directions, showing the action available rather than
   * the state the message is in: an unread message offers "mark as read", and
   * once that is done the same button turns into "mark as unread". Neither
   * closes the dialog — the operator is still reading the message, and the
   * point of the toggle is being able to see it flip.
   */
  function toggleRead(msg: MailHeader) {
    const wasUnread = isUnread;
    setReadStateChange(!wasUnread);
    const mutation = wasUnread ? actions.markRead : actions.markUnread;
    mutation.mutate(msg, { onError: () => setReadStateChange(wasUnread) });
  }

  const readTogglePending = isUnread
    ? actions.markRead.isPending
    : actions.markUnread.isPending;

  // The list row the mutations want. When the opener did not supply one, it is
  // rebuilt from the fetched message.
  const headerForActions = resolveActionHeader({
    uid: request?.uid ?? null,
    listRows: request?.header ? [request.header] : [],
    openMessage: message,
    assumeUnseen: isUnread,
  });

  const open = Boolean(request);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        className="flex h-[92dvh] w-[96vw] max-w-[1400px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1400px]"
        showCloseButton={false}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-3">
          <div className="min-w-0 space-y-0.5">
            <DialogTitle className="truncate text-base font-semibold">
              {message?.subject || (isLoading ? "Loading..." : "(no subject)")}
            </DialogTitle>
            {message && (
              <>
                <div className="truncate text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{message.from}</span>
                  {message.to.length > 0 && <span> to {message.to.join(", ")}</span>}
                </div>
                <div className="text-xs text-muted-foreground">
                  {new Date(message.date).toLocaleString()}
                  {request?.mailboxName ? ` · ${request.mailboxName}` : ""}
                  {request?.companyName ? ` · ${request.companyName}` : ""}
                </div>
              </>
            )}
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>

        {message && headerForActions && (
          <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-5 py-2">
            <ToolbarButton
              label={isUnread ? "Mark as read" : "Mark as unread"}
              icon={
                readTogglePending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : isUnread ? (
                  <MailOpen className="h-3.5 w-3.5" />
                ) : (
                  <Mail className="h-3.5 w-3.5" />
                )
              }
              disabled={readTogglePending}
              onClick={() => toggleRead(headerForActions)}
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="outline" aria-label="Move to folder">
                  <MoveRight className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
                {(folders?.folders ?? []).map((f) => (
                  <DropdownMenuItem
                    key={f}
                    onClick={() =>
                      runAndClose(() =>
                        actions.moveToFolder.mutate({ msg: headerForActions, targetFolder: f }))}
                  >
                    {f}
                  </DropdownMenuItem>
                ))}
                {!folders?.folders?.length && (
                  <DropdownMenuItem disabled>No other folders</DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <ToolbarButton
              label="Hand off to agent"
              icon={<Bot className="h-3.5 w-3.5" />}
              active={handOffOpen}
              onClick={() => {
                clearComposerErrors();
                setHandOffOpen((v) => !v);
                setComposer(null);
              }}
            />
            <ToolbarButton
              label="Forward"
              icon={<Forward className="h-3.5 w-3.5" />}
              active={composer?.kind === "forward"}
              onClick={() => {
                clearComposerErrors();
                setHandOffOpen(false);
                setComposer((c) => (c?.kind === "forward" ? null : { kind: "forward" }));
                setBody("");
              }}
            />
            <ToolbarButton
              label="Reply"
              icon={<Reply className="h-3.5 w-3.5" />}
              active={composer?.kind === "reply"}
              onClick={() => {
                clearComposerErrors();
                setHandOffOpen(false);
                setComposer((c) => (c?.kind === "reply" ? null : { kind: "reply", replyAll: false }));
                setBody("");
              }}
            />
            <ToolbarButton
              label={printer.tooltip}
              icon={
                printer.print.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Printer className="h-3.5 w-3.5" />
                )
              }
              disabled={!printer.canPrint || printer.print.isPending}
              onClick={() => printer.print.mutate(message)}
            />
            {printNote && (
              <span role="status" className="px-1 text-xs text-muted-foreground">
                {printNote}
              </span>
            )}
            <div className="ml-auto">
              <ToolbarButton
                label="Delete (move to Trash)"
                icon={<Trash2 className="h-3.5 w-3.5" />}
                onClick={() => runAndClose(() => actions.remove.mutate(headerForActions))}
              />
            </div>
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col">
          {isLoading ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : !message ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              Message not found.
            </div>
          ) : message.html ? (
            <iframe
              key={message.uid}
              srcDoc={message.html}
              sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
              // Mail HTML is authored against a white background, so the app's
              // dark theme must not leak in and turn unstyled text invisible.
              style={{ colorScheme: "light" }}
              className="w-full flex-1 border-0 bg-white"
              title="Email body"
            />
          ) : (
            <ScrollArea className="flex-1 px-5 py-4">
              <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                {message.text || <span className="italic text-muted-foreground">(no body)</span>}
              </div>
            </ScrollArea>
          )}

          {message && visibleEmailAttachments(message.attachments).length > 0 && (
            <div className="shrink-0 space-y-1 border-t border-border px-5 py-2">
              <div className="text-xs font-medium text-muted-foreground">Attachments</div>
              <AttachmentChipList
                attachments={visibleEmailAttachments(message.attachments).map((a) => ({
                  key: a.partId,
                  name: a.name,
                  mime: a.mime,
                  size: a.size,
                }))}
                fetchContent={async (att) => {
                  const fetched = await api!.getAttachment(
                    request!.mailbox,
                    request!.folder,
                    request!.uid,
                    att.key,
                  );
                  return {
                    name: fetched.name,
                    mime: fetched.mime,
                    contentBase64: fetched.contentBase64,
                  };
                }}
              />
            </div>
          )}
        </div>

        {message && headerForActions && composer?.kind === "reply" && (
          <div className="shrink-0 space-y-2 border-t border-border bg-background p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                Reply to {message.from}
              </span>
              <label className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={composer.replyAll}
                  onChange={(e) => setComposer({ kind: "reply", replyAll: e.target.checked })}
                  className="h-3 w-3"
                />
                Reply all
              </label>
            </div>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              placeholder="Write a reply..."
              autoFocus
            />
            {actions.reply.isError && <ComposerError error={actions.reply.error} />}
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={!body.trim() || actions.reply.isPending}
                onClick={() =>
                  actions.reply.mutate(
                    { msg: headerForActions, body, replyAll: composer.replyAll },
                    {
                      onSuccess: () => {
                        setComposer(null);
                        setBody("");
                        // Replying marks the message read, so the toolbar has
                        // to stop offering to do it again.
                        setReadStateChange(false);
                      },
                    },
                  )}
              >
                {actions.reply.isPending ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="mr-1.5 h-3.5 w-3.5" />
                )}
                Send reply
              </Button>
            </div>
          </div>
        )}

        {message && composer?.kind === "forward" && (
          <div className="shrink-0 space-y-2 border-t border-border bg-background p-4">
            <span className="text-xs font-medium text-muted-foreground">Forward this email</span>
            <Input
              value={forwardTo}
              onChange={(e) => setForwardTo(e.target.value)}
              placeholder="to@example.com"
              autoFocus
            />
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              placeholder="Add a note (optional)"
            />
            {actions.forward.isError && <ComposerError error={actions.forward.error} />}
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={!forwardTo.trim() || actions.forward.isPending}
                onClick={() =>
                  actions.forward.mutate(
                    { msg: message, to: forwardTo.trim(), note: body },
                    { onSuccess: () => { setComposer(null); setBody(""); setForwardTo(""); } },
                  )}
              >
                {actions.forward.isPending ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Forward className="mr-1.5 h-3.5 w-3.5" />
                )}
                Send forward
              </Button>
            </div>
          </div>
        )}

        {message && handOffOpen && (
          <div className="shrink-0 space-y-2 border-t border-border bg-background p-4">
            <span className="text-xs font-medium text-muted-foreground">Hand off to an agent</span>
            <div className="max-h-40 overflow-y-auto rounded-md border border-border">
              {(agents ?? []).map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent/50",
                    handOffAgentId === agent.id && "bg-accent font-medium",
                  )}
                  onClick={() => setHandOffAgentId(agent.id)}
                >
                  {agent.name}
                </button>
              ))}
              {!agents?.length && (
                <div className="px-3 py-2 text-sm text-muted-foreground">No agents in this company.</div>
              )}
            </div>
            <Textarea
              value={handOffNote}
              onChange={(e) => setHandOffNote(e.target.value)}
              rows={3}
              placeholder="Note for the agent (optional)"
            />
            {actions.handOff.isError && <ComposerError error={actions.handOff.error} />}
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={!handOffAgentId || actions.handOff.isPending}
                onClick={() =>
                  actions.handOff.mutate(
                    {
                      msg: message,
                      agentId: handOffAgentId!,
                      note: handOffNote,
                      header: request?.header,
                    },
                    { onSuccess: onClose },
                  )}
              >
                {actions.handOff.isPending ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Bot className="mr-1.5 h-3.5 w-3.5" />
                )}
                Hand off
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ToolbarButton({
  label,
  icon,
  onClick,
  active,
  disabled,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A disabled button swallows pointer events, and the tooltip is where
            a greyed-out control explains how to become usable, so the trigger
            hangs off a wrapper that still hears the hover. */}
        <span className={cn("inline-flex", disabled && "cursor-not-allowed")}>
          <Button
            size="icon-sm"
            variant="outline"
            aria-label={label}
            onClick={onClick}
            disabled={disabled}
            className={cn(active && "bg-accent")}
          >
            {icon}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
