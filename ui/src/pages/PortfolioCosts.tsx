import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { DollarSign, ArrowUpDown } from "lucide-react";
import type { Company, CostSummary } from "@paperclipai/shared";
import { costsApi } from "../api/costs";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { Link, useNavigate } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";

function formatCents(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function utilizationColor(pct: number) {
  if (pct >= 90) return "text-red-500";
  if (pct >= 70) return "text-yellow-500";
  return "text-green-500";
}

type SortKey = "spend" | "budget" | "utilization" | "name";

export function PortfolioCosts() {
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => { setBreadcrumbs([{ label: "Portfolio Costs" }]); }, [setBreadcrumbs]);

  const [sortKey, setSortKey] = useState<SortKey>("spend");
  const [sortAsc, setSortAsc] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["portfolio-costs", selectedCompanyId],
    queryFn: () => costsApi.listPortfolio(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const summaries = data?.summaries ?? [];
  const companies = useMemo(() => {
    const raw = data?.companies ?? [];
    return [...raw].sort((a, b) => (b.isPortfolioRoot ? 1 : 0) - (a.isPortfolioRoot ? 1 : 0));
  }, [data?.companies]);

  const companyMap = useMemo(
    () => new Map<string, Company>(companies.map((c) => [c.id, c])),
    [companies],
  );

  const rows = useMemo(() => {
    const paired = summaries.map((s) => ({ summary: s, company: companyMap.get(s.companyId) }));
    return paired.sort((a, b) => {
      let diff = 0;
      if (sortKey === "spend") diff = (a.summary.spendCents ?? 0) - (b.summary.spendCents ?? 0);
      else if (sortKey === "budget") diff = (a.summary.budgetCents ?? 0) - (b.summary.budgetCents ?? 0);
      else if (sortKey === "utilization") diff = (a.summary.utilizationPercent ?? 0) - (b.summary.utilizationPercent ?? 0);
      else diff = (a.company?.name ?? "").localeCompare(b.company?.name ?? "");
      return sortAsc ? diff : -diff;
    });
  }, [summaries, companyMap, sortKey, sortAsc]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc((v) => !v);
    else { setSortKey(key); setSortAsc(false); }
  }

  const totalSpend = summaries.reduce((acc, s) => acc + (s.spendCents ?? 0), 0);

  function SortButton({ k, label }: { k: SortKey; label: string }) {
    return (
      <button
        onClick={() => toggleSort(k)}
        className={cn(
          "flex items-center gap-0.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors",
          sortKey === k && "text-foreground",
        )}
      >
        {label}
        <ArrowUpDown className="h-3 w-3 opacity-50" />
      </button>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <h1 className="text-base font-semibold">Portfolio Costs</h1>
        <span className="text-sm text-muted-foreground">
          {isLoading ? "Loading…" : `${formatCents(totalSpend)} MTD across ${companies.length} companies`}
        </span>
      </div>

      <div className="flex items-center gap-3 px-6 py-2 border-b border-border shrink-0 text-xs text-muted-foreground">
        <div className="flex-1"><SortButton k="name" label="Company" /></div>
        <div className="w-24 text-right"><SortButton k="spend" label="Spend MTD" /></div>
        <div className="w-24 text-right hidden md:block"><SortButton k="budget" label="Budget" /></div>
        <div className="w-20 text-right hidden md:block"><SortButton k="utilization" label="Used %" /></div>
        <div className="w-16" />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {isLoading && <p className="text-sm text-muted-foreground px-6 py-4">Loading costs…</p>}
        {!isLoading && rows.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <DollarSign className="h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No cost data available.</p>
          </div>
        )}
        {!isLoading && rows.map(({ summary, company }) => {
          if (!company) return null;
          const pct = summary.utilizationPercent ?? 0;
          return (
            <div key={summary.companyId} className="flex items-center gap-3 px-6 py-3 hover:bg-accent/30 border-b border-border/50 last:border-0">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <CompanyPatternIcon
                  companyName={company.name}
                  logoUrl={company.logoUrl}
                  brandColor={company.brandColor}
                  className="h-5 w-5 shrink-0 rounded-[3px]"
                />
                <button
                  onClick={() => { setSelectedCompanyId(company.id, { source: "route_sync" }); navigate(`/${company.issuePrefix}/costs`); }}
                  className="font-medium text-sm truncate hover:underline text-left"
                >
                  {company.name}
                </button>
              </div>
              <div className="w-24 text-right text-sm font-semibold tabular-nums">
                {formatCents(summary.spendCents ?? 0)}
              </div>
              <div className="w-24 text-right text-sm text-muted-foreground tabular-nums hidden md:block">
                {summary.budgetCents ? formatCents(summary.budgetCents) : "—"}
              </div>
              <div className={cn("w-20 text-right text-sm font-medium tabular-nums hidden md:block", utilizationColor(pct))}>
                {summary.budgetCents ? `${pct.toFixed(0)}%` : "—"}
              </div>
              <div className="w-16 flex justify-end">
                {summary.budgetCents && pct > 0 ? (
                  <div className="w-12 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className={cn("h-full rounded-full", pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-yellow-500" : "bg-green-500")}
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
