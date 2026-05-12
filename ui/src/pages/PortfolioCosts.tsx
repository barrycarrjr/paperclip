import { useState, useMemo, useEffect } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { DollarSign, ArrowUpDown, AlertOctagon } from "lucide-react";
import type { BudgetIncident, BudgetOverview, Company } from "@paperclipai/shared";
import { costsApi } from "../api/costs";
import { budgetsApi } from "../api/budgets";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { BudgetIncidentCard } from "../components/BudgetIncidentCard";
import { useNavigate } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { useDateRange, PRESET_KEYS, PRESET_LABELS } from "../hooks/useDateRange";
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
  const queryClient = useQueryClient();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();

  useEffect(() => { setBreadcrumbs([{ label: "Portfolio Costs" }]); }, [setBreadcrumbs]);

  const [sortKey, setSortKey] = useState<SortKey>("spend");
  const [sortAsc, setSortAsc] = useState(false);

  const {
    preset,
    setPreset,
    customFrom,
    setCustomFrom,
    customTo,
    setCustomTo,
    from,
    to,
    customReady,
  } = useDateRange();

  const { data, isLoading } = useQuery({
    queryKey: ["portfolio-costs", selectedCompanyId, from || "", to || ""],
    queryFn: () =>
      costsApi.listPortfolio(selectedCompanyId!, {
        from: from || undefined,
        to: to || undefined,
      }),
    enabled: !!selectedCompanyId && customReady,
  });

  const summaries = data?.summaries ?? [];
  const companies = useMemo(() => {
    const raw = data?.companies ?? [];
    return [...raw].sort((a, b) => (b.isPortfolioRoot ? 1 : 0) - (a.isPortfolioRoot ? 1 : 0));
  }, [data?.companies]);

  // Pull a budget overview for each company so we can surface active
  // budget incidents (cross-company) at the top of the page.
  const budgetOverviewQueries = useQueries({
    queries: companies.map((c) => ({
      queryKey: ["portfolio-costs", "budget-overview", c.id],
      queryFn: () => budgetsApi.overview(c.id),
      enabled: !!c.id && customReady,
      refetchInterval: 30_000,
      staleTime: 10_000,
    })),
  });

  // Flatten active incidents into a single list. Each incident already carries
  // companyId so we can route mutations + display the company on the card.
  const activeIncidents = useMemo(() => {
    const out: { incident: BudgetIncident; company: Company }[] = [];
    companies.forEach((company, idx) => {
      const overview = budgetOverviewQueries[idx]?.data as BudgetOverview | undefined;
      if (!overview) return;
      for (const incident of overview.activeIncidents) {
        out.push({ incident, company });
      }
    });
    return out;
  }, [companies, budgetOverviewQueries]);

  const incidentMutation = useMutation({
    mutationFn: (input: {
      companyId: string;
      incidentId: string;
      action: "keep_paused" | "raise_budget_and_resume";
      amount?: number;
    }) =>
      budgetsApi.resolveIncident(input.companyId, input.incidentId, {
        action: input.action,
        amount: input.amount,
      }),
    onSuccess: (_data, { companyId, action }) => {
      // Invalidate the per-company overview that holds the incident, plus the
      // portfolio cost summary so spend/budget chip numbers refresh too.
      queryClient.invalidateQueries({ queryKey: ["portfolio-costs", "budget-overview", companyId] });
      queryClient.invalidateQueries({ queryKey: ["portfolio-costs"] });
      pushToast({
        title: action === "keep_paused" ? "Kept paused" : "Budget raised and resumed",
        tone: "success",
      });
    },
    onError: (err) => {
      pushToast({
        title: "Couldn't resolve incident",
        body: err instanceof Error ? err.message : "Try again from the per-company costs page.",
        tone: "error",
      });
    },
  });
  const incidentPendingId =
    incidentMutation.isPending && incidentMutation.variables
      ? incidentMutation.variables.incidentId
      : null;

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

  const rangeLabel = preset === "custom"
    ? customReady ? "Custom range" : "Pick start & end"
    : PRESET_LABELS[preset];

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <h1 className="text-base font-semibold">Portfolio Costs</h1>
        <span className="text-sm text-muted-foreground">
          {isLoading ? "Loading…" : `${formatCents(totalSpend)} · ${rangeLabel} · ${companies.length} compan${companies.length === 1 ? "y" : "ies"}`}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 px-6 py-2.5 border-b border-border shrink-0">
        {PRESET_KEYS.map((key) => (
          <Button
            key={key}
            variant={preset === key ? "secondary" : "ghost"}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setPreset(key)}
          >
            {PRESET_LABELS[key]}
          </Button>
        ))}
        {preset === "custom" && (
          <div className="flex items-center gap-2 ml-2 border border-border rounded px-2 py-1">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="h-6 bg-transparent text-xs outline-none"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="h-6 bg-transparent text-xs outline-none"
            />
          </div>
        )}
      </div>

      {activeIncidents.length > 0 && (
        <div className="border-b border-border bg-red-500/5 px-6 py-3 shrink-0">
          <div className="flex items-center gap-2 mb-2">
            <AlertOctagon className="h-4 w-4 text-red-500" />
            <h2 className="text-sm font-semibold">
              {activeIncidents.length} active budget incident{activeIncidents.length === 1 ? "" : "s"}
            </h2>
            <span className="text-[11px] text-muted-foreground">
              across {new Set(activeIncidents.map((i) => i.company.id)).size} compan{new Set(activeIncidents.map((i) => i.company.id)).size === 1 ? "y" : "ies"}
            </span>
          </div>
          <div className="grid gap-3 lg:grid-cols-2 max-h-[420px] overflow-y-auto pr-1">
            {activeIncidents.map(({ incident, company }) => (
              <div key={incident.id} className="space-y-1.5">
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <CompanyPatternIcon
                    companyName={company.name}
                    logoUrl={company.logoUrl}
                    brandColor={company.brandColor}
                    className="h-4 w-4 rounded-[3px]"
                  />
                  <span className="font-medium">{company.name}</span>
                  <button
                    className="ml-auto underline-offset-2 hover:underline"
                    onClick={() => {
                      setSelectedCompanyId(company.id, { source: "route_sync" });
                      navigate(`/${company.issuePrefix}/costs`);
                    }}
                  >
                    Open in {company.name} →
                  </button>
                </div>
                <BudgetIncidentCard
                  incident={incident}
                  isMutating={incidentPendingId === incident.id}
                  onKeepPaused={() =>
                    incidentMutation.mutate({
                      companyId: company.id,
                      incidentId: incident.id,
                      action: "keep_paused",
                    })
                  }
                  onRaiseAndResume={(amount) =>
                    incidentMutation.mutate({
                      companyId: company.id,
                      incidentId: incident.id,
                      action: "raise_budget_and_resume",
                      amount,
                    })
                  }
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 px-6 py-2 border-b border-border shrink-0 text-xs text-muted-foreground">
        <div className="flex-1"><SortButton k="name" label="Company" /></div>
        <div className="w-24 text-right"><SortButton k="spend" label="Spend" /></div>
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
