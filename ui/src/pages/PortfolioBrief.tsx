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
  Bot,
} from "lucide-react";
import type { ActivityEvent, Approval, Company, DashboardSummary, Issue, IssueDocument } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { dashboardApi } from "../api/dashboard";
import { activityApi } from "../api/activity";
import { approvalsApi } from "../api/approvals";
import { issuesApi } from "../api/issues";
import { authApi } from "../api/auth";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { AgentRunCard, DASHBOARD_AGENT_RUN_CONFIG, isRunActive } from "../components/ActiveAgentsPanel";
import { useLiveRunTranscripts } from "../components/transcript/useLiveRunTranscripts";
import type { TranscriptEntry } from "../adapters";
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
  extractEmailAddress,
} from "../lib/email-triage-rules";
import { useEmailToolsPlugin } from "../hooks/useEmailToolsPlugin";
import { makeEmailToolsApi, type MailHeader } from "../api/emailTools";
import { pluginsApi } from "../api/plugins";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCompanyOrder } from "../hooks/useCompanyOrder";
import { SortableSections, type SortableSection } from "../components/SortableSections";

const OVERNIGHT_HOURS = 14;
const OUTCOMES_LIMIT = 400;
const OUTCOMES_PER_COMPANY = 5;
const DRAFTS_PER_COMPANY = 4;
const ISSUES_PER_COMPANY = 3;
const REVIEW_QUEUE_PER_COMPANY = 5;
const AGENT_RUNS_PER_COMPANY = 4;
const EMPTY_TRANSCRIPT: TranscriptEntry[] = [];
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
  const {
    selectedCompanyId,
    selectedCompany,
    setSelectedCompanyId,
    companies: allAccessibleCompanies,
  } = useCompany();
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

  // The rules-home issue can live in a different company than the mailbox
  // is `allowedCompanies`-listed under (e.g. M3 Media owns the rules issue
  // but the m3-barry mailbox is only allowed for Personal). Building the
  // /email link from the rules-home company sends the operator to a page
  // that says "Email not configured". Resolve a company that IS in the
  // mailbox's allow-list so the link actually opens the message.
  const { data: emailConfig } = useQuery({
    queryKey: queryKeys.plugins.config(emailPluginId ?? ""),
    queryFn: () => pluginsApi.getConfig(emailPluginId!),
    enabled: !!emailPluginId,
    staleTime: 60_000,
  });
  const mailboxAllowedCompanyByKey = useMemo(() => {
    const map = new Map<string, Company>();
    const list = ((emailConfig?.configJson?.mailboxes ?? []) as Array<{
      key?: string;
      allowedCompanies?: string[];
    }>);
    const companyIndex = new Map(allAccessibleCompanies.map((c) => [c.id, c] as const));
    for (const mb of list) {
      if (!mb.key) continue;
      const allowed = mb.allowedCompanies ?? [];
      let resolved: Company | null = null;
      if (allowed.includes("*") && selectedCompany) {
        resolved = selectedCompany;
      } else {
        for (const id of allowed) {
          const c = companyIndex.get(id);
          if (c) {
            resolved = c;
            break;
          }
        }
      }
      if (resolved) map.set(mb.key, resolved);
    }
    return map;
  }, [emailConfig, allAccessibleCompanies, selectedCompany]);
  async function writeRuleToDb(
    rowCompanyId: string,
    mailbox: string,
    sender: string,
    ruleType: "auto-triage" | "keep-always" | "mute",
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

  // Filter out HQ + archived; the *order* is owned by the sidebar's per-user
  // preference (useCompanyOrder), so the Brief grid matches the sidebar
  // automatically. Falls back to the natural map order when the user hasn't
  // dragged anything yet.
  const filteredCompanies = useMemo(() => {
    return Array.from(companyMap.values())
      .filter((c) => !c.isPortfolioRoot && c.status !== "archived");
  }, [companyMap]);
  const currentUserId = session?.user?.id ?? null;
  const { orderedCompanies: companies } = useCompanyOrder({
    companies: filteredCompanies,
    userId: currentUserId,
  });

  const summariesByCompanyId = useMemo(() => {
    const map = new Map<string, DashboardSummary>();
    for (const s of dashboardData?.summaries ?? []) {
      const sourceCompanyId = (s as DashboardSummary & { companyId?: string }).companyId;
      if (sourceCompanyId) map.set(sourceCompanyId, s);
    }
    return map;
  }, [dashboardData]);

  // Live agent runs across the portfolio — fan out one fetch per company so
  // each call goes through normal per-company access control. The HQ operator
  // is a member of every sub-company, so each request succeeds.
  const liveRunsQueries = useQueries({
    queries: companies.map((company) => ({
      queryKey: [
        ...queryKeys.liveRuns(company.id),
        "portfolio-brief",
        { minRunCount: AGENT_RUNS_PER_COMPANY },
      ],
      queryFn: () =>
        heartbeatsApi.liveRunsForCompany(company.id, {
          minCount: AGENT_RUNS_PER_COMPANY,
        }),
      enabled: isPortfolioRoot,
    })),
  });

  const liveRunsByCompany = useMemo(() => {
    const map = new Map<string, LiveRunForIssue[]>();
    companies.forEach((company, idx) => {
      map.set(company.id, liveRunsQueries[idx]?.data ?? []);
    });
    return map;
  }, [companies, liveRunsQueries]);

  const liveRunsAllFlat = useMemo(() => {
    const all: LiveRunForIssue[] = [];
    for (const runs of liveRunsByCompany.values()) all.push(...runs);
    return all;
  }, [liveRunsByCompany]);

  const liveRunsTotal = liveRunsAllFlat.length;
  const liveRunsActiveCount = useMemo(
    () => liveRunsAllFlat.filter(isRunActive).length,
    [liveRunsAllFlat],
  );

  // Per-company issues for resolving issue titles on agent run cards.
  const portfolioAgentIssuesQueries = useQueries({
    queries: companies.map((company) => {
      const runs = liveRunsByCompany.get(company.id) ?? [];
      return {
        queryKey: [...queryKeys.issues.list(company.id), "with-routine-executions"],
        queryFn: () => issuesApi.list(company.id, { includeRoutineExecutions: true }),
        enabled: isPortfolioRoot && runs.length > 0,
      };
    }),
  });

  const issuesByIdAcrossPortfolio = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const q of portfolioAgentIssuesQueries) {
      for (const issue of q.data ?? []) map.set(issue.id, issue);
    }
    return map;
  }, [portfolioAgentIssuesQueries]);

  // One transcript subscription across all runs — fine because the realtime
  // websocket is disabled in this view; only per-run log polling is used.
  const { transcriptByRun, hasOutputForRun } = useLiveRunTranscripts({
    runs: liveRunsAllFlat,
    companyId: null,
    maxChunksPerRun: DASHBOARD_AGENT_RUN_CONFIG.maxChunksPerRun,
    logPollIntervalMs: DASHBOARD_AGENT_RUN_CONFIG.logPollIntervalMs,
    logReadLimitBytes: DASHBOARD_AGENT_RUN_CONFIG.logReadLimitBytes,
    enableRealtimeUpdates: false,
  });

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

  // "Waiting" is computed live from the inbox + server-side rules per
  // mailbox. The markdown `## Review queue` section is no longer the source
  // of truth — it was populated by an out-of-band triage routine that could
  // (and did) leave the brief showing "nothing waiting" while PortfolioEmail
  // still had unmatched mail. PortfolioEmail uses the same listMessages +
  // listRules path; computing the same way here keeps the two surfaces in
  // agreement.
  const uniqueReviewMailboxes = useMemo(() => {
    if (!rulesData?.bundles) return [] as { companyId: string; mailbox: string; issueId: string }[];
    const seen = new Set<string>();
    const out: { companyId: string; mailbox: string; issueId: string }[] = [];
    for (const b of rulesData.bundles) {
      const k = `${b.companyId}::${b.mailbox}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ companyId: b.companyId, mailbox: b.mailbox, issueId: b.issueId });
    }
    return out;
  }, [rulesData]);

  const reviewMessagesQueries = useQueries({
    queries: uniqueReviewMailboxes.map(({ companyId, mailbox }) => ({
      queryKey: [
        "portfolioBrief",
        "reviewQueueMessages",
        emailPluginId,
        companyId,
        mailbox,
      ],
      queryFn: () => {
        const api = makeEmailToolsApi(emailPluginId!, companyId);
        return api.listMessages(mailbox, { limit: 200, unseen: true });
      },
      enabled: !!emailPluginId,
      staleTime: 60_000,
    })),
  });

  const reviewRulesQueries = useQueries({
    queries: uniqueReviewMailboxes.map(({ companyId, mailbox }) => ({
      queryKey: [
        "portfolioBrief",
        "reviewQueueRules",
        emailPluginId,
        companyId,
        mailbox,
      ],
      queryFn: () => {
        const api = makeEmailToolsApi(emailPluginId!, companyId);
        return api.listRules(mailbox);
      },
      enabled: !!emailPluginId,
      staleTime: 60_000,
    })),
  });

  const { reviewQueueRows, reviewPreviewLookup, reviewMatchedUidsLookup } = useMemo(() => {
    const rows: ReviewQueueRow[] = [];
    const headerMap = new Map<string, MailHeader>();
    const uidsMap = new Map<string, number[]>();

    uniqueReviewMailboxes.forEach(({ companyId, mailbox, issueId }, idx) => {
      const messages = reviewMessagesQueries[idx]?.data?.messages ?? [];
      if (messages.length === 0) return;

      const auto = new Set<string>();
      const keep = new Set<string>();
      const mute = new Set<string>();
      for (const r of reviewRulesQueries[idx]?.data?.rules ?? []) {
        const p = r.senderPattern.toLowerCase();
        if (r.ruleType === "auto-triage") auto.add(p);
        else if (r.ruleType === "keep-always") keep.add(p);
        else if (r.ruleType === "mute") mute.add(p);
      }
      const isRuled = (addr: string): boolean => {
        if (auto.has(addr) || keep.has(addr) || mute.has(addr)) return true;
        const at = addr.indexOf("@");
        if (at < 0) return false;
        const domain = `@${addr.slice(at + 1)}`;
        return auto.has(domain) || keep.has(domain) || mute.has(domain);
      };

      // Group unmatched unread messages by sender address. Senders with no
      // extractable address fall back to the raw `from` so they aren't lost.
      const groups = new Map<string, MailHeader[]>();
      for (const msg of messages) {
        const addr = extractEmailAddress(msg.from);
        if (addr && isRuled(addr)) continue;
        const key = addr ?? msg.from.trim().toLowerCase();
        const list = groups.get(key);
        if (list) list.push(msg);
        else groups.set(key, [msg]);
      }

      for (const [sender, group] of groups) {
        rows.push({
          sender,
          count: group.length,
          mailbox,
          rulesIssueId: issueId,
          companyId,
        });
        group.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        const previewKey = `${companyId}::${mailbox}::${sender}`;
        headerMap.set(previewKey, group[0]!);
        uidsMap.set(previewKey, group.map((m) => m.uid));
      }
    });

    rows.sort((a, b) => b.count - a.count);
    return {
      reviewQueueRows: rows,
      reviewPreviewLookup: headerMap,
      reviewMatchedUidsLookup: uidsMap,
    };
  }, [uniqueReviewMailboxes, reviewMessagesQueries, reviewRulesQueries]);

  const reviewQueueBuckets: CompanyBucket<ReviewQueueRow>[] = useMemo(() => {
    return groupByCompany(reviewQueueRows, companies);
  }, [reviewQueueRows, companies]);

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
      queryClient.invalidateQueries({
        queryKey: ["portfolioBrief", "reviewQueueMessages"],
      });
      queryClient.invalidateQueries({
        queryKey: ["portfolioBrief", "reviewQueueRules"],
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
  const muteMutation = useMutation({
    mutationFn: async (row: ReviewQueueRow) => {
      // Mute is a third keep-always-flavoured rule: sender stays in INBOX,
      // but the email-tools poll loop marks all future arrivals as read on
      // receipt (see plugin worker.ts `email.set-rule` + poll.ts mute
      // check). The set-rule action also sweeps existing unread INBOX
      // backlog read; markRowUidsRead clears the specific UIDs we tracked
      // for this row in case the sweep missed any (race with new arrivals).
      await writeRuleToDb(row.companyId, row.mailbox, row.sender, "mute");
      await markRowUidsRead(row);
      await applyReviewTransform(row, dismissReviewSender);
    },
    ...reviewMutationOptions,
  });
  const dismissMutation = useMutation({
    mutationFn: async (row: ReviewQueueRow) => {
      // Dismiss = "I dealt with this without a rule." Since the live count
      // is unread + unmatched, marking the tracked UIDs as read drops the
      // sender from the brief. Next time they email, the new (unread) mail
      // will resurface here.
      await markRowUidsRead(row);
      // Also strip from the markdown's stale Review queue (no longer the
      // brief's source of truth, but external consumers may still read it).
      await applyReviewTransform(row, dismissReviewSender);
    },
    ...reviewMutationOptions,
  });
  const lastReviewError =
    graduateMutation.error ??
    keepUnreadMutation.error ??
    keepReadMutation.error ??
    muteMutation.error ??
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

      <SortableSections
        pageKey="portfolio-brief"
        sections={[
          {
            id: "companies",
            render: () =>
              companies.length === 0 ? null : (
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
              ),
          },
          {
            id: "awaiting-tap",
            render: () => (
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
                    Hover for preview, click for full email · Auto-triage = move + rule · Keep · read/unread = leave in INBOX + rule · Keep · mute = auto-mark future as read · Dismiss = no rule
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
                              emailCompany={mailboxAllowedCompanyByKey.get(row.mailbox) ?? company}
                              pending={isPending}
                              canWriteRules={!!emailPluginId}
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
                              onMute={() => muteMutation.mutate(row)}
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
            ),
          },
          {
            id: "agents",
            render: () => (
              <section aria-label="Agents">
        <SectionHeader
          label="Agents"
          chip={
            liveRunsActiveCount > 0
              ? {
                  text: `${liveRunsActiveCount} live`,
                  tone: "emerald",
                }
              : null
          }
          right={{ label: "View all runs →", to: "/dashboard/live" }}
        />
        {liveRunsTotal === 0 ? (
          <EmptySection
            icon={Bot}
            message="No recent agent runs across the portfolio."
          />
        ) : (
          <div className="space-y-3">
            {companies
              .filter((c) => (liveRunsByCompany.get(c.id) ?? []).length > 0)
              .map((company) => {
                const runs = liveRunsByCompany.get(company.id) ?? [];
                const visible = runs.slice(0, AGENT_RUNS_PER_COMPANY);
                const activeForCompany = runs.filter(isRunActive).length;
                return (
                  <div
                    key={company.id}
                    className="border border-border bg-card overflow-hidden"
                  >
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
                        {activeForCompany > 0
                          ? `${activeForCompany} live · `
                          : ""}
                        {runs.length} run{runs.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 p-3">
                      {visible.map((run) => (
                        <AgentRunCard
                          key={run.id}
                          companyId={company.id}
                          run={run}
                          issue={
                            run.issueId
                              ? issuesByIdAcrossPortfolio.get(run.issueId)
                              : undefined
                          }
                          transcript={
                            transcriptByRun.get(run.id) ?? EMPTY_TRANSCRIPT
                          }
                          hasOutput={hasOutputForRun(run.id)}
                          isActive={isRunActive(run)}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
          </div>
        )}
              </section>
            ),
          },
          {
            id: "overnight",
            render: () => (
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
            ),
          },
          {
            id: "today",
            render: () => (
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
            ),
          },
        ]}
      />
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
  /**
   * Company to use when building the /email link. Differs from `company`
   * (the rules-home owner) when the mailbox is `allowedCompanies`-listed
   * under a different company — e.g. the rules issue lives in HQ but the
   * mailbox is only readable from Personal.
   */
  emailCompany: Company;
  pending: boolean;
  canWriteRules: boolean;
  preview: MailHeader | null;
  fullBodyText: string | null;
  fullBodyLoading: boolean;
  onHoverChange: (entered: boolean) => void;
  onGraduate: () => void;
  onKeepRead: () => void;
  onKeepUnread: () => void;
  onMute: () => void;
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
  emailCompany,
  pending,
  canWriteRules,
  preview,
  fullBodyText,
  fullBodyLoading,
  onHoverChange,
  onGraduate,
  onKeepRead,
  onKeepUnread,
  onMute,
  onDismiss,
}: ReviewQueueRowProps) {
  // `company` is suppressed below — it's the rules-home grouping passed in
  // for symmetry with sibling rows. The email link uses `emailCompany`.
  void company;
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const subjectLine = preview?.subject?.trim() || "";
  const snippet = preview?.snippet?.trim() || "";
  const fullBody = fullBodyText ? truncateBody(fullBodyText, PREVIEW_BODY_CHARS) : null;
  const baseEmailPath = `/${emailCompany.issuePrefix}/email`;
  // Without pre-flipping selectedCompanyId, Layout's URL→company sync bails out
  // when selectionSource is "manual" (see shouldSyncCompanySelectionFromRoute),
  // landing the Email page on the wrong company and rendering "Email not
  // configured" until the operator refreshes. Pair the navigation with a
  // route_sync company switch — mirrors PortfolioEmail.openInCompany.
  function handleLinkClick() {
    if (emailCompany.id !== selectedCompanyId) {
      setSelectedCompanyId(emailCompany.id, { source: "route_sync" });
    }
  }
  const messageHref = preview
    ? `${baseEmailPath}?mailbox=${encodeURIComponent(row.mailbox)}&folder=INBOX&uid=${preview.uid}&all=1`
    : `${baseEmailPath}?mailbox=${encodeURIComponent(row.mailbox)}&folder=INBOX&all=1`;

  // Auto-triage / Keep buttons write rules via the email-tools plugin bridge.
  // Without the plugin installed, those calls silently no-op — gate at the UI
  // so the buttons disable with an explanation.
  const ruleButtonGate = (button: React.ReactNode) => {
    if (canWriteRules) return button;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{button}</span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          Email-tools plugin isn't installed — rule actions are disabled.
        </TooltipContent>
      </Tooltip>
    );
  };

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
                onClick={handleLinkClick}
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
          {ruleButtonGate(
            <button
              type="button"
              onClick={onGraduate}
              disabled={pending || !canWriteRules}
              title="Write an auto-triage rule and move every message from this sender (now and going forward) to _paperclip/triage."
              className="px-2.5 py-1 text-[11px] font-medium border border-border bg-foreground text-background hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Auto-triage
            </button>,
          )}
          {ruleButtonGate(
            <button
              type="button"
              onClick={onKeepRead}
              disabled={pending || !canWriteRules}
              title="Keep this sender in INBOX going forward AND mark the existing messages as read."
              className="px-2.5 py-1 text-[11px] font-medium border border-border bg-background text-foreground hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Keep · read
            </button>,
          )}
          {ruleButtonGate(
            <button
              type="button"
              onClick={onKeepUnread}
              disabled={pending || !canWriteRules}
              title="Keep this sender in INBOX going forward and leave existing messages unread."
              className="px-2.5 py-1 text-[11px] font-medium border border-border bg-background text-foreground hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Keep · unread
            </button>,
          )}
          {ruleButtonGate(
            <button
              type="button"
              onClick={onMute}
              disabled={pending || !canWriteRules}
              title="Keep this sender in INBOX going forward and automatically mark all future arrivals as read on the next poll. Marks the existing backlog as read too."
              className="px-2.5 py-1 text-[11px] font-medium border border-border bg-background text-foreground hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Keep · mute
            </button>,
          )}
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
  const fullTimestamp = new Date(event.createdAt).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  const actorLabel =
    event.actorType === "agent"
      ? "an agent"
      : event.actorType === "user"
        ? "a user"
        : event.actorType === "system"
          ? "the system"
          : event.actorType === "plugin"
            ? "a plugin"
            : event.actorType;

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

  const trigger = link ? (
    <Link to={link} className="block hover:bg-accent/40 transition-colors no-underline text-inherit">
      {inner}
    </Link>
  ) : (
    <div>{inner}</div>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-md p-3 text-left whitespace-normal">
        <div className="space-y-1.5">
          <div className="text-[13px] font-medium leading-snug break-words">
            {outcome.verb}
            {outcome.target && (
              <span className="font-normal opacity-80"> {outcome.target}</span>
            )}
          </div>
          <div className="text-[11px] opacity-70">
            {fullTimestamp} · by {actorLabel} · in {company.name}
          </div>
          {link && (
            <div className="text-[11px] opacity-60">
              Click to open this {event.entityType}
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
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
  const prefix = company.issuePrefix;

  // Clicks on inner Links must not also fire the outer card onSelect handler,
  // otherwise the user lands on /brief instead of the filtered list.
  const stopCardClick = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
  };

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
          <HealthStat
            label="running"
            value={summary.agents.running}
            colorClass="text-cyan-600 dark:text-cyan-400"
            to={`/${prefix}/agents/active`}
            onClickCapture={stopCardClick}
          />
          <HealthStat
            label="active"
            value={summary.agents.active}
            colorClass="text-muted-foreground"
            to={`/${prefix}/agents/active`}
            onClickCapture={stopCardClick}
          />
          <HealthStat
            label="paused"
            value={summary.agents.paused}
            colorClass="text-yellow-600 dark:text-yellow-400"
            to={`/${prefix}/agents/paused`}
            onClickCapture={stopCardClick}
          />
          <HealthStat
            label="error"
            value={summary.agents.error}
            colorClass="text-red-600 dark:text-red-400"
            to={`/${prefix}/agents/error`}
            onClickCapture={stopCardClick}
          />
        </div>
      </div>

      <div className="flex items-center gap-3 mb-2 text-sm">
        <span className="text-[10px] font-medium uppercase text-muted-foreground w-14 shrink-0">Issues</span>
        <div className="flex items-center gap-2 flex-wrap">
          <HealthStat
            label="open"
            value={summary.tasks.open}
            colorClass="text-blue-600 dark:text-blue-400"
            to={`/${prefix}/issues?status=backlog&status=todo&status=in_review`}
            onClickCapture={stopCardClick}
          />
          <HealthStat
            label="active"
            value={summary.tasks.inProgress}
            colorClass="text-yellow-600 dark:text-yellow-400"
            to={`/${prefix}/issues?status=in_progress`}
            onClickCapture={stopCardClick}
          />
          <HealthStat
            label="blocked"
            value={summary.tasks.blocked}
            colorClass="text-red-600 dark:text-red-400"
            to={`/${prefix}/issues?status=blocked`}
            onClickCapture={stopCardClick}
          />
        </div>
      </div>

      <div className="flex items-center justify-between mt-3 pt-3 border-t border-border/50 text-xs text-muted-foreground">
        <Link
          to={`/${prefix}/costs`}
          onClick={stopCardClick}
          className="hover:bg-accent/40 rounded-sm -mx-1 px-1 no-underline text-inherit"
        >
          <span className="font-semibold text-foreground tabular-nums hover:underline underline-offset-2">
            {formatCents(summary.costs.monthSpendCents)}
          </span>
          {summary.costs.monthBudgetCents > 0 && (
            <span className={cn("ml-1", spendPct >= 90 ? "text-red-500" : spendPct >= 70 ? "text-yellow-500" : "")}>
              / {formatCents(summary.costs.monthBudgetCents)} ({spendPct.toFixed(0)}%)
            </span>
          )}
          {" MTD"}
        </Link>
        {summary.pendingApprovals > 0 && (
          <span className="text-amber-500 font-medium">
            {summary.pendingApprovals} approval{summary.pendingApprovals !== 1 ? "s" : ""} pending
          </span>
        )}
      </div>
    </div>
  );
}

interface HealthStatProps {
  label: string;
  value: number;
  colorClass: string;
  to: string;
  onClickCapture?: (e: React.MouseEvent) => void;
}

function HealthStat({ label, value, colorClass, to, onClickCapture }: HealthStatProps) {
  const isZero = value === 0;
  return (
    <Link
      to={to}
      onClick={onClickCapture}
      className="flex items-center gap-0.5 hover:bg-accent/40 rounded-sm -mx-1 px-1 no-underline text-inherit"
    >
      <span
        className={cn(
          "font-semibold tabular-nums hover:underline underline-offset-2",
          isZero ? "text-muted-foreground/50" : colorClass,
        )}
      >
        {value}
      </span>
      <span className="text-[10px] text-muted-foreground">{label}</span>
    </Link>
  );
}
