import { useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { LayoutGrid } from "lucide-react";
import type { Company, DashboardSummary } from "@paperclipai/shared";
import { dashboardApi } from "../api/dashboard";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { Link, useNavigate } from "@/lib/router";
import { cn } from "../lib/utils";

function formatCents(cents: number) {
  if (cents >= 100_00) return `$${(cents / 100).toFixed(0)}`;
  return `$${(cents / 100).toFixed(2)}`;
}

function statPill(label: string, value: number, tone?: "danger" | "warn" | "muted") {
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

interface CompanyCardProps {
  company: Company;
  summary: DashboardSummary;
}

function CompanyCard({ company, summary }: CompanyCardProps) {
  const spendPct = summary.costs.monthUtilizationPercent ?? 0;
  const hasError = summary.agents.error > 0;
  const hasPending = summary.pendingApprovals > 0;
  const { setSelectedCompanyId } = useCompany();
  const navigate = useNavigate();

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={() => { setSelectedCompanyId(company.id, { source: "route_sync" }); navigate(`/${company.issuePrefix}/dashboard`); }}
      onKeyDown={(e) => { if (e.key === "Enter") { setSelectedCompanyId(company.id, { source: "route_sync" }); navigate(`/${company.issuePrefix}/dashboard`); } }}
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
          {statPill("running", summary.agents.running)}
          {statPill("active", summary.agents.active)}
          {statPill("paused", summary.agents.paused, summary.agents.paused > 0 ? "warn" : undefined)}
          {statPill("error", summary.agents.error, summary.agents.error > 0 ? "danger" : undefined)}
        </div>
      </div>

      <div className="flex items-center gap-3 mb-2 text-sm">
        <span className="text-[10px] font-medium uppercase text-muted-foreground w-14 shrink-0">Issues</span>
        <div className="flex items-center gap-2 flex-wrap">
          {statPill("open", summary.tasks.open)}
          {statPill("active", summary.tasks.inProgress)}
          {statPill("blocked", summary.tasks.blocked, summary.tasks.blocked > 0 ? "warn" : undefined)}
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

export function PortfolioDashboard() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => { setBreadcrumbs([{ label: "Portfolio Dashboard" }]); }, [setBreadcrumbs]);

  const { data, isLoading } = useQuery({
    queryKey: ["portfolio-dashboard", selectedCompanyId],
    queryFn: () => dashboardApi.listPortfolio(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const companies = useMemo(() => {
    const raw = data?.companies ?? [];
    return [...raw].sort((a, b) => (b.isPortfolioRoot ? 1 : 0) - (a.isPortfolioRoot ? 1 : 0));
  }, [data?.companies]);

  const summaryMap = useMemo(() => {
    const map = new Map<string, DashboardSummary>();
    for (const s of data?.summaries ?? []) map.set(s.companyId, s);
    return map;
  }, [data?.summaries]);

  const totalAgents = useMemo(
    () => (data?.summaries ?? []).reduce((acc, s) => acc + s.agents.active + s.agents.running + s.agents.paused + s.agents.error, 0),
    [data?.summaries],
  );
  const totalSpend = useMemo(
    () => (data?.summaries ?? []).reduce((acc, s) => acc + s.costs.monthSpendCents, 0),
    [data?.summaries],
  );
  const totalPending = useMemo(
    () => (data?.summaries ?? []).reduce((acc, s) => acc + s.pendingApprovals, 0),
    [data?.summaries],
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <h1 className="text-base font-semibold">Portfolio Dashboard</h1>
        {!isLoading && (
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <span>{companies.length} companies</span>
            <span>{totalAgents} agents</span>
            <span>{formatCents(totalSpend)} MTD</span>
            {totalPending > 0 && <span className="text-amber-500 font-medium">{totalPending} pending</span>}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
        {isLoading && <p className="text-sm text-muted-foreground">Loading dashboard…</p>}
        {!isLoading && companies.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <LayoutGrid className="h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No companies in portfolio.</p>
          </div>
        )}
        {!isLoading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {companies.map((company) => {
              const summary = summaryMap.get(company.id);
              if (!summary) return null;
              return <CompanyCard key={company.id} company={company} summary={summary} />;
            })}
          </div>
        )}
      </div>
    </div>
  );
}
