import { useEffect, useMemo } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import {
  Sun,
  Sunrise,
  Moon,
  Sparkles,
  CheckCircle2,
  ListChecks,
  Pencil,
} from "lucide-react";
import type { ActivityEvent, Approval, Company, DashboardSummary, Issue } from "@paperclipai/shared";
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

const OVERNIGHT_HOURS = 14;
const OUTCOMES_LIMIT = 400;
const OUTCOMES_PER_COMPANY = 5;
const DRAFTS_PER_COMPANY = 4;
const ISSUES_PER_COMPANY = 3;

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
  const { selectedCompanyId, selectedCompany } = useCompany();
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

  const overnightCutoff = useMemo(() => {
    const d = new Date();
    d.setHours(d.getHours() - OVERNIGHT_HOURS);
    return d;
  }, []);

  // Merge the company list across all four sources so a company shows up
  // even if only one signal (a draft, an outcome, an issue) is present.
  const companyMap = useMemo(() => {
    const map = new Map<string, Company>();
    for (const c of dashboardData?.companies ?? []) map.set(c.id, c);
    for (const c of activityData?.companies ?? []) map.set(c.id, c);
    for (const c of approvalsData?.companies ?? []) map.set(c.id, c);
    for (const c of issuesData?.companies ?? []) map.set(c.id, c);
    return map;
  }, [dashboardData, activityData, approvalsData, issuesData]);

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

      {/* Awaiting your tap */}
      <section aria-label="Awaiting your tap">
        <SectionHeader
          label="Awaiting your tap"
          chip={
            draftsTotal > 0
              ? { text: `${draftsTotal} draft${draftsTotal === 1 ? "" : "s"}`, tone: "amber" }
              : null
          }
          right={
            draftsTotal > 0
              ? { label: "Open all approvals →", to: "/portfolio-approvals" }
              : null
          }
        />
        {draftsTotal === 0 ? (
          <EmptySection icon={CheckCircle2} message="Nothing waiting on you across the portfolio." tone="emerald" />
        ) : (
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
          to={`/${company.issuePrefix}/dashboard`}
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
