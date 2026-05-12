import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "@/lib/router";
import { useQueries, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertOctagon,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  Inbox as InboxIcon,
  Mail,
  Pencil,
  RefreshCcw,
  Search,
  UserPlus,
  X,
} from "lucide-react";
import type { Approval, Issue, IssueDocument } from "@paperclipai/shared";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { approvalsApi } from "../api/approvals";
import { ApiError } from "../api/client";
import { issuesApi } from "../api/issues";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useInboxDismissals } from "../hooks/useInboxBadge";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import {
  dismissReviewSender,
  headerMatchesSender,
  parseReviewQueue,
} from "../lib/email-triage-rules";
import { useEmailToolsPlugin } from "../hooks/useEmailToolsPlugin";
import { makeEmailToolsApi, type MailHeader } from "../api/emailTools";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ACTIONABLE_APPROVAL_STATUSES,
  getLatestFailedRunsByAgent,
  getRecentTouchedIssues,
  isInboxEntityDismissed,
  issueLastActivityTimestamp,
} from "../lib/inbox";
import { isUnifiedInboxEnabled, setUnifiedInboxEnabled } from "../lib/unified-inbox-flag";

const INBOX_ISSUE_STATUSES = "backlog,todo,in_progress,in_review,blocked,done";
const INBOX_ISSUE_LIST_LIMIT = 200;

const RULES_HOME_TITLE_PREFIX = "Email triage rules - ";
const RULES_HOME_DOC_KEY = "email-triage-rules";

type ItemKind =
  | "approval"
  | "draft"
  | "issue"
  | "email_review_sender"
  | "failed_run"
  | "join_request";

const ITEM_KINDS: ItemKind[] = [
  "approval",
  "draft",
  "issue",
  "email_review_sender",
  "failed_run",
  "join_request",
];

type ViewMode = "active" | "all";

interface BaseItem {
  id: string;
  kind: ItemKind;
  createdAt: string;
  activityAt: string;
  title: string;
  subtitle?: string;
  meta?: string;
  rankWeight: number;
}

interface ApprovalItem extends BaseItem {
  kind: "approval" | "draft";
  approvalId: string;
  status: Approval["status"];
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

interface JoinRequestItem extends BaseItem {
  kind: "join_request";
  joinRequestId: string;
}

interface IssueItem extends BaseItem {
  kind: "issue";
  issueId: string;
  identifier: string | null;
  isUnread: boolean;
}

type InboxItem =
  | ApprovalItem
  | EmailReviewSenderItem
  | FailedRunItem
  | JoinRequestItem
  | IssueItem;

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
  issue: "Issue",
  email_review_sender: "Email sender",
  failed_run: "Failed run",
  join_request: "Join request",
};

const KIND_FILTER_LABEL: Record<ItemKind, string> = {
  approval: "Approvals",
  draft: "Drafts",
  issue: "Issues",
  email_review_sender: "Email senders",
  failed_run: "Failed runs",
  join_request: "Join requests",
};

const KIND_TONE: Record<ItemKind, "amber" | "sky" | "red" | "violet" | "slate"> = {
  approval: "amber",
  draft: "amber",
  issue: "slate",
  email_review_sender: "sky",
  failed_run: "red",
  join_request: "violet",
};

const KIND_ICON: Record<ItemKind, typeof Mail> = {
  approval: ClipboardCheck,
  draft: Pencil,
  issue: FileText,
  email_review_sender: Mail,
  failed_run: AlertOctagon,
  join_request: UserPlus,
};

export function UnifiedInbox() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { dismissedAtByKey, dismiss } = useInboxDismissals(selectedCompanyId);

  const [view, setView] = useState<ViewMode>("active");
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<Set<ItemKind>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionFlash, setActionFlash] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Inbox" }, { label: "Unified (preview)" }]);
  }, [setBreadcrumbs]);

  const { pluginId: emailPluginId } = useEmailToolsPlugin(selectedCompanyId);
  const emailApi = useMemo(
    () =>
      emailPluginId && selectedCompanyId
        ? makeEmailToolsApi(emailPluginId, selectedCompanyId)
        : null,
    [emailPluginId, selectedCompanyId],
  );

  const { data: approvals, isLoading: approvalsLoading } = useQuery({
    // Fetch ALL approvals so the "All" view can show decided items as
    // history. The "Active" view filters down to actionable in the items
    // memo below, matching the sidebar badge formula.
    queryKey: queryKeys.approvals.list(selectedCompanyId!),
    queryFn: () => approvalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: joinRequests = [] } = useQuery({
    queryKey: queryKeys.access.joinRequests(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    retry: false,
    queryFn: async () => {
      try {
        return await accessApi.listJoinRequests(selectedCompanyId!, "pending_approval");
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          return [];
        }
        throw err;
      }
    },
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

  const uniqueReviewMailboxes = useMemo(() => {
    const seen = new Set<string>();
    for (const bundle of rulesBundles ?? []) {
      const entries = parseReviewQueue(bundle.body);
      if (entries.length > 0) seen.add(bundle.mailbox);
    }
    return Array.from(seen);
  }, [rulesBundles]);

  const previewMessageQueries = useQueries({
    queries: uniqueReviewMailboxes.map((mailbox) => ({
      queryKey: ["unifiedInbox", "reviewQueuePreview", selectedCompanyId, emailPluginId, mailbox],
      queryFn: () => emailApi!.listMessages(mailbox, { limit: 200 }),
      enabled: !!emailApi && !!selectedCompanyId,
      staleTime: 60_000,
    })),
  });

  const { reviewPreviewLookup, reviewMatchedUidsLookup } = useMemo(() => {
    const headerMap = new Map<string, MailHeader>();
    const uidsMap = new Map<string, number[]>();
    uniqueReviewMailboxes.forEach((mailbox, idx) => {
      const messages = previewMessageQueries[idx]?.data?.messages ?? [];
      const bundle = rulesBundles?.find((b) => b.mailbox === mailbox);
      const entries = bundle ? parseReviewQueue(bundle.body) : [];
      for (const entry of entries) {
        const matches = messages.filter((m) => headerMatchesSender(m, entry.sender));
        if (matches.length === 0) continue;
        matches.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        const key = `${mailbox}::${entry.sender}`;
        headerMap.set(key, matches[0]!);
        uidsMap.set(key, matches.map((m) => m.uid));
      }
    });
    return { reviewPreviewLookup: headerMap, reviewMatchedUidsLookup: uidsMap };
  }, [uniqueReviewMailboxes, previewMessageQueries, rulesBundles]);

  const [hoveredPreviewKey, setHoveredPreviewKey] = useState<string | null>(null);
  const hoveredHeader = hoveredPreviewKey ? reviewPreviewLookup.get(hoveredPreviewKey) ?? null : null;
  const hoveredMailbox = hoveredPreviewKey ? hoveredPreviewKey.split("::")[0]! : null;

  const { data: hoveredFullMessage } = useQuery({
    queryKey: [
      "unifiedInbox",
      "reviewQueueFullMessage",
      selectedCompanyId,
      emailPluginId,
      hoveredMailbox,
      hoveredHeader?.uid,
    ],
    queryFn: () => emailApi!.fetchMessage(hoveredMailbox!, hoveredHeader!.uid),
    enabled: !!emailApi && !!hoveredMailbox && !!hoveredHeader,
    staleTime: 10 * 60_000,
  });

  const HEARTBEAT_LIMIT = 200;
  const { data: heartbeats } = useQuery({
    // Match the sidebar-badge window so the unified count and the badge
    // agree on which failed runs are visible.
    queryKey: [...queryKeys.heartbeats(selectedCompanyId!), "limit", HEARTBEAT_LIMIT],
    enabled: !!selectedCompanyId,
    queryFn: () => heartbeatsApi.list(selectedCompanyId!, undefined, HEARTBEAT_LIMIT),
  });

  // mineIssues = touched-by-me with the inbox-archived-by-me filter, matching
  // the sidebar badge formula. Drives the Active count for unread issues.
  const { data: mineIssuesRaw = [] } = useQuery({
    queryKey: [...queryKeys.issues.listMineByMe(selectedCompanyId!), "with-routine-executions"],
    enabled: !!selectedCompanyId,
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        touchedByUserId: "me",
        inboxArchivedByUserId: "me",
        status: INBOX_ISSUE_STATUSES,
        includeRoutineExecutions: true,
        limit: INBOX_ISSUE_LIST_LIMIT,
      }),
  });

  // touchedIssues = everything I've been involved with, including ones I
  // archived from my inbox. Drives the All view so read history is visible.
  const { data: touchedIssuesRaw = [] } = useQuery({
    queryKey: [...queryKeys.issues.listTouchedByMe(selectedCompanyId!), "with-routine-executions"],
    enabled: !!selectedCompanyId,
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        touchedByUserId: "me",
        status: INBOX_ISSUE_STATUSES,
        includeRoutineExecutions: true,
        limit: INBOX_ISSUE_LIST_LIMIT,
      }),
  });

  const mineIssues = useMemo(() => getRecentTouchedIssues(mineIssuesRaw), [mineIssuesRaw]);
  const touchedIssues = useMemo(() => getRecentTouchedIssues(touchedIssuesRaw), [touchedIssuesRaw]);
  const unreadIssueIds = useMemo(
    () => new Set(mineIssues.filter((i) => i.isUnreadForMe).map((i) => i.id)),
    [mineIssues],
  );

  const allItems: InboxItem[] = useMemo(() => {
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
        activityAt: String(a.updatedAt ?? a.createdAt),
        title: approvalShortTitle(a, isDraft),
        subtitle: summary || undefined,
        meta: a.status !== "pending" ? a.status : a.requestedByAgentId ? "from agent" : undefined,
        rankWeight: isDraft ? 70 : 90,
        approvalId: a.id,
        status: a.status,
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
          activityAt: new Date().toISOString(),
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

    // Dedupe to latest run per agent and keep only the ones whose latest
    // run is actually failed — same logic the badge uses, so the count
    // here matches the sidebar count.
    const failedRuns = getLatestFailedRunsByAgent(heartbeats ?? []);
    for (const run of failedRuns) {
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
        id: `run:${run.id}`,
        kind: "failed_run",
        createdAt: String(run.createdAt),
        activityAt: String(run.createdAt),
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
    }

    for (const jr of joinRequests) {
      const subject =
        jr.requestType === "agent"
          ? jr.requestEmailSnapshot ?? "Agent join request"
          : jr.requestEmailSnapshot ?? "Member join request";
      out.push({
        id: `join:${jr.id}`,
        kind: "join_request",
        createdAt: String(jr.createdAt),
        activityAt: String(jr.updatedAt ?? jr.createdAt),
        title: subject,
        subtitle: jr.requestType === "agent" ? "Agent requesting access" : "Person requesting access",
        rankWeight: 85,
        joinRequestId: jr.id,
      } satisfies JoinRequestItem);
    }

    // Touched issues. Unread ones rank with approvals/drafts so they surface
    // in Active; read ones drop to the bottom and only show in All.
    for (const issue of touchedIssues) {
      const isUnread = unreadIssueIds.has(issue.id);
      out.push({
        id: `issue:${issue.id}`,
        kind: "issue",
        createdAt: new Date(issueLastActivityTimestamp(issue)).toISOString(),
        activityAt: new Date(issueLastActivityTimestamp(issue)).toISOString(),
        title: issue.title,
        subtitle: issueSubtitle(issue),
        meta: issue.identifier ?? undefined,
        rankWeight: isUnread ? 75 : 30,
        issueId: issue.id,
        identifier: issue.identifier,
        isUnread,
      } satisfies IssueItem);
    }

    return out
      .filter((it) => !isInboxEntityDismissed(dismissedAtByKey, it.id, it.activityAt))
      .sort((a, b) => {
        if (b.rankWeight !== a.rankWeight) return b.rankWeight - a.rankWeight;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
  }, [approvals, rulesBundles, heartbeats, joinRequests, touchedIssues, unreadIssueIds, dismissedAtByKey]);

  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allItems.filter((it) => {
      if (view === "active") {
        // Active = items that need a human action right now.
        if (it.kind === "approval" || it.kind === "draft") {
          if (!ACTIONABLE_APPROVAL_STATUSES.has(it.status)) return false;
        }
        // Read issues are history; only unread ones are actionable.
        if (it.kind === "issue" && !it.isUnread) return false;
      }
      if (kindFilter.size > 0 && !kindFilter.has(it.kind)) return false;
      if (q) {
        const haystack = `${it.title} ${it.subtitle ?? ""} ${it.meta ?? ""}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [allItems, view, kindFilter, search]);

  const counts = useMemo(() => {
    const active = allItems.filter((it) => {
      if (it.kind === "approval" || it.kind === "draft") {
        return ACTIONABLE_APPROVAL_STATUSES.has(it.status);
      }
      if (it.kind === "issue") return it.isUnread;
      return true;
    }).length;
    return { active, all: allItems.length };
  }, [allItems]);

  function toggleKind(kind: ItemKind) {
    setKindFilter((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  // Flash a brief confirmation so the user sees feedback even when a fresh
  // identical draft replaces the row at the same moment (Clippy can re-fire
  // the same tool call between the approve POST and the list refetch).
  function flash(message: string) {
    setActionError(null);
    setActionFlash(message);
    window.setTimeout(() => {
      setActionFlash((current) => (current === message ? null : current));
    }, 2500);
  }

  const approveMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.approve(id),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.approvals.list(selectedCompanyId!),
      });
      flash("Approved.");
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Approve failed");
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.reject(id),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.approvals.list(selectedCompanyId!),
      });
      flash("Rejected.");
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Reject failed");
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
    mutationFn: async (item: EmailReviewSenderItem) => {
      // DB is the source of truth for sender rules. The Markdown's rule
      // sections are no longer written — the agent reads rules from the DB
      // via email_list_rules. We still remove the row from the Markdown's
      // Review queue section so it doesn't keep appearing.
      if (emailApi) await emailApi.setRule(item.mailbox, item.sender, "auto-triage");
      await applyReviewSenderTransform(item, dismissReviewSender);
    },
    ...reviewSenderMutationOptions,
  });
  const keepUnreadMutation = useMutation({
    mutationFn: async (item: EmailReviewSenderItem) => {
      if (emailApi) await emailApi.setRule(item.mailbox, item.sender, "keep-always");
      await applyReviewSenderTransform(item, dismissReviewSender);
    },
    ...reviewSenderMutationOptions,
  });
  const keepReadMutation = useMutation({
    mutationFn: async (item: EmailReviewSenderItem) => {
      if (!emailApi) {
        await applyReviewSenderTransform(item, dismissReviewSender);
        return;
      }
      await emailApi.setRule(item.mailbox, item.sender, "keep-always");
      const uids = reviewMatchedUidsLookup.get(`${item.mailbox}::${item.sender}`) ?? [];
      await Promise.allSettled(
        uids.map((uid) => emailApi.markRead(item.mailbox, uid, "INBOX")),
      );
      await applyReviewSenderTransform(item, dismissReviewSender);
    },
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

  function disablePreview() {
    setUnifiedInboxEnabled(false);
    // Mirror the enable-side reload: the legacy page checks the flag on mount
    // and won't re-render on a same-route navigate, so a hard reload is the
    // simplest reliable switch.
    window.location.reload();
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
            One queue: approvals, drafts, email review, failed runs, and join requests. Ranked by urgency.
          </p>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <span className="text-[12px] text-muted-foreground tabular-nums">
            {items.length} of {view === "active" ? counts.active : counts.all} item{items.length === 1 ? "" : "s"}
          </span>
          <Link
            to="/issues"
            className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            Looking for an issue? Browse issues →
          </Link>
        </div>
      </header>

      <InboxToolbar
        view={view}
        onViewChange={setView}
        activeCount={counts.active}
        allCount={counts.all}
        search={search}
        onSearchChange={setSearch}
        kindFilter={kindFilter}
        onToggleKind={toggleKind}
        onClearFilters={() => {
          setKindFilter(new Set());
          setSearch("");
        }}
      />

      {actionError && (
        <div
          role="alert"
          className="border border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300 px-3 py-2 text-[12px] flex items-center justify-between gap-3"
        >
          <span>{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="text-[11px] underline hover:no-underline"
          >
            Dismiss
          </button>
        </div>
      )}
      {actionFlash && !actionError && (
        <div
          role="status"
          aria-live="polite"
          className="border border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 px-3 py-2 text-[12px]"
        >
          {actionFlash}
        </div>
      )}

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
            const previewKey = isReviewSender ? `${item.mailbox}::${item.sender}` : null;
            const previewHeader = previewKey ? reviewPreviewLookup.get(previewKey) ?? null : null;
            const isHovered = !!previewKey && hoveredPreviewKey === previewKey;
            const messageHref = isReviewSender
              ? previewHeader
                ? `/email?mailbox=${encodeURIComponent(item.mailbox)}&folder=INBOX&uid=${previewHeader.uid}&all=1`
                : `/email?mailbox=${encodeURIComponent(item.mailbox)}&folder=INBOX&all=1`
              : undefined;
            return (
              <InboxItemRow
                key={item.id}
                item={item}
                onDismiss={isReviewSender ? undefined : () => dismiss(item.id)}
                onApprove={
                  (item.kind === "approval" || item.kind === "draft") &&
                  ACTIONABLE_APPROVAL_STATUSES.has(item.status)
                    ? () => approveMutation.mutate(item.approvalId)
                    : undefined
                }
                onReject={
                  (item.kind === "approval" || item.kind === "draft") &&
                  ACTIONABLE_APPROVAL_STATUSES.has(item.status)
                    ? () => rejectMutation.mutate(item.approvalId)
                    : undefined
                }
                onGraduate={
                  isReviewSender ? () => graduateMutation.mutate(item) : undefined
                }
                onKeepRead={
                  isReviewSender ? () => keepReadMutation.mutate(item) : undefined
                }
                onKeepUnread={
                  isReviewSender ? () => keepUnreadMutation.mutate(item) : undefined
                }
                onDismissRule={
                  isReviewSender ? () => dismissReviewMutation.mutate(item) : undefined
                }
                onRetry={
                  isFailedRun ? () => retryRunMutation.mutate(item) : undefined
                }
                onOpen={() => openItem(item, navigate, messageHref)}
                previewHeader={previewHeader}
                fullBodyText={isHovered ? hoveredFullMessage?.text ?? null : null}
                fullBodyLoading={isHovered && !!previewHeader && !hoveredFullMessage}
                onHoverChange={
                  previewKey
                    ? (entered) => {
                        if (entered) setHoveredPreviewKey(previewKey);
                        else setHoveredPreviewKey((cur) => (cur === previewKey ? null : cur));
                      }
                    : undefined
                }
                messageHref={messageHref}
                isPending={
                  (isReviewSender &&
                    (graduateMutation.isPending ||
                      keepReadMutation.isPending ||
                      keepUnreadMutation.isPending ||
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
  onDismiss?: () => void;
  onApprove?: () => void;
  onReject?: () => void;
  onGraduate?: () => void;
  onKeepRead?: () => void;
  onKeepUnread?: () => void;
  onDismissRule?: () => void;
  onRetry?: () => void;
  onOpen: () => void;
  previewHeader?: MailHeader | null;
  fullBodyText?: string | null;
  fullBodyLoading?: boolean;
  onHoverChange?: (entered: boolean) => void;
  messageHref?: string;
  isPending: boolean;
}

const PREVIEW_BODY_CHARS = 700;

function truncateBody(text: string, max: number): { text: string; truncated: boolean } {
  const collapsed = text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (collapsed.length <= max) return { text: collapsed, truncated: false };
  return { text: collapsed.slice(0, max).trimEnd() + "…", truncated: true };
}

function InboxItemRow({
  item,
  onDismiss,
  onApprove,
  onReject,
  onGraduate,
  onKeepRead,
  onKeepUnread,
  onDismissRule,
  onRetry,
  onOpen,
  previewHeader,
  fullBodyText,
  fullBodyLoading,
  onHoverChange,
  messageHref,
  isPending,
}: InboxItemRowProps) {
  const tone = KIND_TONE[item.kind];
  const Icon = KIND_ICON[item.kind];
  const isReadIssue = item.kind === "issue" && !item.isUnread;
  const chipLabel =
    (item.kind === "approval" || item.kind === "draft") &&
    !ACTIONABLE_APPROVAL_STATUSES.has(item.status)
      ? item.status.charAt(0).toUpperCase() + item.status.slice(1)
      : KIND_LABEL[item.kind];
  const accentClass = {
    amber: "bg-amber-500/55 group-hover:bg-amber-500/80",
    sky: "bg-sky-500/55 group-hover:bg-sky-500/80",
    red: "bg-red-500/55 group-hover:bg-red-500/80",
    violet: "bg-violet-500/55 group-hover:bg-violet-500/80",
    emerald: "bg-emerald-500/55 group-hover:bg-emerald-500/80",
    slate: "bg-slate-400/55 group-hover:bg-slate-400/80",
  }[tone];
  const chipClass = {
    amber: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    sky: "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400",
    red: "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400",
    violet: "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400",
    emerald: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    slate: "border-slate-400/40 bg-slate-400/10 text-slate-600 dark:text-slate-400",
  }[tone];

  const isReviewSender = item.kind === "email_review_sender";
  const subjectLine = previewHeader?.subject?.trim() || "";
  const snippet = previewHeader?.snippet?.trim() || "";
  const fullBody = fullBodyText ? truncateBody(fullBodyText, PREVIEW_BODY_CHARS) : null;

  const reviewBody = isReviewSender ? (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span
          className={cn(
            "inline-flex items-center px-2 py-0.5 text-[10px] font-medium border whitespace-nowrap",
            chipClass,
          )}
        >
          {chipLabel}
        </span>
        <span className="truncate font-medium font-mono text-[13px]">{item.title}</span>
        <span className="text-[11px] text-muted-foreground/70 shrink-0">
          · {timeAgo(item.createdAt)}
        </span>
      </div>
      <p className="mt-1 text-[13px] text-muted-foreground line-clamp-2 leading-relaxed">
        {previewHeader ? (
          subjectLine || <span className="italic">(no subject)</span>
        ) : (
          item.subtitle || ""
        )}
      </p>
    </>
  ) : null;

  return (
    <div
      className="group relative pl-5 pr-4 py-3.5"
      onMouseEnter={onHoverChange ? () => onHoverChange(true) : undefined}
      onMouseLeave={onHoverChange ? () => onHoverChange(false) : undefined}
    >
      <span aria-hidden className={cn("absolute left-0 top-0 h-full w-[3px] transition-colors", accentClass)} />
      <div className="flex items-start gap-3">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-muted/40 shrink-0">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        </span>
        <div className="flex-1 min-w-0">
          {isReviewSender && messageHref ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  to={messageHref}
                  title={previewHeader ? "Open this email" : "Open this mailbox (no recent message found in INBOX)"}
                  className="block group/link cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500/40 rounded-sm"
                >
                  {reviewBody}
                </Link>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                align="start"
                className="max-w-lg p-3 text-left whitespace-normal"
              >
                {previewHeader ? (
                  <div className="space-y-1.5">
                    <div className="text-[13px] font-medium leading-snug break-words">
                      {subjectLine || "(no subject)"}
                    </div>
                    {fullBody ? (
                      <div className="text-[12px] leading-snug break-words whitespace-pre-wrap opacity-90 max-h-64 overflow-hidden">
                        {fullBody.text}
                      </div>
                    ) : snippet ? (
                      <div className="text-[12px] leading-snug break-words opacity-80">
                        {snippet}
                        {fullBodyLoading && <span className="ml-1 opacity-60">· loading more…</span>}
                      </div>
                    ) : fullBodyLoading ? (
                      <div className="text-[12px] opacity-60">Loading preview…</div>
                    ) : null}
                    <div className="text-[11px] pt-1 opacity-70">
                      {timeAgo(previewHeader.date)} · click to open
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1 text-[12px]">
                    <div className="font-medium">No recent message preview</div>
                    <div className="opacity-70">
                      Couldn't find a recent message from{" "}
                      <span className="font-mono">{isReviewSender ? item.sender : ""}</span> in the last 200 INBOX messages.
                    </div>
                    <div className="opacity-70">
                      <span className="underline-offset-2 group-hover:underline">click to open mailbox</span>
                    </div>
                  </div>
                )}
              </TooltipContent>
            </Tooltip>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span
                  className={cn(
                    "inline-flex items-center px-2 py-0.5 text-[10px] font-medium border whitespace-nowrap",
                    chipClass,
                  )}
                >
                  {chipLabel}
                </span>
                <span className={cn("truncate", isReadIssue ? "font-normal text-muted-foreground" : "font-medium")}>{item.title}</span>
                <span className="text-[11px] text-muted-foreground/70 shrink-0">
                  · {timeAgo(item.createdAt)}
                </span>
              </div>
              {item.subtitle && (
                <p className="mt-1 text-[13px] text-muted-foreground line-clamp-2 leading-relaxed">
                  {item.subtitle}
                </p>
              )}
            </>
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
            {onKeepRead && (
              <button
                type="button"
                onClick={onKeepRead}
                disabled={isPending}
                title="Keep this sender in INBOX going forward AND mark the existing messages as read."
                className="px-2.5 py-1 text-[11px] font-medium border border-border bg-background text-foreground hover:bg-accent disabled:opacity-50"
              >
                Keep · read
              </button>
            )}
            {onKeepUnread && (
              <button
                type="button"
                onClick={onKeepUnread}
                disabled={isPending}
                title="Keep this sender in INBOX going forward and leave existing messages unread."
                className="px-2.5 py-1 text-[11px] font-medium border border-border bg-background text-foreground hover:bg-accent disabled:opacity-50"
              >
                Keep · unread
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
            {onDismiss && (
              <button
                type="button"
                onClick={onDismiss}
                aria-label="Hide from inbox"
                title="Hide from this inbox view (won't change underlying state)."
                className="px-1.5 py-1 text-muted-foreground hover:text-foreground hover:bg-accent border border-transparent"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
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
      return "Open the actual email for this sender (or the mailbox if none was found).";
    case "failed_run":
      return "Open the agent's run detail to see logs and errors.";
    case "join_request":
      return "Open the join request queue to approve or reject.";
    case "issue":
      return "Open the issue.";
  }
}

function issueSubtitle(issue: Issue): string | undefined {
  const status = issue.status?.replaceAll("_", " ");
  const description = issue.description?.trim();
  if (description) {
    const firstLine = description.split("\n")[0]!.trim();
    if (firstLine) return status ? `${status} — ${firstLine}` : firstLine;
  }
  return status || undefined;
}

function approvalShortTitle(a: Approval, isDraft: boolean): string {
  const summary =
    typeof a.payload?.summary === "string" ? (a.payload.summary as string) : null;
  if (summary) return summary;
  if (isDraft) return `Tool draft: ${a.type}`;
  return `Approval: ${a.type}`;
}

function openItem(
  item: InboxItem,
  navigate: ReturnType<typeof useNavigate>,
  messageHrefOverride?: string,
) {
  switch (item.kind) {
    case "approval":
    case "draft":
      navigate(`/approvals/${item.approvalId}`);
      return;
    case "email_review_sender":
      navigate(messageHrefOverride ?? `/issues/${item.rulesIssueId}`);
      return;
    case "failed_run":
      navigate(`/agents/${item.agentId}/runs/${item.runId}`);
      return;
    case "join_request":
      navigate(`/inbox/requests`);
      return;
    case "issue":
      navigate(`/issues/${item.issueId}`);
      return;
  }
}

interface InboxToolbarProps {
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  activeCount: number;
  allCount: number;
  search: string;
  onSearchChange: (q: string) => void;
  kindFilter: Set<ItemKind>;
  onToggleKind: (kind: ItemKind) => void;
  onClearFilters: () => void;
}

function InboxToolbar({
  view,
  onViewChange,
  activeCount,
  allCount,
  search,
  onSearchChange,
  kindFilter,
  onToggleKind,
  onClearFilters,
}: InboxToolbarProps) {
  const hasActiveFilters = kindFilter.size > 0 || search.length > 0;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex border border-border bg-card overflow-hidden">
          <button
            type="button"
            onClick={() => onViewChange("active")}
            className={cn(
              "px-3 py-1 text-[12px] font-medium transition-colors",
              view === "active"
                ? "bg-foreground text-background"
                : "text-foreground hover:bg-accent",
            )}
            title="Items needing a human action right now."
          >
            Active <span className="text-[11px] opacity-70 tabular-nums">({activeCount})</span>
          </button>
          <button
            type="button"
            onClick={() => onViewChange("all")}
            className={cn(
              "px-3 py-1 text-[12px] font-medium border-l border-border transition-colors",
              view === "all"
                ? "bg-foreground text-background"
                : "text-foreground hover:bg-accent",
            )}
            title="Active items plus history (decided approvals etc.)."
          >
            All <span className="text-[11px] opacity-70 tabular-nums">({allCount})</span>
          </button>
        </div>

        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/60" />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search inbox…"
            className="w-full border border-border bg-card pl-7 pr-2 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-foreground/30"
          />
        </div>

        {hasActiveFilters && (
          <button
            type="button"
            onClick={onClearFilters}
            className="text-[11px] text-muted-foreground hover:text-foreground underline"
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-muted-foreground/70">Filter:</span>
        {ITEM_KINDS.map((kind) => {
          const active = kindFilter.has(kind);
          return (
            <button
              key={kind}
              type="button"
              onClick={() => onToggleKind(kind)}
              className={cn(
                "px-2 py-0.5 text-[11px] font-medium border transition-colors",
                active
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-card text-muted-foreground hover:text-foreground hover:bg-accent",
              )}
            >
              {KIND_FILTER_LABEL[kind]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export { isUnifiedInboxEnabled };
