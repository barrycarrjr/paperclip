import { useMemo, useState } from "react";
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
import { CompanyPatternIcon } from "./CompanyPatternIcon";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";

const KEEP_ALWAYS_LABEL = "keep-always";
const AUTO_NOISE_LABEL = "auto-noise";

interface HelpScoutMailboxPanelProps {
  mailbox: HelpScoutMailboxRef;
  primaryCompany: Company | null;
  onOpenMailbox: () => void;
  onOpenConversation: (conversationId: string, action?: "reply" | "handoff") => void;
}

export function HelpScoutMailboxPanel({
  mailbox,
  primaryCompany,
  onOpenMailbox,
  onOpenConversation,
}: HelpScoutMailboxPanelProps) {
  const queryClient = useQueryClient();
  const { pluginId, primaryCompanyId, accountKey, mailboxId, name, email } = mailbox;

  const api = useMemo(
    () => makeHelpScoutBridgeApi(pluginId, primaryCompanyId),
    [pluginId, primaryCompanyId],
  );

  const [optimisticallyRemoved, setOptimisticallyRemoved] = useState<Set<string>>(
    new Set(),
  );

  const listKey = ["helpscout", pluginId, primaryCompanyId, accountKey, mailboxId, "open"];

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
        status: "open",
        limit: 50,
      }),
    refetchInterval: 30_000,
  });

  function invalidateList() {
    queryClient.invalidateQueries({ queryKey: listKey });
  }

  function optimisticallyRemove(id: string) {
    setOptimisticallyRemoved((prev) => new Set([...prev, id]));
  }
  function unremove(id: string) {
    setOptimisticallyRemoved((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  const keepActiveMutation = useMutation({
    mutationFn: (conv: HSConversationSummary) =>
      api.addLabel(accountKey, conv.id, [KEEP_ALWAYS_LABEL]),
    onSuccess: () => invalidateList(),
  });

  const autoNoiseMutation = useMutation({
    mutationFn: async (conv: HSConversationSummary) => {
      optimisticallyRemove(conv.id);
      await api.addLabel(accountKey, conv.id, [AUTO_NOISE_LABEL]);
      await api.changeStatus(accountKey, conv.id, "closed");
    },
    onError: (_err, conv) => {
      unremove(conv.id);
      invalidateList();
    },
  });

  const spamMutation = useMutation({
    mutationFn: async (conv: HSConversationSummary) => {
      optimisticallyRemove(conv.id);
      await api.changeStatus(accountKey, conv.id, "spam");
    },
    onError: (_err, conv) => {
      unremove(conv.id);
      invalidateList();
    },
  });

  const all = data?.conversations ?? [];
  const conversations = all.filter((c) => !optimisticallyRemoved.has(c.id));
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

      <ConversationListBody
        conversations={conversations}
        isLoading={isLoading}
        error={error as Error | null}
        onOpen={onOpenConversation}
        keepActive={(c) => keepActiveMutation.mutate(c)}
        keepActivePendingId={
          keepActiveMutation.isPending ? keepActiveMutation.variables?.id ?? null : null
        }
        autoNoise={(c) => autoNoiseMutation.mutate(c)}
        autoNoisePendingId={
          autoNoiseMutation.isPending ? autoNoiseMutation.variables?.id ?? null : null
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
  isLoading: boolean;
  error: Error | null;
  onOpen: (conversationId: string, action?: "reply" | "handoff") => void;
  keepActive: (c: HSConversationSummary) => void;
  keepActivePendingId: string | null;
  autoNoise: (c: HSConversationSummary) => void;
  autoNoisePendingId: string | null;
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
  onOpen,
  keepActive,
  keepActivePendingId,
  autoNoise,
  autoNoisePendingId,
  markSpam,
  markSpamPendingId,
}: { conv: HSConversationSummary } & ConversationListBodyProps) {
  const isKeepPending = keepActivePendingId === conv.id;
  const isAutoNoisePending = autoNoisePendingId === conv.id;
  const isSpamPending = markSpamPendingId === conv.id;
  const customerLabel = conv.customer?.name || conv.customer?.email || "(unknown customer)";
  const hasKeep = conv.tags.includes(KEEP_ALWAYS_LABEL);
  const hasAutoNoise = conv.tags.includes(AUTO_NOISE_LABEL);

  return (
    <div
      className="group flex items-center gap-2 px-4 py-2.5 hover:bg-accent/40 transition-colors cursor-pointer"
      onClick={() => onOpen(conv.id)}
    >
      <span
        className={cn(
          "shrink-0 h-1.5 w-1.5 rounded-full",
          conv.status === "active"
            ? "bg-blue-500"
            : conv.status === "pending"
              ? "border border-blue-500"
              : "bg-transparent",
        )}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className={cn("text-xs truncate", conv.status === "active" && "font-semibold")}>
            {customerLabel}
          </span>
          <span className="text-[10px] text-muted-foreground shrink-0">
            {conv.modifiedAt ? timeAgo(new Date(conv.modifiedAt)) : ""}
          </span>
        </div>
        <div className="text-xs text-muted-foreground truncate mt-0.5">
          {conv.subject ?? "(no subject)"}
        </div>
      </div>
      <div
        className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={(e) => e.stopPropagation()}
      >
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
          title="Close as spam"
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
