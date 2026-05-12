import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "@/lib/router";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Sun,
  Sunrise,
  Moon,
  Sparkles,
  CheckCircle2,
  ListChecks,
  Pencil,
  Mail,
} from "lucide-react";
import type { ActivityEvent, Approval, Company, DashboardSummary, Issue, IssueDocument } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { dashboardApi } from "../api/dashboard";
import { activityApi } from "../api/activity";
import { approvalsApi } from "../api/approvals";
import { issuesApi } from "../api/issues";
import { authApi } from "../api/auth";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { StatusIcon } from "../components/StatusIcon";
import { approvalLabel, typeIcon, defaultTypeIcon } from "../components/ApprovalPayload";
import { timeAgo } from "../lib/timeAgo";
import { cn, formatCents } from "../lib/utils";
import { summarizeOutcome, isOutcomeAction } from "../lib/outcomes";
import {
  dismissReviewSender,
  headerMatchesSender,
  parseReviewQueue,
} from "../lib/email-triage-rules";
import { useEmailToolsPlugin } from "../hooks/useEmailToolsPlugin";
import { makeEmailToolsApi, type MailHeader } from "../api/emailTools";
import { pluginsApi } from "../api/plugins";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const OVERNIGHT_HOURS = 14;
const OUTCOMES_LIMIT = 400;
const OUTCOMES_PER_COMPANY = 5;
const DRAFTS_PER_COMPANY = 4;
const ISSUES_PER_COMPANY = 3;
const REVIEW_QUEUE_PER_COMPANY = 5;
const RULES_HOME_TITLE_PREFIX = "Email triage rules - ";
const RULES_HOME_DOC_KEY = "email-triage-rules";

interface ReviewQueueRow {
  sender: string;
  count: number;
  mailbox: string;
  rulesIssueId: string;
  companyId: string;
}

interface RulesHomeBundle {
  issueId: string;
  companyId: string;
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

interface CompanyBucket<T> {
  company: Company;
  items: T[];
  total: number;
}

function groupByCompany<T extends { companyId: string }>(
  items: T[],
  companies: Company[],
): CompanyBucket<T>[] {
  const map = new Map<string, T[]>();
  for (const c of companies) map.set(c.id, []);
  for (const item of items) {
    const list = map.get(item.companyId);
    if (list) list.push(item);
  }
  return companies
    .map((company) => {
      const all = map.get(company.id) ?? [];
      return { company, items: all, total: all.length };
    })
    .filter((b) => b.total > 0);
}

export function PortfolioBrief() {
  const { selectedCompanyId, selectedCompany, setSelectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Portfolio Brief" }]);
  }, [setBreadcrumbs]);

  const isPortfolioRoot = selectedCompany?.isPortfolioRoot ?? false;

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  const { data: dashboardData, isLoading: dashLoading } = useQuery({
    queryKey: ["portfolio-dashboard", selectedCompanyId],
    queryFn: () => dashboardApi.listPortfolio(selectedCompanyId!),
    enabled: !!selectedCompanyId && isPortfolioRoot,
  });

  const { data: activityData } = useQuery({
    queryKey: ["portfolio-activity", "brief", selectedCompanyId, OUTCOMES_LIMIT],
    queryFn: () =>
      activityApi.listPortfolio(selectedCompanyId!, { limit: OUTCOMES_LIMIT }),
    enabled: !!selectedCompanyId && isPortfolioRoot,
  });

  const { data: approvalsData } = useQuery({
    queryKey: ["portfolio-approvals", "brief", selectedCompanyId, "pending"],
    queryFn: () =>
      approvalsApi.listPortfolio(selectedCompanyId!, { status: "pending" }),
    enabled: !!selectedCompanyId && isPortfolioRoot,
  });

  const { data: issuesData } = useQuery({
    queryKey: ["portfolio-issues", "brief", selectedCompanyId],
    queryFn: () =>
      issuesApi.listPortfolio(selectedCompanyId!, {
        statuses: ["todo", "in_progress", "in_review", "blocked"],
      }),
    enabled: !!selectedCompanyId && isPortfolioRoot,
  });

  const { data: rulesData } = useQuery<{ bundles: RulesHomeBundle[]; companies: Company[] }>({
    queryKey: ["portfolioBrief", "emailTriageRules", selectedCompanyId],
    enabled: !!selectedCompanyId && isPortfolioRoot,
    queryFn: async () => {
      const result = await issuesApi.listPortfolio(selectedCompanyId!, {
        q: RULES_HOME_TITLE_PREFIX,
        limit: 200,
      });
      const rulesIssues = result.issues.filter((i) =>
        i.title.startsWith(RULES_HOME_TITLE_PREFIX),
      );
      const docs = await Promise.allSettled(
        rulesIssues.map(async (issue) => {
          const doc: IssueDocument = await issuesApi.getDocument(issue.id, RULES_HOME_DOC_KEY);
          return {
            issueId: issue.id,
            companyId: issue.companyId,
            mailbox: issue.title.slice(RULES_HOME_TITLE_PREFIX.length).trim(),
            title: issue.title,
            body: doc?.body ?? "",
            latestRevisionId: doc?.latestRevisionId ?? null,
          } satisfies RulesHomeBundle;
        }),
      );
      return {
        bundles: docs
          .filter((r): r is PromiseFulfilledResult<RulesHomeBundle> => r.status === "fulfilled")
          .map((r) => r.value),
        companies: result.companies,
      };
    },
  });

  const queryClient = useQueryClient();
  const [pendingRowAction, setPendingRowAction] = useState<string | null>(null);
  const [reviewQueueExpanded, setReviewQueueExpanded] = useState<Record<string, boolean>>({});

  // Portfolio-wide view — rows can belong to any company. Use the bridge
  // directly with each row's companyId rather than a per-company emailApi.
  const { pluginId: emailPluginId } = useEmailToolsPlugin(selectedCompanyId);
  async function writeRuleToDb(
    rowCompanyId: string,
    mailbox: string,
    sender: string,
    ruleType: "auto-triage" | "keep-always",
  ): Promise<void> {
    if (!emailPluginId) return;
    await pluginsApi.bridgePerformAction(
      emailPluginId,
      "email.set-rule",
      { companyId: rowCompanyId, mailbox, senderPattern: sender, ruleType },
      rowCompanyId,
    );
  }

  const overnightCutoff = useMemo(() => {
    const d = new Date();
    d.setHours(d.getHours() - OVERNIGHT_HOURS);
    return d;
  }, []);

  // Merge the company list across all sources so a company shows up
  // even if only one signal (a draft, an outcome, an issue, an email sender) is present.
  const companyMap = useMemo(() => {
    const map = new Map<string, Company>();
    for (const c of dashboardData?.companies ?? []) map.set(c.id, c);
    for (const c of activityData?.companies ?? []) map.set(c.id, c);
    for (const c of approvalsData?.companies ?? []) map.set(c.id, c);
    for (const c of issuesData?.companies ?? []) map.set(c.id, c);
    for (const c of rulesData?.companies ?? []) map.set(c.id, c);
    return map;
  }, [dashboardData, activityData, approvalsData, issuesData, rulesData]);

  const companies = useMemo(() => {
    return Array.from(companyMap.values())
      .filter((c) => !c.isPortfolioRoot && c.status !== "archived")
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [companyMap]);

  const summariesByCompanyId = useMemo(() => {
    const map = new Map<string, DashboardSummary>();
    for (const s of dashboardData?.summaries ?? []) {
      const sourceCompanyId = (s as DashboardSummary & { companyId?: string }).companyId;
      if (sourceCompanyId) map.set(sourceCompanyId, s);
    }
    return map;
  }, [dashboardData]);

  // Outcomes: filter to overnight + outcome-shaped, then bucket by company.
  const outcomeBuckets: CompanyBucket<ActivityEvent>[] = useMemo(() => {
    const events = activityData?.events ?? [];
    const overnight = events
      .filter((e) => isOutcomeAction(e.action))
      .filter((e) => new Date(e.createdAt).getTime() >= overnightCutoff.getTime());
    return groupByCompany(overnight, companies);
  }, [activityData, companies, overnightCutoff]);

  const draftBuckets: CompanyBucket<Approval>[] = useMemo(() => {
    return groupByCompany(approvalsData?.approvals ?? [], companies);
  }, [approvalsData, companies]);

  const myUserId = session?.user?.id ?? null;
  const issueBuckets: CompanyBucket<Issue>[] = useMemo(() => {
    const issues = (issuesData?.issues ?? []).filter((i) =>
      myUserId ? i.assigneeUserId === myUserId : true,
    );
    return groupByCompany(issues, companies).map((bucket) => ({
      ...bucket,
      items: bucket.items.slice(0, ISSUES_PER_COMPANY),
    }));
  }, [issuesData, companies, myUserId]);

  const reviewQueueRows: ReviewQueueRow[] = useMemo(() => {
    if (!rulesData?.bundles) return [];
    const rows: ReviewQueueRow[] = [];
    for (const bundle of rulesData.bundles) {
      const entries = parseReviewQueue(bundle.body);
      for (const e of entries) {
        rows.push({
          sender: e.sender,
          count: e.count,
          mailbox: bundle.mailbox,
          rulesIssueId: bundle.issueId,
          companyId: bundle.companyId,
        });
      }
    }
    return rows.sort((a, b) => b.count - a.count);
  }, [rulesData]);

  const reviewQueueBuckets: CompanyBucket<ReviewQueueRow>[] = useMemo(() => {
    return groupByCompany(reviewQueueRows, companies);
  }, [reviewQueueRows, companies]);

  // For preview fetching, group by (companyId, mailbox) — the email plugin
  // call needs both. Two companies can share a mailbox name pointing to
  // different accounts, so the company is part of the cache key.
  const uniqueReviewMailboxes = useMemo(() => {
    const seen = new Set<string>();
    const out: { companyId: string; mailbox: string }[] = [];
    for (const row of reviewQueueRows) {
      const key = `${row.companyId}::${row.mailbox}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ companyId: row.companyId, mailbox: row.mailbox });
    }
    return out;
  }, [reviewQueueRows]);

  const previewMessageQueries = useQueries({
    queries: uniqueReviewMailboxes.map(({ companyId, mailbox }) => ({
      queryKey: [
        "portfolioBrief",
        "reviewQueuePreview",
        emailPluginId,
        companyId,
        mailbox,
      ],
      queryFn: () => {
        const api = makeEmailToolsApi(emailPluginId!, companyId);
        return api.listMessages(mailbox, { limit: 200 });
      },
      enabled: !!emailPluginId,
      staleTime: 60_000,
    })),
  });

  const { reviewPreviewLookup, reviewMatchedUidsLookup } = useMemo(() => {
    const headerMap = new Map<string, MailHeader>();
    const uidsMap = new Map<string, number[]>();
    uniqueReviewMailboxes.forEach(({ companyId, mailbox }, idx) => {
      const messages = previewMessageQueries[idx]?.data?.messages ?? [];
      const rowsForBucket = reviewQueueRows.filter(
        (r) => r.companyId === companyId && r.mailbox === mailbox,
      );
      for (const row of rowsForBucket) {
        const matches = messages.filter((m) => headerMatchesSender(m, row.sender));
        if (matches.length === 0) continue;
        matches.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        const key = `${companyId}::${mailbox}::${row.sender}`;
        headerMap.set(key, matches[0]!);
        uidsMap.set(key, matches.map((m) => m.uid));
      }
    });
    return { reviewPreviewLookup: headerMap, reviewMatchedUidsLookup: uidsMap };
  }, [uniqueReviewMailboxes, previewMessageQueries, reviewQueueRows]);

  const [hoveredPreviewKey, setHoveredPreviewKey] = useState<string | null>(null);
  const hoveredHeader = hoveredPreviewKey
    ? reviewPreviewLookup.get(hoveredPreviewKey) ?? null
    : null;
  const hoveredParts = hoveredPreviewKey ? hoveredPreviewKey.split("::") : null;
  const hoveredCompanyId = hoveredParts?.[0] ?? null;
  const hoveredMailbox = hoveredParts?.[1] ?? null;

  const { data: hoveredFullMessage } = useQuery({
    queryKey: [
      "portfolioBrief",
      "reviewQueueFullMessage",
      emailPluginId,
      hoveredCompanyId,
      hoveredMailbox,
      hoveredHeader?.uid,
    ],
    queryFn: () => {
      const api = makeEmailToolsApi(emailPluginId!, hoveredCompanyId!);
      return api.fetchMessage(hoveredMailbox!, hoveredHeader!.uid);
    },
    enabled:
      !!emailPluginId && !!hoveredCompanyId && !!hoveredMailbox && !!hoveredHeader,
    staleTime: 10 * 60_000,
  });

  async function markRowUidsRead(row: ReviewQueueRow) {
    if (!emailPluginId) return;
    const uids =
      reviewMatchedUidsLookup.get(`${row.companyId}::${row.mailbox}::${row.sender}`) ??
      [];
    if (uids.length === 0) return;
    const api = makeEmailToolsApi(emailPluginId, row.companyId);
    await Promise.allSettled(
      uids.map((uid) => api.markRead(row.mailbox, uid, "INBOX")),
    );
  }

  async function applyReviewTransform(
    row: ReviewQueueRow,
    transform: (body: string, sender: string) => string,
  ) {
    const bundle = rulesData?.bundles.find((b) => b.issueId === row.rulesIssueId);
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

  const reviewMutationOptions = {
    onMutate: (row: ReviewQueueRow) =>
      setPendingRowAction(`${row.rulesIssueId}::${row.sender}`),
    onSettled: () => setPendingRowAction(null),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["portfolioBrief", "emailTriageRules", selectedCompanyId],
      });
    },
  };

  const graduateMutation = useMutation({
    mutationFn: async (row: ReviewQueueRow) => {
      // DB is the source of truth for sender rules. The Markdown's rule
      // sections are no longer written — the agent reads rules from the DB
      // via email_list_rules. We still remove the row from the Markdown's
      // Review queue section so it doesn't keep appearing.
      await writeRuleToDb(row.companyId, row.mailbox, row.sender, "auto-triage");
      await applyReviewTransform(row, dismissReviewSender);
    },
    ...reviewMutationOptions,
  });
  const keepUnreadMutation = useMutation({
    mutationFn: async (row: ReviewQueueRow) => {
      await writeRuleToDb(row.companyId, row.mailbox, row.sender, "keep-always");
      await applyReviewTransform(row, dismissReviewSender);
    },
    ...reviewMutationOptions,
  });
  const keepReadMutation = useMutation({
    mutationFn: async (row: ReviewQueueRow) => {
      await writeRuleToDb(row.companyId, row.mailbox, row.sender, "keep-always");
      await markRowUidsRead(row);
      await applyReviewTransform(row, dismissReviewSender);
    },
    ...reviewMutationOptions,
  });
  const dismissMutation = useMutation({
    mutationFn: (row: ReviewQueueRow) => applyReviewTransform(row, dismissReviewSender),
    ...reviewMutationOptions,
  });
  const lastReviewError =
    graduateMutation.error ??
    keepUnreadMutation.error ??
    keepReadMutation.error ??
    dismissMutation.error;

  if (!selectedCompanyId) {
    return <EmptyState icon={Sunrise} message="Select a company to view its brief." />;
  }
  if (!isPortfolioRoot) {
    return (
      <EmptyState
        icon={Sunrise}
        message="The Portfolio Brief is only available on the HQ (portfolio root) company."
      />
    );
  }
  if (dashLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  const now = new Date();
  const { word, icon: HeroIcon } = greeting(now);
  const userName =
    session?.user?.name?.split(" ")[0] ||
    session?.user?.email?.split("@")[0] ||
    "there";

  // Aggregate hero numbers across the portfolio (excluding HQ itself).
  const totals = (() => {
    let pendingApprovals = 0;
    let errors = 0;
    let runningAgents = 0;
    let monthSpendCents = 0;
    let activeIncidents = 0;
    for (const c of companies) {
      const s = summariesByCompanyId.get(c.id);
      if (!s) continue;
      pendingApprovals += s.pendingApprovals ?? 0;
      errors += s.agents?.error ?? 0;
      runningAgents += s.agents?.running ?? 0;
      monthSpendCents += s.costs?.monthSpendCents ?? 0;
      activeIncidents += s.budgets?.activeIncidents ?? 0;
    }
    return { pendingApprovals, errors, runningAgents, monthSpendCents, activeIncidents };
  })();

  const overnightTotal = outcomeBuckets.reduce((sum, b) => sum + b.total, 0);
  const draftsTotal = draftBuckets.reduce((sum, b) => sum + b.total, 0);
  const issuesTotal = issueBuckets.reduce((sum, b) => sum + b.total, 0);
  const reviewTotal = reviewQueueBuckets.reduce((sum, b) => sum + b.total, 0);

  const heroTone: "emerald" | "amber" | "red" =
    totals.errors > 0 || totals.activeIncidents > 0 ? "red" : draftsTotal > 0 ? "amber" : "emerald";
  const heroBarClass = {
    emerald: "bg-emerald-500/55",
    amber: "bg-amber-500/55",
    red: "bg-red-500/55",
  }[heroTone];

  const allClear = totals.errors === 0 && totals.activeIncidents === 0;

  return (
    <div className="space-y-8">
      {/* Hero */}
      <section
        aria-label="Portfolio brief"
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
              Across {companies.length} compan{companies.length === 1 ? "y" : "ies"} in your portfolio.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
              <span
                className={cn(
                  "inline-flex items-center gap-1.5",
                  allClear ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
                )}
              >
                <span
                  className={cn(
                    "inline-block h-1.5 w-1.5 rounded-full",
                    allClear ? "bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.18)]" : "bg-red-500 shadow-[0_0_0_3px_rgba(239,68,68,0.18)]",
                  )}
                />
                <span className="font-medium text-foreground">
                  {allClear
                    ? "All systems green."
                    : totals.errors > 0
                      ? `${totals.errors} agent error${totals.errors === 1 ? "" : "s"}.`
                      : `${totals.activeIncidents} budget incident${totals.activeIncidents === 1 ? "" : "s"}.`}
                </span>
              </span>
              <span className="text-muted-foreground">{overnightTotal} outcomes overnight</span>
              <span className="text-muted-foreground/60">·</span>
              <span className="text-muted-foreground">
                {draftsTotal} draft{draftsTotal === 1 ? "" : "s"} ready for you
              </span>
              <span className="text-muted-foreground/60">·</span>
              <span className="text-muted-foreground">
                {totals.runningAgents} agent{totals.runningAgents === 1 ? "" : "s"} running
              </span>
              <span className="text-muted-foreground/60">·</span>
              <span className="text-muted-foreground tabular-nums">
                {formatCents(totals.monthSpendCents)} this month
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Companies — per-company health grid (absorbed from Portfolio Dashboard) */}
      {companies.length > 0 && (
        <section aria-label="Companies">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Companies
            </h2>
            <span className="text-[11px] text-muted-foreground">
              {companies.length} compan{companies.length === 1 ? "y" : "ies"}
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {companies.map((company) => {
              const summary = summariesByCompanyId.get(company.id);
              if (!summary) return null;
              return (
                <CompanyHealthCard
                  key={company.id}
                  company={company}
                  summary={summary}
                  onSelect={() => {
                    setSelectedCompanyId(company.id, { source: "route_sync" });
                    navigate(`/${company.issuePrefix}/brief`);
                  }}
                />
              );
            })}
          </div>
        </section>
      )}

      {/* Awaiting your tap */}
      <section aria-label="Awaiting your tap">
        <div className="mb-3 flex items-baseline justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Awaiting your tap
            </h2>
            {draftsTotal > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 text-[11px] font-medium border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300">
                {draftsTotal} draft{draftsTotal === 1 ? "" : "s"}
              </span>
            )}
            {reviewTotal > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 text-[11px] font-medium border border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300">
                {reviewTotal} email sender{reviewTotal === 1 ? "" : "s"}
              </span>
            )}
          </div>
          {draftsTotal > 0 && (
            <Link
              to="/portfolio-approvals"
              className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
            >
              Open all approvals →
            </Link>
          )}
        </div>

        {draftsTotal === 0 && reviewTotal === 0 ? (
          <EmptySection
            icon={CheckCircle2}
            message="Nothing waiting on you across the portfolio."
            tone="emerald"
          />
        ) : (
          <div className="space-y-5">
            {draftsTotal > 0 && (
              <div>
                <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/80">
                  Drafts
                </h3>
                <div className="space-y-3">
                  {draftBuckets.map(({ company, items, total }) => (
                    <CompanyBlock
                      key={company.id}
                      company={company}
                      total={total}
                      spent={summariesByCompanyId.get(company.id)?.costs?.monthSpendCents}
                    >
                      {items.slice(0, DRAFTS_PER_COMPANY).map((approval) => (
                        <DraftRow key={approval.id} approval={approval} company={company} />
                      ))}
                      {total > DRAFTS_PER_COMPANY && (
                        <Link
                          to={`/${company.issuePrefix}/approvals/pending`}
                          className="block px-4 py-2 text-center text-[12px] text-muted-foreground hover:bg-accent/40 hover:text-foreground border-t border-border"
                        >
                          + {total - DRAFTS_PER_COMPANY} more in {company.name} →
                        </Link>
                      )}
                    </CompanyBlock>
                  ))}
                </div>
              </div>
            )}

            {reviewTotal > 0 && (
              <div>
                <div className="mb-1.5 flex items-baseline justify-between">
                  <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/80">
                    Email senders awaiting your call
                  </h3>
                  <span className="text-[11px] text-muted-foreground">
                    Hover for preview, click for full email · Auto-triage = move + rule · Keep · read/unread = leave in INBOX + rule · Dismiss = no rule
                  </span>
                </div>
                <div className="space-y-3">
                  {reviewQueueBuckets.map(({ company, items, total }) => {
                    const expanded = reviewQueueExpanded[company.id] ?? false;
                    const visible = expanded ? items : items.slice(0, REVIEW_QUEUE_PER_COMPANY);
                    return (
                      <CompanyBlock key={company.id} company={company} total={total}>
                        {visible.map((row) => {
                          const key = `${row.rulesIssueId}::${row.sender}`;
                          const previewKey = `${row.companyId}::${row.mailbox}::${row.sender}`;
                          const isPending = pendingRowAction === key;
                          const preview = reviewPreviewLookup.get(previewKey) ?? null;
                          const isHovered = hoveredPreviewKey === previewKey;
                          return (
                            <ReviewQueueRow
                              key={key}
                              row={row}
                              company={company}
                              pending={isPending}
                              preview={preview}
                              fullBodyText={isHovered ? hoveredFullMessage?.text ?? null : null}
                              fullBodyLoading={isHovered && !!preview && !hoveredFullMessage}
                              onHoverChange={(entered) => {
                                if (entered) setHoveredPreviewKey(previewKey);
                                else setHoveredPreviewKey((cur) => (cur === previewKey ? null : cur));
                              }}
                              onGraduate={() => graduateMutation.mutate(row)}
                              onKeepRead={() => keepReadMutation.mutate(row)}
                              onKeepUnread={() => keepUnreadMutation.mutate(row)}
                              onDismiss={() => dismissMutation.mutate(row)}
                            />
                          );
                        })}
                        {total > REVIEW_QUEUE_PER_COMPANY && (
                          <button
                            type="button"
                            onClick={() =>
                              setReviewQueueExpanded((current) => ({
                                ...current,
                                [company.id]: !expanded,
                              }))
                            }
                            className="block w-full px-4 py-2 text-center text-[12px] text-muted-foreground hover:bg-accent/40 hover:text-foreground border-t border-border transition-colors"
                          >
                            {expanded
                              ? "Show fewer"
                              : `+ ${total - REVIEW_QUEUE_PER_COMPANY} more in ${company.name} — show all`}
                          </button>
                        )}
                      </CompanyBlock>
                    );
                  })}
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

      {/* Overnight outcomes */}
      <section aria-label="Overnight outcomes">
        <SectionHeader
          label="Overnight outcomes"
          chip={
            overnightTotal > 0
              ? { text: `${overnightTotal} done`, tone: "emerald" }
              : null
          }
          right={{ label: "View receipts →", to: "/portfolio-receipts" }}
        />
        {overnightTotal === 0 ? (
          <EmptySection
            icon={Sparkles}
            message={`No outcomes across the portfolio in the last ${OVERNIGHT_HOURS} hours yet.`}
          />
        ) : (
          <div className="space-y-3">
            {outcomeBuckets.map(({ company, items, total }) => (
              <CompanyBlock
                key={company.id}
                company={company}
                total={total}
                spent={summariesByCompanyId.get(company.id)?.costs?.monthSpendCents}
              >
                {items.slice(0, OUTCOMES_PER_COMPANY).map((event) => (
                  <OutcomeRow key={event.id} event={event} company={company} />
                ))}
                {total > OUTCOMES_PER_COMPANY && (
                  <Link
                    to={`/${company.issuePrefix}/receipts`}
                    className="block px-4 py-2 text-center text-[12px] text-muted-foreground hover:bg-accent/40 hover:text-foreground border-t border-border"
                  >
                    + {total - OUTCOMES_PER_COMPANY} more in {company.name} →
                  </Link>
                )}
              </CompanyBlock>
            ))}
          </div>
        )}
      </section>

      {/* Today */}
      <section aria-label="Today">
        <SectionHeader
          label="Today"
          chip={{ text: now.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }) }}
          right={
            issuesTotal > 0
              ? { label: "All portfolio issues →", to: "/portfolio-issues" }
              : null
          }
        />
        {issuesTotal === 0 ? (
          <EmptySection
            icon={ListChecks}
            message="No issues across the portfolio need your attention today."
          />
        ) : (
          <div className="space-y-3">
            {issueBuckets.map(({ company, items, total }) => (
              <CompanyBlock key={company.id} company={company} total={total}>
                {items.map((issue) => (
                  <Link
                    key={issue.id}
                    to={`/${company.issuePrefix}/issues/${issue.identifier ?? issue.id}`}
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
              </CompanyBlock>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

interface SectionHeaderProps {
  label: string;
  chip?: { text: string; tone?: "amber" | "emerald" } | null;
  right?: { label: string; to: string } | null;
}

function SectionHeader({ label, chip, right }: SectionHeaderProps) {
  const chipClass = chip?.tone === "amber"
    ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
    : chip?.tone === "emerald"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : "border-border bg-muted/40 text-muted-foreground";
  return (
    <div className="mb-3 flex items-baseline justify-between">
      <div className="flex items-center gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {label}
        </h2>
        {chip && (
          <span className={cn("inline-flex items-center px-2 py-0.5 text-[11px] font-medium border", chipClass)}>
            {chip.text}
          </span>
        )}
      </div>
      {right && (
        <Link to={right.to} className="text-[11px] font-medium text-muted-foreground hover:text-foreground">
          {right.label}
        </Link>
      )}
    </div>
  );
}

function EmptySection({ icon: Icon, message, tone }: { icon: typeof Sun; message: string; tone?: "emerald" }) {
  return (
    <div className="border border-border bg-card p-8 text-center">
      <Icon className={cn("mx-auto h-5 w-5", tone === "emerald" ? "text-emerald-500/70" : "text-muted-foreground/40")} />
      <p className="mt-3 text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

interface CompanyBlockProps {
  company: Company;
  total: number;
  spent?: number | null;
  children: React.ReactNode;
}

function CompanyBlock({ company, total, spent, children }: CompanyBlockProps) {
  return (
    <div className="border border-border bg-card overflow-hidden">
      <div className="px-4 py-2 flex items-center justify-between border-b border-border bg-muted/20">
        <Link
          to={`/${company.issuePrefix}/brief`}
          className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground no-underline"
        >
          <CompanyPatternIcon
            companyName={company.name}
            logoUrl={company.logoUrl}
            brandColor={company.brandColor}
            className="h-4 w-4 shrink-0 rounded-[2px]"
          />
          <span>{company.name}</span>
        </Link>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {total} item{total === 1 ? "" : "s"}
          {typeof spent === "number" && spent > 0 ? ` · ${formatCents(spent)} MTD` : ""}
        </span>
      </div>
      <div className="divide-y divide-border">{children}</div>
    </div>
  );
}

interface ReviewQueueRowProps {
  row: ReviewQueueRow;
  company: Company;
  pending: boolean;
  preview: MailHeader | null;
  fullBodyText: string | null;
  fullBodyLoading: boolean;
  onHoverChange: (entered: boolean) => void;
  onGraduate: () => void;
  onKeepRead: () => void;
  onKeepUnread: () => void;
  onDismiss: () => void;
}

const PREVIEW_BODY_CHARS = 700;

function truncateBody(text: string, max: number): { text: string; truncated: boolean } {
  const collapsed = text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (collapsed.length <= max) return { text: collapsed, truncated: false };
  return { text: collapsed.slice(0, max).trimEnd() + "…", truncated: true };
}

function ReviewQueueRow({
  row,
  company,
  pending,
  preview,
  fullBodyText,
  fullBodyLoading,
  onHoverChange,
  onGraduate,
  onKeepRead,
  onKeepUnread,
  onDismiss,
}: ReviewQueueRowProps) {
  const subjectLine = preview?.subject?.trim() || "";
  const snippet = preview?.snippet?.trim() || "";
  const fullBody = fullBodyText ? truncateBody(fullBodyText, PREVIEW_BODY_CHARS) : null;
  const baseEmailPath = `/${company.issuePrefix}/email`;
  const messageHref = preview
    ? `${baseEmailPath}?mailbox=${encodeURIComponent(row.mailbox)}&folder=INBOX&uid=${preview.uid}&all=1`
    : `${baseEmailPath}?mailbox=${encodeURIComponent(row.mailbox)}&folder=INBOX&all=1`;

  return (
    <div
      className="group relative pl-5 pr-4 py-3"
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
    >
      <span aria-hidden className="absolute left-0 top-0 h-full w-[3px] bg-sky-500/55 group-hover:bg-sky-500/80 transition-colors" />
      <div className="flex items-start gap-3">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-muted/40 shrink-0">
          <Mail className="h-3.5 w-3.5 text-muted-foreground" />
        </span>
        <div className="flex-1 min-w-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                to={messageHref}
                title={preview ? "Open this email" : "Open this mailbox (no recent message found in INBOX)"}
                className="block group/link cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500/40 rounded-sm"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="font-mono text-[13px] truncate group-hover/link:underline">
                    {row.sender}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    · {row.count} message{row.count === 1 ? "" : "s"}
                  </span>
                  <span className="text-[11px] text-muted-foreground/70">· {row.mailbox} mailbox</span>
                </div>
                <div className="mt-0.5 text-[12px] text-muted-foreground truncate">
                  {preview ? (
                    subjectLine || <span className="italic">(no subject)</span>
                  ) : (
                    <span className="italic opacity-60">No recent message in INBOX — click to open mailbox</span>
                  )}
                </div>
              </Link>
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              align="start"
              className="max-w-lg p-3 text-left whitespace-normal"
            >
              {preview ? (
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
                    {timeAgo(preview.date)} · latest of {row.count} message{row.count === 1 ? "" : "s"} · click to open
                  </div>
                </div>
              ) : (
                <div className="space-y-1 text-[12px]">
                  <div className="font-medium">No recent message preview</div>
                  <div className="opacity-70">
                    Couldn't find a recent message from{" "}
                    <span className="font-mono">{row.sender}</span> in the last 200 INBOX messages.
                  </div>
                  <div className="opacity-70">
                    <span className="underline-offset-2 group-hover:underline">click to open mailbox</span>
                  </div>
                </div>
              )}
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={onGraduate}
            disabled={pending}
            title="Write an auto-triage rule and move every message from this sender (now and going forward) to _paperclip/triage."
            className="px-2.5 py-1 text-[11px] font-medium border border-border bg-foreground text-background hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Auto-triage
          </button>
          <button
            type="button"
            onClick={onKeepRead}
            disabled={pending}
            title="Keep this sender in INBOX going forward AND mark the existing messages as read."
            className="px-2.5 py-1 text-[11px] font-medium border border-border bg-background text-foreground hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Keep · read
          </button>
          <button
            type="button"
            onClick={onKeepUnread}
            disabled={pending}
            title="Keep this sender in INBOX going forward and leave existing messages unread."
            className="px-2.5 py-1 text-[11px] font-medium border border-border bg-background text-foreground hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Keep · unread
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
  company: Company;
}

function DraftRow({ approval, company }: DraftRowProps) {
  const Icon = typeIcon[approval.type] ?? defaultTypeIcon;
  const label = approvalLabel(approval.type, approval.payload);
  const isOutboundDraft = approval.type === "outbound_tool_draft";
  return (
    <div className="group relative pl-5 pr-4 py-3">
      <span aria-hidden className="absolute left-0 top-0 h-full w-[3px] bg-amber-500/55" />
      <div className="flex items-start gap-3">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-muted/40 shrink-0">
          {isOutboundDraft ? (
            <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <Icon className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </span>
        <div className="flex-1 min-w-0">
          <Link
            to={`/${company.issuePrefix}/approvals/${approval.id}`}
            className="font-medium hover:underline truncate block"
          >
            {label}
          </Link>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {timeAgo(approval.createdAt)}
          </p>
        </div>
        <Link
          to={`/${company.issuePrefix}/approvals/${approval.id}`}
          className="px-2.5 py-1 text-[11px] font-medium border border-border bg-foreground text-background hover:opacity-90 no-underline shrink-0"
        >
          Review
        </Link>
      </div>
    </div>
  );
}

interface OutcomeRowProps {
  event: ActivityEvent;
  company: Company;
}

function OutcomeRow({ event, company }: OutcomeRowProps) {
  const outcome = summarizeOutcome(event);
  const link =
    event.entityType === "issue"
      ? `/${company.issuePrefix}/issues/${event.entityId}`
      : event.entityType === "approval"
        ? `/${company.issuePrefix}/approvals/${event.entityId}`
        : event.entityType === "agent"
          ? `/${company.issuePrefix}/agents/${event.entityId}`
          : null;

  const chipClass = {
    emerald: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    amber: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    sky: "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400",
    violet: "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400",
    red: "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400",
    muted: "border-border bg-muted/40 text-muted-foreground",
  }[outcome.tone];

  const time = new Date(event.createdAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

  const inner = (
    <div className="grid grid-cols-[64px_1fr_auto] gap-3 items-center px-4 py-2.5 text-sm">
      <span className="text-[11px] tabular-nums text-muted-foreground">{time}</span>
      <div className="min-w-0 truncate">
        <span className="font-medium">{outcome.verb}</span>
        {outcome.target && <span className="text-muted-foreground"> {outcome.target}</span>}
      </div>
      <span className={cn("inline-flex items-center px-2 py-0.5 text-[10px] font-medium border whitespace-nowrap", chipClass)}>
        {outcome.chip}
      </span>
    </div>
  );

  return link ? (
    <Link to={link} className="block hover:bg-accent/40 transition-colors no-underline text-inherit">
      {inner}
    </Link>
  ) : (
    <div>{inner}</div>
  );
}

interface CompanyHealthCardProps {
  company: Company;
  summary: DashboardSummary;
  onSelect: () => void;
}

function CompanyHealthCard({ company, summary, onSelect }: CompanyHealthCardProps) {
  const spendPct = summary.costs.monthUtilizationPercent ?? 0;
  const hasError = summary.agents.error > 0;
  const hasPending = summary.pendingApprovals > 0;

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSelect();
      }}
      className="block rounded-lg border border-border bg-card hover:border-primary/40 hover:shadow-sm transition-all p-4 group cursor-pointer"
    >
      <div className="flex items-center gap-2 mb-3">
        <CompanyPatternIcon
          companyName={company.name}
          logoUrl={company.logoUrl}
          brandColor={company.brandColor}
          className="h-6 w-6 shrink-0 rounded-[4px]"
        />
        <span className="font-semibold text-sm truncate group-hover:text-primary transition-colors">
          {company.name}
        </span>
        {(hasError || hasPending) && (
          <span className="ml-auto h-2 w-2 rounded-full bg-red-400 shrink-0" />
        )}
      </div>

      <div className="flex items-center gap-3 mb-2 text-sm">
        <span className="text-[10px] font-medium uppercase text-muted-foreground w-14 shrink-0">Agents</span>
        <div className="flex items-center gap-2 flex-wrap">
          <HealthStat label="running" value={summary.agents.running} />
          <HealthStat label="active" value={summary.agents.active} />
          <HealthStat label="paused" value={summary.agents.paused} tone={summary.agents.paused > 0 ? "warn" : undefined} />
          <HealthStat label="error" value={summary.agents.error} tone={summary.agents.error > 0 ? "danger" : undefined} />
        </div>
      </div>

      <div className="flex items-center gap-3 mb-2 text-sm">
        <span className="text-[10px] font-medium uppercase text-muted-foreground w-14 shrink-0">Issues</span>
        <div className="flex items-center gap-2 flex-wrap">
          <HealthStat label="open" value={summary.tasks.open} />
          <HealthStat label="active" value={summary.tasks.inProgress} />
          <HealthStat label="blocked" value={summary.tasks.blocked} tone={summary.tasks.blocked > 0 ? "warn" : undefined} />
        </div>
      </div>

      <div className="flex items-center justify-between mt-3 pt-3 border-t border-border/50 text-xs text-muted-foreground">
        <span>
          <span className="font-semibold text-foreground tabular-nums">
            {formatCents(summary.costs.monthSpendCents)}
          </span>
          {summary.costs.monthBudgetCents > 0 && (
            <span className={cn("ml-1", spendPct >= 90 ? "text-red-500" : spendPct >= 70 ? "text-yellow-500" : "")}>
              / {formatCents(summary.costs.monthBudgetCents)} ({spendPct.toFixed(0)}%)
            </span>
          )}
          {" MTD"}
        </span>
        {summary.pendingApprovals > 0 && (
          <span className="text-amber-500 font-medium">
            {summary.pendingApprovals} approval{summary.pendingApprovals !== 1 ? "s" : ""} pending
          </span>
        )}
      </div>
    </div>
  );
}

function HealthStat({ label, value, tone }: { label: string; value: number; tone?: "danger" | "warn" }) {
  const color =
    tone === "danger"
      ? "text-red-500"
      : tone === "warn"
        ? "text-yellow-500"
        : "text-muted-foreground";
  return (
    <span className="flex items-center gap-0.5">
      <span className={cn("font-semibold tabular-nums", color, value === 0 && "text-muted-foreground/50")}>
        {value}
      </span>
      <span className="text-[10px] text-muted-foreground">{label}</span>
    </span>
  );
}
