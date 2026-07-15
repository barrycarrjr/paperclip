import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Megaphone } from "lucide-react";
import type { Company } from "@paperclipai/shared";
import { issuesApi, type PortfolioDirective } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { Link } from "@/lib/router";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";

// Issue statuses that count as "the CEO has finished acting on this directive".
const DONE_STATUSES = new Set(["done", "completed", "succeeded", "closed", "cancelled"]);

function directiveProgress(d: PortfolioDirective): { done: number; total: number; pct: number } {
  const total = d.companyCount || d.items.length;
  let done = 0;
  for (const [status, count] of Object.entries(d.statusCounts)) {
    if (DONE_STATUSES.has(status)) done += count;
  }
  return { done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
}

interface DirectiveCardProps {
  directive: PortfolioDirective;
  prefixByCompanyId: Map<string, string>;
  collapsed: boolean;
  onToggle: () => void;
}

function DirectiveCard({ directive, prefixByCompanyId, collapsed, onToggle }: DirectiveCardProps) {
  const { done, total, pct } = directiveProgress(directive);
  const allDone = total > 0 && done === total;
  const items = useMemo(
    () => [...directive.items].sort((a, b) => a.companyName.localeCompare(b.companyName)),
    [directive.items],
  );

  return (
    <div className="rounded-lg border border-border bg-card shadow-sm overflow-hidden">
      <button
        onClick={onToggle}
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-accent/30 transition-colors"
      >
        {collapsed ? (
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
        )}
        <Megaphone className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-semibold truncate">{directive.title}</span>
            <span className="text-xs text-muted-foreground shrink-0">
              {timeAgo(new Date(directive.createdAt))}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <div className="h-1.5 flex-1 max-w-48 rounded-full bg-muted overflow-hidden">
              <div
                className={cn("h-full rounded-full", allDone ? "bg-green-500" : "bg-primary")}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-xs text-muted-foreground shrink-0">
              {done}/{total} {total === 1 ? "company" : "companies"} done
            </span>
          </div>
        </div>
      </button>

      {!collapsed && (
        <div className="border-t border-border divide-y divide-border/60">
          {items.map((item) => {
            const prefix = prefixByCompanyId.get(item.companyId);
            const label = item.identifier ?? item.issueId.slice(0, 8);
            return (
              <div
                key={item.issueId}
                className="flex items-center gap-3 px-4 py-2 pl-11 hover:bg-accent/30 transition-colors"
              >
                <span className="text-sm truncate flex-1 min-w-0">{item.companyName}</span>
                {prefix ? (
                  <Link
                    to={`/${prefix}/issues/${item.issueId}`}
                    className="text-xs font-mono text-muted-foreground hover:text-foreground hover:underline shrink-0"
                  >
                    {label}
                  </Link>
                ) : (
                  <span className="text-xs font-mono text-muted-foreground shrink-0">{label}</span>
                )}
                <StatusBadge status={item.status} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function PortfolioDirectives() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Portfolio Directives" }]);
  }, [setBreadcrumbs]);

  const isPortfolioRoot = selectedCompany?.isPortfolioRoot ?? false;

  const { data, isLoading } = useQuery({
    queryKey: ["portfolio-directives", selectedCompanyId],
    queryFn: () => issuesApi.listPortfolioDirectives(selectedCompanyId!),
    enabled: !!selectedCompanyId && isPortfolioRoot,
    refetchInterval: 15_000,
  });

  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  function toggleCollapse(id: string) {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const directives = data?.directives ?? [];
  const prefixByCompanyId = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of (data?.companies ?? []) as Company[]) map.set(c.id, c.issuePrefix);
    return map;
  }, [data?.companies]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Megaphone} message="Select a company to view Portfolio Directives." />;
  }
  if (!isPortfolioRoot) {
    return (
      <EmptyState
        icon={Megaphone}
        message="Portfolio Directives are only available on the HQ (portfolio root) company."
      />
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <div>
          <h1 className="text-base font-semibold">Portfolio Directives</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            High-level intents you broadcast from HQ, cascading through each company's CEO.
          </p>
        </div>
        <span className="text-sm text-muted-foreground">
          {isLoading ? "Loading…" : `${directives.length} ${directives.length === 1 ? "directive" : "directives"}`}
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-3">
        {isLoading && <p className="text-sm text-muted-foreground">Loading directives…</p>}
        {!isLoading && directives.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
            <Megaphone className="h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground max-w-md">
              No directives yet. Open Clippy here at HQ and tell it a portfolio-wide intent — e.g.
              &ldquo;acknowledge and reply to every company's Google reviews&rdquo; — and it will
              fan out to each company's CEO. They'll appear here as they land.
            </p>
          </div>
        )}
        {!isLoading &&
          directives.map((d) => (
            <DirectiveCard
              key={d.directiveId}
              directive={d}
              prefixByCompanyId={prefixByCompanyId}
              collapsed={collapsedIds.has(d.directiveId)}
              onToggle={() => toggleCollapse(d.directiveId)}
            />
          ))}
      </div>
    </div>
  );
}
