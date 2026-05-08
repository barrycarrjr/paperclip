import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertOctagon,
  CheckCircle2,
  ClipboardCheck,
  Inbox as InboxIcon,
  Mail,
  Pencil,
  RefreshCcw,
  X,
} from "lucide-react";
import type { Approval, IssueDocument } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { approvalsApi } from "../api/approvals";
import { ApiError } from "../api/client";
import { issuesApi } from "../api/issues";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import {
  dismissReviewSender,
  graduateSender,
  keepAlwaysSender,
  parseReviewQueue,
} from "../lib/email-triage-rules";
import { isUnifiedInboxEnabled, setUnifiedInboxEnabled } from "../lib/unified-inbox-flag";

const RULES_HOME_TITLE_PREFIX = "Email triage rules - ";
const RULES_HOME_DOC_KEY = "email-triage-rules";

type ItemKind =
  | "approval"
  | "draft"
  | "email_review_sender"
  | "failed_run";

interface BaseItem {
  id: string;
  kind: ItemKind;
  createdAt: string;
  title: string;
  subtitle?: string;
  meta?: string;
  rankWeight: number;
}

interface ApprovalItem extends BaseItem {
  kind: "approval" | "draft";
  approvalId: string;
}

interface EmailReviewSenderItem extends BaseItem {
  kind: "email_review_sender";
  rulesIssueId: string;
  mailbox: string;
  sender: string;
  messageCount: number;
}

interface FailedRunItem extends BaseItem {
  kind: "failed_run";
  runId: string;
  agentId: string;
  retryPayload: Record<string, unknown>;
}

type InboxItem =
  | ApprovalItem
  | EmailReviewSenderItem
  | FailedRunItem;

interface RulesHomeBundle {
  issueId: string;
  mailbox: string;
  title: string;
  body: string;
  latestRevisionId: string | null;
}

const KIND_LABEL: Record<ItemKind, string> = {
  approval: "Approval pending",
  draft: "Draft awaiting tap",
  email_review_sender: "Email sender",
  failed_run: "Failed run",
};

const KIND_TONE: Record<ItemKind, "amber" | "sky" | "red"> = {
  approval: "amber",
  draft: "amber",
  email_review_sender: "sky",
  failed_run: "red",
};

const KIND_ICON: Record<ItemKind, typeof Mail> = {
  approval: ClipboardCheck,
  draft: Pencil,
  email_review_sender: Mail,
  failed_run: AlertOctagon,
};

export function UnifiedInbox() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    setBreadcrumbs([{ label: "Inbox" }, { label: "Unified (preview)" }]);
  }, [setBreadcrumbs]);

  const { data: approvals, isLoading: approvalsLoading } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!, "pending"),
    queryFn: () => approvalsApi.list(selectedCompanyId!, "pending"),
    enabled: !!selectedCompanyId,
  });

  const { data: rulesBundles } = useQuery<RulesHomeBundle[]>({
    queryKey: ["unifiedInbox", "emailTriageRules", selectedCompanyId],
    enabled: !!selectedCompanyId,
    queryFn: async () => {
      const matches = await issuesApi.list(selectedCompanyId!, {
        q: RULES_HOME_TITLE_PREFIX,
        limit: 50,
      });
      const rulesIssues = matches.filter((i) => i.title.startsWith(RULES_HOME_TITLE_PREFIX));
      const docs = await Promise.allSettled(
        rulesIssues.map(async (issue) => {
          const doc: IssueDocument = await issuesApi.getDocument(issue.id, RULES_HOME_DOC_KEY);
          return {
            issueId: issue.id,
            mailbox: issue.title.slice(RULES_HOME_TITLE_PREFIX.length).trim(),
            title: issue.title,
            body: doc?.body ?? "",
            latestRevisionId: doc?.latestRevisionId ?? null,
          } satisfies RulesHomeBundle;
        }),
      );
      return docs
        .filter((r): r is PromiseFulfilledResult<RulesHomeBundle> => r.status === "fulfilled")
        .map((r) => r.value);
    },
  });

  const { data: heartbeats } = useQuery({
    queryKey: queryKeys.heartbeats(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    queryFn: () => heartbeatsApi.list(selectedCompanyId!, undefined, 30),
  });

  const items: InboxItem[] = useMemo(() => {
    const out: InboxItem[] = [];

    for (const a of approvals ?? []) {
      const isDraft = a.type === "outbound_tool_draft";
      const summary =
        typeof a.payload?.summary === "string"
          ? (a.payload.summary as string)
          : typeof a.payload?.description === "string"
            ? (a.payload.description as string)
            : "";
      out.push({
        id: `approval:${a.id}`,
        kind: isDraft ? "draft" : "approval",
        createdAt: String(a.createdAt),
        title: approvalShortTitle(a, isDraft),
        subtitle: summary || undefined,
        meta: a.requestedByAgentId ? `from agent` : undefined,
        rankWeight: isDraft ? 70 : 90,
        approvalId: a.id,
      } satisfies ApprovalItem);
    }

    for (const bundle of rulesBundles ?? []) {
      const entries = parseReviewQueue(bundle.body);
      // Higher-count senders rank higher within the email-review band so
      // the noisiest are the first ones the operator triages.
      const maxCount = entries.reduce((max, e) => Math.max(max, e.count), 0) || 1;
      for (const entry of entries) {
        out.push({
          id: `email_review_sender:${bundle.issueId}::${entry.sender}`,
          kind: "email_review_sender",
          createdAt: new Date().toISOString(),
          title: entry.sender,
          subtitle: `${entry.count} message${entry.count === 1 ? "" : "s"} from this sender · ${bundle.mailbox} mailbox`,
          meta: `${bundle.mailbox} mailbox`,
          // Email senders sit in the 50-65 band so failed runs / approvals /
          // agent questions stay above. Within the band, scale by count.
          rankWeight: 50 + Math.round((entry.count / maxCount) * 15),
          rulesIssueId: bundle.issueId,
          mailbox: bundle.mailbox,
          sender: entry.sender,
          messageCount: entry.count,
        } satisfies EmailReviewSenderItem);
      }
    }

    for (const run of heartbeats ?? []) {
      if (run.status !== "failed" && run.status !== "timed_out") continue;
      const triggerLabel =
        typeof run.triggerDetail === "object" && run.triggerDetail
          ? ((run.triggerDetail as Record<string, unknown>).reason as string | undefined) ??
            ((run.triggerDetail as Record<string, unknown>).source as string | undefined) ??
            null
          : null;
      const ctx = (run.contextSnapshot ?? {}) as Record<string, unknown>;
      const retryPayload: Record<string, unknown> = {};
      for (const key of ["issueId", "taskId", "taskKey"] as const) {
        const value = ctx[key];
        if (typeof value === "string" && value.length > 0) retryPayload[key] = value;
      }
      out.push({
        id: `failed_run:${run.id}`,
        kind: "failed_run",
        createdAt: String(run.createdAt),
        title: triggerLabel
          ? `${triggerLabel} — run failed`
          : `Run ${run.id.slice(0, 8)} ${run.status === "timed_out" ? "timed out" : "failed"}`,
        subtitle: run.error ?? "Run ended without success.",
        meta: run.errorCode ?? run.status,
        rankWeight: 95,
        runId: run.id,
        agentId: run.agentId,
        retryPayload,
      } satisfies FailedRunItem);
      if (out.filter((x) => x.kind === "failed_run").length >= 5) break;
    }

    return out
      .filter((it) => !dismissed.has(it.id))
      .sort((a, b) => {
        if (b.rankWeight !== a.rankWeight) return b.rankWeight - a.rankWeight;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
  }, [approvals, rulesBundles, heartbeats, dismissed]);

  const approveMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.approve(id),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.approvals.list(selectedCompanyId!, "pending"),
      });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.reject(id),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.approvals.list(selectedCompanyId!, "pending"),
      });
    },
  });

  const reviewSenderMutationOptions = {
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["unifiedInbox", "emailTriageRules", selectedCompanyId],
      });
    },
  };

  async function applyReviewSenderTransform(
    item: EmailReviewSenderItem,
    transform: (body: string, sender: string) => string,
  ) {
    const bundle = rulesBundles?.find((b) => b.issueId === item.rulesIssueId);
    if (!bundle) throw new Error("Rules document no longer available.");

    const submit = async (body: string, baseRevisionId: string | null) => {
      await issuesApi.upsertDocument(item.rulesIssueId, RULES_HOME_DOC_KEY, {
        title: bundle.title,
        format: "markdown",
        body: transform(body, item.sender),
        baseRevisionId: baseRevisionId ?? undefined,
      });
    };

    try {
      await submit(bundle.body, bundle.latestRevisionId);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 409) throw err;
      const fresh: IssueDocument = await issuesApi.getDocument(
        item.rulesIssueId,
        RULES_HOME_DOC_KEY,
      );
      await submit(fresh.body ?? "", fresh.latestRevisionId ?? null);
    }
  }

  const graduateMutation = useMutation({
    mutationFn: (item: EmailReviewSenderItem) =>
      applyReviewSenderTransform(item, graduateSender),
    ...reviewSenderMutationOptions,
  });
  const keepMutation = useMutation({
    mutationFn: (item: EmailReviewSenderItem) =>
      applyReviewSenderTransform(item, keepAlwaysSender),
    ...reviewSenderMutationOptions,
  });
  const dismissReviewMutation = useMutation({
    mutationFn: (item: EmailReviewSenderItem) =>
      applyReviewSenderTransform(item, dismissReviewSender),
    ...reviewSenderMutationOptions,
  });

  const retryRunMutation = useMutation({
    mutationFn: async (item: FailedRunItem) => {
      const result = await agentsApi.wakeup(
        item.agentId,
        {
          source: "on_demand",
          triggerDetail: "manual",
          reason: "retry_failed_run",
          payload: item.retryPayload,
        },
        selectedCompanyId!,
      );
      if (!("id" in result)) {
        throw new Error(result.message ?? "Retry was skipped.");
      }
      return result;
    },
    onSuccess: (newRun) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.heartbeats(selectedCompanyId!),
      });
      navigate(`/agents/${newRun.agentId}/runs/${newRun.id}`);
    },
  });

  function dismiss(id: string) {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }

  function disablePreview() {
    setUnifiedInboxEnabled(false);
    navigate("/inbox/mine", { replace: true });
  }

  if (!selectedCompanyId) {
    return <EmptyState icon={InboxIcon} message="Select a company first." />;
  }

  if (approvalsLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  return (
    <div className="space-y-6">
      <PreviewBanner onDisable={disablePreview} />

      <header className="flex items-baseline justify-between border-b border-border pb-3">
        <div>
          <h1 className="text-xl font-semibold">Inbox</h1>
          <p className="text-[12px] text-muted-foreground">
            One queue: approvals, drafts, email review, and failed runs. Ranked by urgency.
          </p>
        </div>
        <span className="text-[12px] text-muted-foreground tabular-nums">
          {items.length} item{items.length === 1 ? "" : "s"}
        </span>
      </header>

      {items.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          message="Inbox zero. Nothing waiting on you right now."
        />
      ) : (
        <div className="border border-border bg-card divide-y divide-border">
          {items.map((item) => {
            const isReviewSender = item.kind === "email_review_sender";
            const isFailedRun = item.kind === "failed_run";
            return (
              <InboxItemRow
                key={item.id}
                item={item}
                onDismiss={() => dismiss(item.id)}
                onApprove={
                  item.kind === "approval" || item.kind === "draft"
                    ? () => approveMutation.mutate(item.approvalId)
                    : undefined
                }
                onReject={
                  item.kind === "approval" || item.kind === "draft"
                    ? () => rejectMutation.mutate(item.approvalId)
                    : undefined
                }
                onGraduate={
                  isReviewSender ? () => graduateMutation.mutate(item) : undefined
                }
                onKeep={
                  isReviewSender ? () => keepMutation.mutate(item) : undefined
                }
                onDismissRule={
                  isReviewSender ? () => dismissReviewMutation.mutate(item) : undefined
                }
                onRetry={
                  isFailedRun ? () => retryRunMutation.mutate(item) : undefined
                }
                onOpen={() => openItem(item, navigate)}
                isPending={
                  (isReviewSender &&
                    (graduateMutation.isPending ||
                      keepMutation.isPending ||
                      dismissReviewMutation.isPending)) ||
                  ((item.kind === "approval" || item.kind === "draft") &&
                    (approveMutation.isPending || rejectMutation.isPending)) ||
                  (isFailedRun && retryRunMutation.isPending)
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function PreviewBanner({ onDisable }: { onDisable: () => void }) {
  return (
    <div className="border border-sky-500/30 bg-sky-500/10 px-4 py-2 text-[12px] text-sky-700 dark:text-sky-300 flex items-center justify-between">
      <span>
        <strong>Unified Inbox.</strong> Approvals, drafts, email review, and failed runs in one
        ranked list.
      </span>
      <button
        type="button"
        onClick={onDisable}
        className="px-2 py-0.5 text-[11px] border border-sky-500/40 hover:bg-sky-500/20"
      >
        Switch back to current Inbox
      </button>
    </div>
  );
}

interface InboxItemRowProps {
  item: InboxItem;
  onDismiss: () => void;
  onApprove?: () => void;
  onReject?: () => void;
  onGraduate?: () => void;
  onKeep?: () => void;
  onDismissRule?: () => void;
  onRetry?: () => void;
  onOpen: () => void;
  isPending: boolean;
}

function InboxItemRow({
  item,
  onDismiss,
  onApprove,
  onReject,
  onGraduate,
  onKeep,
  onDismissRule,
  onRetry,
  onOpen,
  isPending,
}: InboxItemRowProps) {
  const tone = KIND_TONE[item.kind];
  const Icon = KIND_ICON[item.kind];
  const accentClass = {
    amber: "bg-amber-500/55 group-hover:bg-amber-500/80",
    sky: "bg-sky-500/55 group-hover:bg-sky-500/80",
    red: "bg-red-500/55 group-hover:bg-red-500/80",
    violet: "bg-violet-500/55 group-hover:bg-violet-500/80",
    emerald: "bg-emerald-500/55 group-hover:bg-emerald-500/80",
  }[tone];
  const chipClass = {
    amber: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    sky: "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400",
    red: "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400",
    violet: "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400",
    emerald: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  }[tone];

  return (
    <div className="group relative pl-5 pr-4 py-3.5">
      <span aria-hidden className={cn("absolute left-0 top-0 h-full w-[3px] transition-colors", accentClass)} />
      <div className="flex items-start gap-3">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-muted/40 shrink-0">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span
              className={cn(
                "inline-flex items-center px-2 py-0.5 text-[10px] font-medium border whitespace-nowrap",
                chipClass,
              )}
            >
              {KIND_LABEL[item.kind]}
            </span>
            <span className="font-medium truncate">{item.title}</span>
            <span className="text-[11px] text-muted-foreground/70 shrink-0">
              · {timeAgo(item.createdAt)}
            </span>
          </div>
          {item.subtitle && (
            <p className="mt-1 text-[13px] text-muted-foreground line-clamp-2 leading-relaxed">
              {item.subtitle}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <div className="flex gap-1.5">
            {onApprove && (
              <button
                type="button"
                onClick={onApprove}
                disabled={isPending}
                title="Approve this draft or request. The agent will proceed."
                className="px-2.5 py-1 text-[11px] font-medium border border-border bg-foreground text-background hover:opacity-90 disabled:opacity-50"
              >
                Approve
              </button>
            )}
            {onReject && (
              <button
                type="button"
                onClick={onReject}
                disabled={isPending}
                title="Reject this draft or request. The agent will not proceed."
                className="px-2.5 py-1 text-[11px] font-medium border border-border bg-background text-foreground hover:bg-accent disabled:opacity-50"
              >
                Reject
              </button>
            )}
            {onGraduate && (
              <button
                type="button"
                onClick={onGraduate}
                disabled={isPending}
                title="Move all future mail from this sender to _paperclip/triage automatically."
                className="px-2.5 py-1 text-[11px] font-medium border border-border bg-foreground text-background hover:opacity-90 disabled:opacity-50"
              >
                Auto-triage
              </button>
            )}
            {onKeep && (
              <button
                type="button"
                onClick={onKeep}
                disabled={isPending}
                title="Always leave mail from this sender in INBOX."
                className="px-2.5 py-1 text-[11px] font-medium border border-border bg-background text-foreground hover:bg-accent disabled:opacity-50"
              >
                Keep
              </button>
            )}
            {onDismissRule && (
              <button
                type="button"
                onClick={onDismissRule}
                disabled={isPending}
                title="Drop from the review queue without writing a rule."
                className="px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent border border-transparent disabled:opacity-50"
              >
                Dismiss
              </button>
            )}
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                disabled={isPending}
                title="Wake the agent up to run this again with the same context."
                className="px-2.5 py-1 text-[11px] font-medium border border-border bg-background text-foreground hover:bg-accent disabled:opacity-50"
              >
                <RefreshCcw className="h-3 w-3 inline mr-1" />
                Retry
              </button>
            )}
            <button
              type="button"
              onClick={onOpen}
              title={openTitle(item)}
              className="px-2.5 py-1 text-[11px] font-medium border border-border bg-background text-foreground hover:bg-accent"
            >
              Open
            </button>
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Hide from inbox"
              title="Hide from this inbox view (won't change underlying state)."
              className="px-1.5 py-1 text-muted-foreground hover:text-foreground hover:bg-accent border border-transparent"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {item.meta && (
            <span className="text-[11px] text-muted-foreground">{item.meta}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function openTitle(item: InboxItem): string {
  switch (item.kind) {
    case "approval":
    case "draft":
      return "Open the approval detail page.";
    case "email_review_sender":
      return "Open the email triage rules document for this mailbox.";
    case "failed_run":
      return "Open the agent's run detail to see logs and errors.";
  }
}

function approvalShortTitle(a: Approval, isDraft: boolean): string {
  const summary =
    typeof a.payload?.summary === "string" ? (a.payload.summary as string) : null;
  if (summary) return summary;
  if (isDraft) return `Tool draft: ${a.type}`;
  return `Approval: ${a.type}`;
}

function openItem(item: InboxItem, navigate: ReturnType<typeof useNavigate>) {
  switch (item.kind) {
    case "approval":
    case "draft":
      navigate(`/approvals/${item.approvalId}`);
      return;
    case "email_review_sender":
      navigate(`/issues/${item.rulesIssueId}`);
      return;
    case "failed_run":
      navigate(`/agents/${item.agentId}/runs/${item.runId}`);
      return;
  }
}

export { isUnifiedInboxEnabled };
