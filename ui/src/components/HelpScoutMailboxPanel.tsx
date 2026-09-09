import { useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Mail,
  Check,
  Archive,
  Trash2,
  AlertCircle,
  ExternalLink,
  Loader2,
  Tag,
  Reply,
  Bot,
  X,
  Clock,
} from "lucide-react";
import type { Company } from "@paperclipai/shared";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  makeHelpScoutBridgeApi,
  type HSConversationSummary,
} from "../api/helpScoutBridge";
import type { HelpScoutMailboxRef } from "../lib/mailboxKind";
import { mailboxRefId } from "../lib/mailboxKind";
import {
  applyHelpScoutOverrides,
  helpScoutMailboxScope,
  helpScoutOverrideStore,
  isHelpScoutListKey,
} from "../lib/mailboxTriageOverrides";
import { useHelpScoutTriageOverrides } from "../hooks/useTriageOverrides";
import { CompanyPatternIcon } from "./CompanyPatternIcon";
import { timeAgo } from "../lib/timeAgo";
import { Checkbox } from "@/components/ui/checkbox";
import { BulkTriageBar } from "./BulkTriageBar";
import { AUTO_NOISE_LABEL, KEEP_ALWAYS_LABEL, useBulkTriage } from "../hooks/useBulkTriage";
import { cn, ellipsize } from "../lib/utils";
import { useToastActions } from "@/context/ToastContext";

const MAX_SENDER_CHARS = 50;
const MAX_SUBJECT_CHARS = 80;


interface HelpScoutMailboxPanelProps {
  mailbox: HelpScoutMailboxRef;
  primaryCompany: Company | null;
  showAll: boolean;
  onOpenMailbox: () => void;
  onOpenConversation: (conversationId: string, action?: "reply" | "handoff") => void;
}

export function HelpScoutMailboxPanel({
  mailbox,
  primaryCompany,
  showAll,
  onOpenMailbox,
  onOpenConversation,
}: HelpScoutMailboxPanelProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const { pluginId, primaryCompanyId, accountKey, mailboxId, name, email } = mailbox;

  const api = useMemo(
    () => makeHelpScoutBridgeApi(pluginId, primaryCompanyId),
    [pluginId, primaryCompanyId],
  );

  // Triage notes are shared with HelpScoutEmailView on the per-company Email
  // page, so a conversation closed there is already gone when the operator
  // lands back here. They also outlive a refetch, which Help Scout needs: its
  // API keeps reporting the old status for a few seconds after a change.
  // See lib/mailboxTriageOverrides.ts.
  const overrideScope = helpScoutMailboxScope(pluginId, primaryCompanyId, accountKey, mailboxId);
  const overrides = useHelpScoutTriageOverrides(overrideScope);

  // "active" = HS analog of unread (needs action). "open" = active + pending.
  // The page-level showAll toggle gates pending conversations the same way it
  // gates IMAP read messages.
  const listStatus = showAll ? "open" : "active";
  const listKey = ["helpscout", pluginId, primaryCompanyId, accountKey, mailboxId, listStatus];

  const {
    data,
    isLoading,
    error,
  } = useQuery({
    queryKey: listKey,
    queryFn: () =>
      api.listConversations({
        accountKey,
        mailboxId,
        status: listStatus,
        limit: 50,
      }),
    refetchInterval: 30_000,
  });

  // Every cached status variant for this mailbox, not just the one on screen,
  // so the Email page's tab is refreshed too.
  function invalidateLists() {
    queryClient.invalidateQueries({
      predicate: (q) =>
        isHelpScoutListKey(q.queryKey, {
          pluginId,
          companyId: primaryCompanyId,
          accountKey,
          mailboxId,
        }),
    });
  }

  function noteStatus(id: string, status: string) {
    helpScoutOverrideStore.set(overrideScope, id, status);
  }
  function clearStatus(id: string) {
    helpScoutOverrideStore.clear(overrideScope, id);
  }

  // P2 audit, 2026-09-03: none of these five reported a failure at all —
  // the operator saw a click that appeared to do nothing. HelpScoutEmailView's
  // equivalent buttons already toast on error; this panel hadn't.
  const keepActiveMutation = useMutation({
    mutationFn: (conv: HSConversationSummary) =>
      api.addLabel(accountKey, conv.id, [KEEP_ALWAYS_LABEL]),
    onSuccess: () => invalidateLists(),
    onError: (err) =>
      pushToast({ title: "Keep active failed", body: (err as Error).message, tone: "error" }),
  });

  const autoNoiseMutation = useMutation({
    mutationFn: async (conv: HSConversationSummary) => {
      noteStatus(conv.id, "closed");
      await api.addLabel(accountKey, conv.id, [AUTO_NOISE_LABEL]);
      await api.changeStatus(accountKey, conv.id, "closed");
    },
    onSuccess: () => invalidateLists(),
    onError: (err, conv) => {
      clearStatus(conv.id);
      invalidateLists();
      pushToast({ title: "Auto-noise failed", body: (err as Error).message, tone: "error" });
    },
  });

  // Pending = HS analog of "I see it, dealing with it later". The note records
  // the new status rather than "hide this row", so each list works out its own
  // answer: it drops off an active-only panel and stays on a showAll one with
  // the dot recoloured.
  const pendingMutation = useMutation({
    mutationFn: async (conv: HSConversationSummary) => {
      noteStatus(conv.id, "pending");
      await api.changeStatus(accountKey, conv.id, "pending");
    },
    onSuccess: () => invalidateLists(),
    onError: (err, conv) => {
      clearStatus(conv.id);
      invalidateLists();
      pushToast({ title: "Mark pending failed", body: (err as Error).message, tone: "error" });
    },
  });

  const closeMutation = useMutation({
    mutationFn: async (conv: HSConversationSummary) => {
      noteStatus(conv.id, "closed");
      await api.changeStatus(accountKey, conv.id, "closed");
    },
    onSuccess: () => invalidateLists(),
    onError: (err, conv) => {
      clearStatus(conv.id);
      invalidateLists();
      pushToast({ title: "Close failed", body: (err as Error).message, tone: "error" });
    },
  });

  const spamMutation = useMutation({
    mutationFn: async (conv: HSConversationSummary) => {
      noteStatus(conv.id, "spam");
      await api.changeStatus(accountKey, conv.id, "spam");
    },
    onSuccess: () => invalidateLists(),
    onError: (err, conv) => {
      clearStatus(conv.id);
      invalidateLists();
      pushToast({ title: "Mark spam failed", body: (err as Error).message, tone: "error" });
    },
  });

  const all = data?.conversations ?? [];
  const conversations = applyHelpScoutOverrides(all, overrides, { filter: listStatus });

  const bulk = useBulkTriage({ api, accountKey, noteStatus, clearStatus, invalidateLists });
  const visibleIds = useMemo(() => conversations.map((c) => c.id), [conversations]);
  // Rows leave on a refetch or when someone else triages them; a selection
  // pointing at a conversation that is gone would fire into thin air.
  const selectAllState = bulk.selectAllState(visibleIds);
  const { syncVisible } = bulk;
  useEffect(() => {
    syncVisible(visibleIds);
  }, [syncVisible, visibleIds]);
  const activeCount = conversations.filter((c) => c.status === "active").length;
  const pendingCount = conversations.filter((c) => c.status === "pending").length;

  return (
    <div className="rounded-lg border border-border bg-card shadow-sm overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-muted/40">
        {primaryCompany ? (
          <CompanyPatternIcon
            companyName={primaryCompany.name}
            logoUrl={primaryCompany.logoUrl}
            brandColor={primaryCompany.brandColor}
            className="h-6 w-6 shrink-0 rounded-[3px]"
          />
        ) : (
          <Mail className="h-6 w-6 shrink-0 text-muted-foreground" />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            HS · {accountKey}
            {primaryCompany ? (
              <span className="ml-2 normal-case font-normal text-muted-foreground/70">
                · {primaryCompany.name}
              </span>
            ) : null}
          </div>
          <div className="text-sm font-semibold truncate">{name}</div>
          {email !== name && (
            <div className="text-xs text-muted-foreground truncate">{email}</div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          {visibleIds.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="mr-1 flex items-center">
                  <Checkbox
                    checked={
                      selectAllState === "all"
                        ? true
                        : selectAllState === "some"
                          ? "indeterminate"
                          : false
                    }
                    disabled={bulk.running}
                    aria-label={selectAllState === "all" ? "Clear selection" : "Select all shown"}
                    onCheckedChange={() => bulk.onSelectAll(visibleIds)}
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {selectAllState === "all" ? "Clear selection" : "Select all shown"}
              </TooltipContent>
            </Tooltip>
          )}
          <span className="text-xs text-muted-foreground">
            {activeCount} active{pendingCount > 0 ? ` · ${pendingCount} pending` : ""}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onOpenMailbox}
                aria-label="Open in company view"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Open this mailbox in {primaryCompany?.name ?? "company"} view
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <BulkTriageBar
        count={bulk.selectedCount}
        progress={bulk.progress}
        outcome={bulk.outcome}
        onAction={(action) => {
          void bulk.runAction(
            action,
            visibleIds.filter((id) => bulk.isSelected(id)),
          );
        }}
        onCancel={bulk.cancel}
        onClear={bulk.onClear}
        className="border-x-0 border-t-0"
      />

      <ConversationListBody
        conversations={conversations}
        selectedIds={bulk.selection.selected}
        onToggleSelect={(id, shiftKey) => bulk.onToggle(id, visibleIds, shiftKey)}
        bulkRunning={bulk.running}
        isLoading={isLoading}
        error={error as Error | null}
        onOpen={onOpenConversation}
        onReply={(c) => onOpenConversation(c.id, "reply")}
        onHandoff={(c) => onOpenConversation(c.id, "handoff")}
        markPending={(c) => pendingMutation.mutate(c)}
        markPendingPendingId={
          pendingMutation.isPending ? pendingMutation.variables?.id ?? null : null
        }
        keepActive={(c) => keepActiveMutation.mutate(c)}
        keepActivePendingId={
          keepActiveMutation.isPending ? keepActiveMutation.variables?.id ?? null : null
        }
        autoNoise={(c) => autoNoiseMutation.mutate(c)}
        autoNoisePendingId={
          autoNoiseMutation.isPending ? autoNoiseMutation.variables?.id ?? null : null
        }
        close={(c) => closeMutation.mutate(c)}
        closePendingId={
          closeMutation.isPending ? closeMutation.variables?.id ?? null : null
        }
        markSpam={(c) => spamMutation.mutate(c)}
        markSpamPendingId={
          spamMutation.isPending ? spamMutation.variables?.id ?? null : null
        }
      />
    </div>
  );
}

interface ConversationListBodyProps {
  conversations: HSConversationSummary[];
  selectedIds: ReadonlySet<string>;
  onToggleSelect: (conversationId: string, shiftKey: boolean) => void;
  bulkRunning: boolean;
  isLoading: boolean;
  error: Error | null;
  onOpen: (conversationId: string, action?: "reply" | "handoff") => void;
  onReply: (c: HSConversationSummary) => void;
  onHandoff: (c: HSConversationSummary) => void;
  markPending: (c: HSConversationSummary) => void;
  markPendingPendingId: string | null;
  keepActive: (c: HSConversationSummary) => void;
  keepActivePendingId: string | null;
  autoNoise: (c: HSConversationSummary) => void;
  autoNoisePendingId: string | null;
  close: (c: HSConversationSummary) => void;
  closePendingId: string | null;
  markSpam: (c: HSConversationSummary) => void;
  markSpamPendingId: string | null;
}

function ConversationListBody(props: ConversationListBodyProps) {
  const { conversations, isLoading, error } = props;

  if (error) {
    return (
      <div className="flex items-center justify-center py-6 px-4">
        <div className="text-center space-y-1">
          <AlertCircle className="h-4 w-4 text-destructive mx-auto" />
          <p className="text-xs text-muted-foreground">{error.message}</p>
        </div>
      </div>
    );
  }
  if (isLoading && conversations.length === 0) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (conversations.length === 0) {
    return (
      <div className="py-6 px-4 text-center text-xs text-muted-foreground">
        No open conversations.
      </div>
    );
  }

  return (
    <div className="divide-y divide-border">
      {conversations.map((c) => (
        <ConversationRow key={c.id} conv={c} {...props} />
      ))}
    </div>
  );
}

function ConversationRow({
  conv,
  selectedIds,
  onToggleSelect,
  bulkRunning,
  onOpen,
  onReply,
  onHandoff,
  markPending,
  markPendingPendingId,
  keepActive,
  keepActivePendingId,
  autoNoise,
  autoNoisePendingId,
  close,
  closePendingId,
  markSpam,
  markSpamPendingId,
}: { conv: HSConversationSummary } & ConversationListBodyProps) {
  const isPendingPending = markPendingPendingId === conv.id;
  const isKeepPending = keepActivePendingId === conv.id;
  const isAutoNoisePending = autoNoisePendingId === conv.id;
  const isClosePending = closePendingId === conv.id;
  const isSpamPending = markSpamPendingId === conv.id;
  const customerLabel = conv.customer?.name || conv.customer?.email || "(unknown customer)";
  const hasKeep = conv.tags.includes(KEEP_ALWAYS_LABEL);
  const hasAutoNoise = conv.tags.includes(AUTO_NOISE_LABEL);

  const selected = selectedIds.has(conv.id);

  return (
    <div
      className={cn(
        "group flex items-center gap-2 px-2 py-2.5 min-w-0 overflow-hidden transition-colors cursor-pointer",
        selected ? "bg-accent/60" : "hover:bg-accent/40",
      )}
      onClick={() => onOpen(conv.id)}
    >
      {/* The checkbox sits where the status dot was, and takes it over once
          anything is selected, so the row does not change width mid-triage.
          Its click must not also open the conversation. */}
      <span
        className="relative flex h-4 w-4 shrink-0 items-center justify-center"
        onClick={(event) => {
          event.stopPropagation();
          // The guard belongs here, not only on the Checkbox: the click target
          // is this whole span, and most of it is padding outside the 16px box
          // that `disabled` covers.
          if (bulkRunning) return;
          onToggleSelect(conv.id, event.shiftKey);
        }}
      >
        <span
          aria-hidden
          className={cn(
            "absolute h-1.5 w-1.5 rounded-full transition-opacity",
            selected ? "opacity-0" : "opacity-100 group-hover:opacity-0",
            conv.status === "active"
              ? "bg-blue-500"
              : conv.status === "pending"
                ? "border border-blue-500"
                : "bg-transparent",
          )}
        />
        <Checkbox
          checked={selected}
          disabled={bulkRunning}
          aria-label={`Select conversation from ${customerLabel}`}
          onCheckedChange={() => {}}
          className={cn(
            "transition-opacity",
            selected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        />
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex-1 min-w-0 overflow-hidden">
            <div className="flex items-baseline justify-between gap-2 min-w-0">
              <span
                className={cn(
                  "text-xs truncate min-w-0",
                  conv.status === "active" && "font-semibold",
                )}
              >
                {ellipsize(customerLabel, MAX_SENDER_CHARS)}
              </span>
              <span className="text-[10px] text-muted-foreground shrink-0">
                {conv.modifiedAt ? timeAgo(new Date(conv.modifiedAt)) : ""}
              </span>
            </div>
            <div className="text-xs text-muted-foreground truncate mt-0.5">
              {ellipsize(conv.subject ?? "(no subject)", MAX_SUBJECT_CHARS)}
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" className="max-w-md">
          <div className="text-xs font-semibold">{conv.subject ?? "(no subject)"}</div>
          {conv.preview && (
            <div className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap break-words">
              {conv.preview}
            </div>
          )}
        </TooltipContent>
      </Tooltip>
      <div
        className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity [&_button]:size-7 [&_svg]:size-3"
        onClick={(e) => e.stopPropagation()}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={isPendingPending}
              onClick={() => markPending(conv)}
              aria-label="Mark pending"
              className="text-muted-foreground hover:text-foreground"
            >
              {isPendingPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Clock className="h-3.5 w-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Mark pending (snooze)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onReply(conv)}
              aria-label="Reply"
              className="text-muted-foreground hover:text-foreground"
            >
              <Reply className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reply</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onHandoff(conv)}
              aria-label="Hand off to agent"
              className="text-muted-foreground hover:text-foreground"
            >
              <Bot className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Hand off to agent</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={isKeepPending}
              onClick={() => keepActive(conv)}
              aria-label="Keep active"
              className={cn(
                hasKeep ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {isKeepPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" strokeWidth={hasKeep ? 3.5 : 2} />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {hasKeep ? "Tagged keep-always" : "Tag keep-always"}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={isAutoNoisePending}
              onClick={() => autoNoise(conv)}
              aria-label="Auto-noise (tag + close)"
              className={cn(
                hasAutoNoise ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {isAutoNoisePending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Archive
                  className={cn("h-3.5 w-3.5", hasAutoNoise && "fill-current")}
                  strokeWidth={hasAutoNoise ? 2.5 : 2}
                />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {hasAutoNoise ? "Auto-noise tag set" : "Tag auto-noise and close"}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={isClosePending}
              onClick={() => close(conv)}
              aria-label="Close"
              className="text-muted-foreground hover:text-foreground"
            >
              {isClosePending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <X className="h-3.5 w-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Close</TooltipContent>
        </Tooltip>
        {conv.tags.length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-[10px] text-muted-foreground px-1 inline-flex items-center gap-1">
                <Tag className="h-3 w-3" />
                {conv.tags.length}
              </span>
            </TooltipTrigger>
            <TooltipContent>{conv.tags.join(", ")}</TooltipContent>
          </Tooltip>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={isSpamPending}
          onClick={() => markSpam(conv)}
          title="Spam"
          className="text-muted-foreground hover:text-destructive"
        >
          {isSpamPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
    </div>
  );
}

/** Stable URL param value for `?mailbox=` when navigating from Portfolio to /email. */
export function helpScoutMailboxQueryKey(m: HelpScoutMailboxRef): string {
  return mailboxRefId(m);
}
