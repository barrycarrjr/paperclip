import { useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Sun,
  Sunrise,
  Moon,
  ListChecks,
  Sparkles,
  AlertCircle,
  CheckCircle2,
  Mail,
  Bot,
  CircleDot,
  DollarSign,
  ShieldCheck,
  PauseCircle,
} from "lucide-react";
import { ApiError } from "../api/client";
import { dashboardApi } from "../api/dashboard";
import { activityApi } from "../api/activity";
import { approvalsApi } from "../api/approvals";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { accessApi } from "../api/access";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Identity } from "../components/Identity";
import { StatusIcon } from "../components/StatusIcon";
import { MetricCard } from "../components/MetricCard";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import {
  ChartCard,
  RunActivityChart,
  PriorityChart,
  IssueStatusChart,
  SuccessRateChart,
} from "../components/ActivityCharts";
import { approvalLabel, typeIcon, defaultTypeIcon } from "../components/ApprovalPayload";
import { timeAgo } from "../lib/timeAgo";
import { cn, formatCents } from "../lib/utils";
import { buildCompanyUserProfileMap, type CompanyUserProfile } from "../lib/company-members";
import { summarizeOutcome, isOutcomeAction } from "../lib/outcomes";
import { PluginSlotOutlet } from "@/plugins/slots";
import {
  dismissReviewSender,
  graduateSender,
  keepAlwaysSender,
  parseReviewQueue,
  type ReviewQueueEntry,
} from "../lib/email-triage-rules";
import type { Agent, ActivityEvent, Approval, Issue, IssueDocument } from "@paperclipai/shared";

const OVERNIGHT_HOURS = 14;
const OUTCOMES_LIMIT = 200;
const OUTCOMES_SHOWN = 8;
const DRAFTS_SHOWN = 5;
const REVIEW_QUEUE_SHOWN = 5;
const RULES_HOME_TITLE_PREFIX = "Email triage rules - ";
const RULES_HOME_DOC_KEY = "email-triage-rules";

interface ReviewQueueRow {
  sender: string;
  count: number;
  mailbox: string;
  rulesIssueId: string;
}

interface RulesHomeBundle {
  issueId: string;
  mailbox: string;
  title: string;
  body: string;
  latestRevisionId: string | null;
}

function greeting(now: Date): { word: string; icon: typeof Sun } {
  const h = now.getHours();
  if (h < 5) return { word: "Up late", icon: Moon };
  if (h < 11) return { word: "Good morning", icon: Sunrise };
  if (h < 18) return { word: "Good afternoon", icon: Sun };
  return { word: "Good evening", icon: Moon };
}

export function MorningBrief() {
  const { selectedCompanyId, companies } = useCompany();
  const { openOnboarding } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Brief" }]);
  }, [setBreadcrumbs]);

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: queryKeys.dashboard(selectedCompanyId!),
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: activity } = useQuery({
    queryKey: [...queryKeys.activity(selectedCompanyId!), { limit: OUTCOMES_LIMIT }],
    queryFn: () => activityApi.list(selectedCompanyId!, { limit: OUTCOMES_LIMIT }),
    enabled: !!selectedCompanyId,
  });

  const { data: approvals } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!, "pending"),
    queryFn: () => approvalsApi.list(selectedCompanyId!, "pending"),
    enabled: !!selectedCompanyId,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: members } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const queryClient = useQueryClient();
  const [pendingRowAction, setPendingRowAction] = useState<string | null>(null);
  const [reviewQueueExpanded, setReviewQueueExpanded] = useState(false);

  const { data: rulesBundles } = useQuery<RulesHomeBundle[]>({
    queryKey: ["morningBrief", "emailTriageRules", selectedCompanyId],
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

  const reviewQueue: ReviewQueueRow[] = useMemo(() => {
    if (!rulesBundles) return [];
    const rows: ReviewQueueRow[] = [];
    for (const bundle of rulesBundles) {
      const entries = parseReviewQueue(bundle.body);
      for (const e of entries) {
        rows.push({
          sender: e.sender,
          count: e.count,
          mailbox: bundle.mailbox,
          rulesIssueId: bundle.issueId,
        });
      }
    }
    return rows.sort((a, b) => b.count - a.count);
  }, [rulesBundles]);

  const reviewMutationOptions = {
    onMutate: (row: ReviewQueueRow) =>
      setPendingRowAction(`${row.rulesIssueId}::${row.sender}`),
    onSettled: () => setPendingRowAction(null),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["morningBrief", "emailTriageRules", selectedCompanyId],
      });
    },
  };

  async function applyReviewTransform(
    row: ReviewQueueRow,
    transform: (body: string, sender: string) => string,
  ) {
    const bundle = rulesBundles?.find((b) => b.issueId === row.rulesIssueId);
    if (!bundle) throw new Error("Rules document no longer available.");

    // Refetch the latest revision before writing — the email-triage agent
    // writes to this same document during runs, and stale baseRevisionIds
    // come back as 409 Conflict. One retry on conflict is enough for the
    // common race; persistent contention will surface as the second error.
    const submit = async (body: string, baseRevisionId: string | null) => {
      await issuesApi.upsertDocument(row.rulesIssueId, RULES_HOME_DOC_KEY, {
        title: bundle.title,
        format: "markdown",
        body: transform(body, row.sender),
        baseRevisionId: baseRevisionId ?? undefined,
      });
    };

    try {
      await submit(bundle.body, bundle.latestRevisionId);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 409) throw err;
      const fresh: IssueDocument = await issuesApi.getDocument(
        row.rulesIssueId,
        RULES_HOME_DOC_KEY,
      );
      await submit(fresh.body ?? "", fresh.latestRevisionId ?? null);
    }
  }

  const graduateMutation = useMutation({
    mutationFn: (row: ReviewQueueRow) => applyReviewTransform(row, graduateSender),
    ...reviewMutationOptions,
  });
  const keepMutation = useMutation({
    mutationFn: (row: ReviewQueueRow) => applyReviewTransform(row, keepAlwaysSender),
    ...reviewMutationOptions,
  });
  const dismissMutation = useMutation({
    mutationFn: (row: ReviewQueueRow) => applyReviewTransform(row, dismissReviewSender),
    ...reviewMutationOptions,
  });
  const lastReviewError =
    graduateMutation.error ?? keepMutation.error ?? dismissMutation.error;

  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(members?.users),
    [members?.users],
  );

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const overnightCutoff = useMemo(() => {
    const d = new Date();
    d.setHours(d.getHours() - OVERNIGHT_HOURS);
    return d;
  }, []);

  const outcomes: ActivityEvent[] = useMemo(() => {
    if (!activity) return [];
    return activity.filter((e) => {
      if (!isOutcomeAction(e.action)) return false;
      return new Date(e.createdAt).getTime() >= overnightCutoff.getTime();
    });
  }, [activity, overnightCutoff]);

  const myUserId = session?.user?.id ?? null;
  const myIssues: Issue[] = useMemo(() => {
    if (!issues) return [];
    return issues
      .filter((i) =>
        myUserId
          ? i.assigneeUserId === myUserId
          : i.status === "in_review" || i.status === "todo",
      )
      .filter((i) => i.status !== "done" && i.status !== "cancelled")
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 6);
  }, [issues, myUserId]);

  if (!selectedCompanyId) {
    if (companies.length === 0) {
      return (
        <EmptyState
          icon={Sunrise}
          message="Welcome to Paperclip. Set up your first company to see your morning brief."
        />
      );
    }
    return (
      <EmptyState icon={Sunrise} message="Select a company to see its morning brief." />
    );
  }

  if (summaryLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  const now = new Date();
  const { word, icon: HeroIcon } = greeting(now);
  const userName =
    session?.user?.name?.split(" ")[0] ||
    session?.user?.email?.split("@")[0] ||
    "there";

  // Hero pulse: outcomes overnight + drafts awaiting + errors + spend
  const pendingApprovals = approvals?.length ?? 0;
  const errors = summary?.agents.error ?? 0;

  // Count outcomes only from last OVERNIGHT_HOURS
  const overnightCount = outcomes.length;

  const allClear = errors === 0 && (summary?.budgets.activeIncidents ?? 0) === 0;
  const heroTone: "emerald" | "amber" | "red" = errors > 0 ? "red" : pendingApprovals > 0 ? "amber" : "emerald";

  const heroBarClass = {
    emerald: "bg-emerald-500/55",
    amber: "bg-amber-500/55",
    red: "bg-red-500/55",
  }[heroTone];

  // Metric card state (absorbed from old Dashboard)
  const totalAgents = summary
    ? summary.agents.active + summary.agents.running + summary.agents.paused + summary.agents.error
    : 0;
  const hasNoAgents = !summary || totalAgents === 0;
  const agentTone: "default" | "danger" | "success" =
    summary && summary.agents.error > 0 ? "danger" : summary && summary.agents.running > 0 ? "success" : "default";
  const tasksTone: "default" | "warning" =
    summary && summary.tasks.blocked > 0 ? "warning" : "default";
  const costTone: "default" | "warning" | "danger" = (() => {
    if (!summary) return "default";
    if (summary.costs.monthBudgetCents <= 0) return "default";
    if (summary.costs.monthUtilizationPercent >= 100) return "danger";
    if (summary.costs.monthUtilizationPercent >= 80) return "warning";
    return "default";
  })();
  const pendingTotal = summary ? summary.pendingApprovals + summary.budgets.pendingApprovals : 0;
  const approvalsTone: "default" | "warning" = pendingTotal > 0 ? "warning" : "default";

  const draftsToShow = (approvals ?? []).slice(0, DRAFTS_SHOWN);
  const remainingDrafts = Math.max(0, (approvals?.length ?? 0) - DRAFTS_SHOWN);

  const outcomesToShow = outcomes.slice(0, OUTCOMES_SHOWN);
  const remainingOutcomes = Math.max(0, outcomes.length - OUTCOMES_SHOWN);

  return (
    <div className="space-y-8">
      {/* Empty agents banner */}
      {hasNoAgents && (
        <div className="flex items-center justify-between gap-3 border-l-[3px] border-amber-500 bg-amber-50/60 px-4 py-3 dark:bg-amber-950/40">
          <div className="flex items-center gap-2.5">
            <Bot className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <p className="text-sm text-amber-900 dark:text-amber-100">
              You have no agents yet.
            </p>
          </div>
          <button
            onClick={() => openOnboarding({ initialStep: 2, companyId: selectedCompanyId })}
            className="text-sm font-medium text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100 underline underline-offset-2 shrink-0"
          >
            Create one here
          </button>
        </div>
      )}

      {/* Budget incidents banner */}
      {summary && summary.budgets.activeIncidents > 0 ? (
        <div className="flex items-start justify-between gap-3 border-l-[3px] border-red-500 bg-red-500/5 px-4 py-3 dark:bg-red-950/30">
          <div className="flex items-start gap-2.5">
            <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
            <div>
              <p className="text-sm font-semibold text-red-900 dark:text-red-50">
                {summary.budgets.activeIncidents} active budget incident{summary.budgets.activeIncidents === 1 ? "" : "s"}
              </p>
              <p className="text-xs text-red-700/80 dark:text-red-100/80 mt-0.5">
                {summary.budgets.pausedAgents} agents paused · {summary.budgets.pausedProjects} projects paused · {summary.budgets.pendingApprovals} pending budget approvals
              </p>
            </div>
          </div>
          <Link to="/costs" className="text-sm underline underline-offset-2 text-red-700 dark:text-red-100 shrink-0 self-center">
            Open budgets
          </Link>
        </div>
      ) : null}

      {/* Hero */}
      <section
        aria-label="Morning brief"
        className="group relative overflow-hidden border border-border bg-card pl-6 pr-5 py-6"
      >
        <span aria-hidden className={cn("absolute left-0 top-0 h-full w-[3px]", heroBarClass)} />
        <div className="flex items-start gap-4">
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-md bg-muted/40">
            <HeroIcon className="h-5 w-5 text-muted-foreground" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">
              {word}, {userName}.
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Here's what your agents got done overnight, and what's lined up today.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
              <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.18)]" />
                <span className="font-medium text-foreground">
                  {allClear ? "All systems green." : errors > 0 ? `${errors} agent error${errors === 1 ? "" : "s"}.` : "Mostly clear."}
                </span>
              </span>
              <span className="text-muted-foreground">{overnightCount} outcomes overnight</span>
            </div>
          </div>
        </div>
      </section>

      {/* Metric cards (absorbed from Dashboard) */}
      {summary && (
        <section aria-label="Key metrics">
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-px bg-border">
            <MetricCard
              icon={Bot}
              value={totalAgents}
              label="Agents"
              to="/agents"
              tone={agentTone}
              description={
                <span>
                  {summary.agents.running} running · {summary.agents.paused} paused · {summary.agents.error} errors
                </span>
              }
            />
            <MetricCard
              icon={CircleDot}
              value={summary.tasks.inProgress}
              label="In Progress"
              to="/issues"
              tone={tasksTone}
              description={
                <span>
                  {summary.tasks.open} open · {summary.tasks.blocked} blocked
                </span>
              }
            />
            <MetricCard
              icon={DollarSign}
              value={formatCents(summary.costs.monthSpendCents)}
              label="Month Spend"
              to="/costs"
              tone={costTone}
              description={
                <span>
                  {summary.costs.monthBudgetCents > 0
                    ? `${summary.costs.monthUtilizationPercent}% of ${formatCents(summary.costs.monthBudgetCents)} budget`
                    : "No budget set"}
                </span>
              }
            />
            <MetricCard
              icon={ShieldCheck}
              value={pendingTotal}
              label="Pending Approvals"
              to="/approvals"
              tone={approvalsTone}
              description={
                <span>
                  {summary.budgets.pendingApprovals > 0
                    ? `${summary.budgets.pendingApprovals} budget overrides awaiting board review`
                    : pendingTotal > 0
                      ? "Awaiting board review"
                      : "All clear"}
                </span>
              }
            />
          </div>
        </section>
      )}

      {/* Awaiting your tap — drafts AND email senders both count */}
      <section aria-label="Awaiting your tap">
        <div className="mb-3 flex items-baseline justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Awaiting your tap
            </h2>
            {pendingApprovals > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 text-[11px] font-medium border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300">
                {pendingApprovals} draft{pendingApprovals === 1 ? "" : "s"}
              </span>
            )}
            {reviewQueue.length > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 text-[11px] font-medium border border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300">
                {reviewQueue.length} email sender{reviewQueue.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
        </div>

        {pendingApprovals === 0 && reviewQueue.length === 0 ? (
          <div className="border border-border bg-card p-8 text-center">
            <CheckCircle2 className="mx-auto h-5 w-5 text-emerald-500/70" />
            <p className="mt-3 text-sm text-muted-foreground">
              Nothing waiting on you. Inbox zero.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {pendingApprovals > 0 && (
              <div>
                <div className="mb-1.5 flex items-baseline justify-between">
                  <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/80">
                    Drafts
                  </h3>
                  <Link
                    to="/approvals/pending"
                    className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
                  >
                    Open all →
                  </Link>
                </div>
                <div className="border border-border bg-card divide-y divide-border">
                  {draftsToShow.map((a) => (
                    <DraftRow key={a.id} approval={a} agentMap={agentMap} />
                  ))}
                  {remainingDrafts > 0 && (
                    <Link
                      to="/approvals/pending"
                      className="block px-4 py-2.5 text-center text-[12px] text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                    >
                      + {remainingDrafts} more →
                    </Link>
                  )}
                </div>
              </div>
            )}

            {reviewQueue.length > 0 && (
              <div>
                <div className="mb-1.5 flex items-baseline justify-between">
                  <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/80">
                    Email senders awaiting your call
                  </h3>
                  <span className="text-[11px] text-muted-foreground">
                    Auto-triage = move noise · Keep = leave in INBOX · Dismiss = drop without a rule
                  </span>
                </div>
                <div className="border border-border bg-card divide-y divide-border">
                  {(reviewQueueExpanded
                    ? reviewQueue
                    : reviewQueue.slice(0, REVIEW_QUEUE_SHOWN)
                  ).map((row) => {
                    const key = `${row.rulesIssueId}::${row.sender}`;
                    const isPending = pendingRowAction === key;
                    return (
                      <ReviewQueueRow
                        key={key}
                        row={row}
                        pending={isPending}
                        onGraduate={() => graduateMutation.mutate(row)}
                        onKeep={() => keepMutation.mutate(row)}
                        onDismiss={() => dismissMutation.mutate(row)}
                      />
                    );
                  })}
                  {reviewQueue.length > REVIEW_QUEUE_SHOWN && (
                    <button
                      type="button"
                      onClick={() => setReviewQueueExpanded((v) => !v)}
                      className="block w-full px-4 py-2.5 text-center text-[12px] text-muted-foreground hover:bg-accent/40 hover:text-foreground transition-colors"
                    >
                      {reviewQueueExpanded
                        ? "Show fewer"
                        : `+ ${reviewQueue.length - REVIEW_QUEUE_SHOWN} more pending review — show all`}
                    </button>
                  )}
                </div>
                {lastReviewError && (
                  <p className="mt-2 text-[12px] text-red-500">
                    {lastReviewError instanceof Error
                      ? lastReviewError.message
                      : "Couldn't apply that action. Try again."}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Active agents (absorbed from Dashboard) */}
      <ActiveAgentsPanel companyId={selectedCompanyId} />

      {/* Overnight outcomes */}
      <section aria-label="Overnight outcomes">
        <div className="mb-3 flex items-baseline justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Overnight outcomes
            </h2>
            {overnightCount > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 text-[11px] font-medium border border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                {overnightCount} done
              </span>
            )}
          </div>
          <Link to="/receipts" className="text-[11px] font-medium text-muted-foreground hover:text-foreground">
            View receipt feed →
          </Link>
        </div>

        {outcomesToShow.length === 0 ? (
          <div className="border border-border bg-card p-8 text-center">
            <Sparkles className="mx-auto h-5 w-5 text-muted-foreground/40" />
            <p className="mt-3 text-sm text-muted-foreground">
              Nothing produced in the last {OVERNIGHT_HOURS} hours yet. Quiet morning.
            </p>
          </div>
        ) : (
          <div className="border border-border bg-card divide-y divide-border">
            {outcomesToShow.map((event) => (
              <OutcomeRow
                key={event.id}
                event={event}
                agentMap={agentMap}
                userProfileMap={userProfileMap}
              />
            ))}
            {remainingOutcomes > 0 && (
              <Link
                to="/receipts"
                className="block px-4 py-2.5 text-center text-[12px] text-muted-foreground hover:bg-accent/40 hover:text-foreground"
              >
                + {remainingOutcomes} more in the receipt feed →
              </Link>
            )}
          </div>
        )}
      </section>

      {/* Today */}
      <section aria-label="Today">
        <div className="mb-3 flex items-baseline justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Today
            </h2>
            <span className="text-[11px] text-muted-foreground">
              {now.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
            </span>
          </div>
          <Link to="/issues" className="text-[11px] font-medium text-muted-foreground hover:text-foreground">
            All issues →
          </Link>
        </div>

        {myIssues.length === 0 ? (
          <div className="border border-border bg-card p-8 text-center">
            <ListChecks className="mx-auto h-5 w-5 text-muted-foreground/40" />
            <p className="mt-3 text-sm text-muted-foreground">
              No issues need your attention today.
            </p>
          </div>
        ) : (
          <div className="border border-border bg-card divide-y divide-border">
            <div className="px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground border-b border-border bg-muted/20">
              Open issues you own
            </div>
            {myIssues.map((issue) => (
              <Link
                key={issue.id}
                to={`/issues/${issue.identifier ?? issue.id}`}
                className="group block px-4 py-2.5 text-sm cursor-pointer hover:bg-accent/40 transition-colors no-underline text-inherit"
              >
                <div className="flex items-center gap-3">
                  <StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} />
                  <span className="text-[11px] font-mono text-muted-foreground tabular-nums shrink-0">
                    {issue.identifier ?? issue.id.slice(0, 8)}
                  </span>
                  <span className="flex-1 min-w-0 truncate">{issue.title}</span>
                  <span className="text-[11px] text-muted-foreground shrink-0">
                    {timeAgo(issue.updatedAt)}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <PluginSlotOutlet
        slotTypes={["dashboardWidget"]}
        context={{ companyId: selectedCompanyId }}
        className="grid gap-4 md:grid-cols-2"
        itemClassName="border border-border bg-card p-4"
      />

      {/* Trends — charts pushed to the bottom (absorbed from Dashboard) */}
      {summary && (
        <section aria-label="Activity charts">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Trends
            </h2>
            <span className="text-[10px] text-muted-foreground/70">Last 14 days</span>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-border">
            <ChartCard title="Run Activity">
              <RunActivityChart activity={summary.runActivity} />
            </ChartCard>
            <ChartCard title="Issues by Priority">
              <PriorityChart issues={issues ?? []} />
            </ChartCard>
            <ChartCard title="Issues by Status">
              <IssueStatusChart issues={issues ?? []} />
            </ChartCard>
            <ChartCard title="Success Rate">
              <SuccessRateChart activity={summary.runActivity} />
            </ChartCard>
          </div>
        </section>
      )}
    </div>
  );
}

interface ReviewQueueRowProps {
  row: ReviewQueueRow;
  pending: boolean;
  onGraduate: () => void;
  onKeep: () => void;
  onDismiss: () => void;
}

function ReviewQueueRow({ row, pending, onGraduate, onKeep, onDismiss }: ReviewQueueRowProps) {
  return (
    <div className="group relative pl-5 pr-4 py-3">
      <span aria-hidden className="absolute left-0 top-0 h-full w-[3px] bg-sky-500/55 group-hover:bg-sky-500/80 transition-colors" />
      <div className="flex items-start gap-3">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-muted/40 shrink-0">
          <Mail className="h-3.5 w-3.5 text-muted-foreground" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="font-mono text-[13px] truncate">{row.sender}</span>
            <span className="text-[11px] text-muted-foreground">
              · {row.count} message{row.count === 1 ? "" : "s"}
            </span>
            <span className="text-[11px] text-muted-foreground/70">· {row.mailbox} mailbox</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={onGraduate}
            disabled={pending}
            title="Move all future mail from this sender to _paperclip/triage automatically."
            className="px-2.5 py-1 text-[11px] font-medium border border-border bg-foreground text-background hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Auto-triage
          </button>
          <button
            type="button"
            onClick={onKeep}
            disabled={pending}
            title="Always leave mail from this sender in INBOX. Beats Auto-triage if both match."
            className="px-2.5 py-1 text-[11px] font-medium border border-border bg-background text-foreground hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Keep
          </button>
          <button
            type="button"
            onClick={onDismiss}
            disabled={pending}
            title="Remove from this list without writing a rule. Sender may reappear if they send more mail."
            className="px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent border border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

interface DraftRowProps {
  approval: Approval;
  agentMap: Map<string, Agent>;
}

function DraftRow({ approval, agentMap }: DraftRowProps) {
  const Icon = typeIcon[approval.type] ?? defaultTypeIcon;
  const label = approvalLabel(approval.type, approval.payload);
  const requestedBy =
    approval.requestedByAgentId && agentMap.get(approval.requestedByAgentId)?.name;
  const summary =
    typeof approval.payload?.summary === "string"
      ? approval.payload.summary
      : typeof approval.payload?.description === "string"
        ? approval.payload.description
        : null;

  return (
    <div className="group relative pl-5 pr-4 py-3.5">
      <span aria-hidden className="absolute left-0 top-0 h-full w-[3px] bg-amber-500/55 group-hover:bg-amber-500/80 transition-colors" />
      <div className="flex items-start gap-3">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-muted/40 shrink-0">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link
              to={`/approvals/${approval.id}`}
              className="font-medium hover:underline truncate"
            >
              {label}
            </Link>
            {requestedBy && (
              <span className="text-[11px] text-muted-foreground">· {requestedBy}</span>
            )}
            <span className="text-[11px] text-muted-foreground/70">
              · {timeAgo(approval.createdAt)}
            </span>
          </div>
          {summary && (
            <p className="mt-1 text-[13px] text-muted-foreground line-clamp-2 leading-relaxed">
              {summary}
            </p>
          )}
        </div>
        <div className="flex gap-1.5 shrink-0">
          <Link
            to={`/approvals/${approval.id}`}
            className="px-2.5 py-1 text-[11px] font-medium border border-border bg-foreground text-background hover:opacity-90 no-underline"
          >
            Review
          </Link>
        </div>
      </div>
    </div>
  );
}

interface OutcomeRowProps {
  event: ActivityEvent;
  agentMap: Map<string, Agent>;
  userProfileMap: Map<string, CompanyUserProfile>;
}

function OutcomeRow({ event, agentMap, userProfileMap }: OutcomeRowProps) {
  const outcome = summarizeOutcome(event, { agentMap });
  const actorName =
    event.actorType === "agent"
      ? agentMap.get(event.actorId)?.name
      : event.actorType === "user"
        ? userProfileMap.get(event.actorId)?.label ?? null
        : event.actorType === "system"
          ? "System"
          : null;

  const link =
    event.entityType === "issue"
      ? `/issues/${event.entityId}`
      : event.entityType === "approval"
        ? `/approvals/${event.entityId}`
        : event.entityType === "agent"
          ? `/agents/${event.entityId}`
          : null;

  const toneClass = {
    emerald: "text-emerald-500",
    amber: "text-amber-500",
    sky: "text-sky-500",
    violet: "text-violet-500",
    red: "text-red-500",
    muted: "text-muted-foreground",
  }[outcome.tone];

  const chipClass = {
    emerald: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    amber: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    sky: "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400",
    violet: "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400",
    red: "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400",
    muted: "border-border bg-muted/40 text-muted-foreground",
  }[outcome.tone];

  const Wrapper = link
    ? ({ children }: { children: React.ReactNode }) => (
        <Link to={link} className="block hover:bg-accent/40 transition-colors no-underline text-inherit">
          {children}
        </Link>
      )
    : ({ children }: { children: React.ReactNode }) => <div>{children}</div>;

  return (
    <Wrapper>
      <div className="grid grid-cols-[64px_18px_1fr_auto] gap-3 items-center px-4 py-2.5">
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {new Date(event.createdAt).toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
        <AlertCircle className={cn("h-4 w-4", toneClass)} />
        <div className="min-w-0">
          <div className="text-sm truncate">
            <span className="font-medium">{outcome.verb}</span>
            {outcome.target && (
              <span className="text-muted-foreground"> {outcome.target}</span>
            )}
          </div>
          {actorName && (
            <div className="mt-0.5 text-[11px] text-muted-foreground flex items-center gap-1.5">
              <Identity name={actorName} size="xs" />
              <span>·</span>
              <span>{event.entityType}</span>
            </div>
          )}
        </div>
        <span
          className={cn(
            "inline-flex items-center px-2 py-0.5 text-[10px] font-medium border whitespace-nowrap",
            chipClass,
          )}
        >
          {outcome.chip}
        </span>
      </div>
    </Wrapper>
  );
}
