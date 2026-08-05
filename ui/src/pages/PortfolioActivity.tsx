import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import type { Agent, Company } from "@paperclipai/shared";
import { activityApi } from "../api/activity";
import { agentsApi } from "../api/agents";
import { activityEntityName, activityEntityTitle } from "../lib/activity-entity-names";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { ActivityRow } from "../components/ActivityRow";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { EmptyState } from "../components/EmptyState";
import { FilterPopover } from "../components/FilterPopover";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";

export function PortfolioActivity() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => { setBreadcrumbs([{ label: "Portfolio Activity" }]); }, [setBreadcrumbs]);

  const [companyIdFilter, setCompanyIdFilter] = useState<string[]>([]);

  const { data, isLoading } = useQuery({
    queryKey: ["portfolio-activity", selectedCompanyId, companyIdFilter],
    queryFn: () => activityApi.listPortfolio(selectedCompanyId!, {
      companyIds: companyIdFilter.length > 0 ? companyIdFilter : undefined,
    }),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const { data: portfolioAgents } = useQuery({
    queryKey: ["portfolio-agents", selectedCompanyId],
    queryFn: () => agentsApi.listPortfolio(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const events = data?.events ?? [];
  const companies = useMemo(() => {
    const raw = data?.companies ?? [];
    return [...raw].sort((a, b) => (b.isPortfolioRoot ? 1 : 0) - (a.isPortfolioRoot ? 1 : 0));
  }, [data?.companies]);

  const companyMap = useMemo(
    () => new Map<string, Company>(companies.map((c) => [c.id, c])),
    [companies],
  );
  const companyOptions = useMemo(() => companies.map((c) => ({ value: c.id, label: c.name })), [companies]);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of portfolioAgents?.agents ?? []) map.set(a.id, a);
    return map;
  }, [portfolioAgents?.agents]);

  // Company-scoped link prefixes for cross-company navigation. When a
  // company or its issue prefix is missing, rows fall back to unprefixed
  // links so they still navigate somewhere.
  const companyPrefixMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of portfolioAgents?.companies ?? []) {
      if (c.issuePrefix) map.set(c.id, `/${c.issuePrefix}`);
    }
    return map;
  }, [portfolioAgents?.companies]);

  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of portfolioAgents?.agents ?? []) map.set(`agent:${a.id}`, a.name);
    for (const event of data?.events ?? []) {
      const name = activityEntityName(event);
      if (name) map.set(`${event.entityType}:${event.entityId}`, name);
    }
    return map;
  }, [data?.events, portfolioAgents?.agents]);

  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const event of data?.events ?? []) {
      const title = activityEntityTitle(event);
      if (title) map.set(`${event.entityType}:${event.entityId}`, title);
    }
    return map;
  }, [data?.events]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <h1 className="text-base font-semibold">Portfolio Activity</h1>
        <span className="text-sm text-muted-foreground">{isLoading ? "Loading…" : `Showing latest ${events.length}`}</span>
      </div>
      <div className="flex items-center gap-2 px-6 py-2.5 border-b border-border shrink-0 flex-wrap">
        {companyOptions.length > 0 && (
          <FilterPopover label="Company" options={companyOptions} selected={companyIdFilter} onChange={setCompanyIdFilter} />
        )}
        {companyIdFilter.length > 0 && (
          <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={() => setCompanyIdFilter([])}>
            Clear filters
          </Button>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-3">
        {isLoading && <PageSkeleton variant="list" />}
        {!isLoading && events.length === 0 && (
          <EmptyState icon={History} message="No recent activity across the portfolio." />
        )}
        {!isLoading && events.length > 0 && (
          <div className="border border-border rounded-md divide-y divide-border">
            {events.map((event) => {
              const company = companyMap.get(event.companyId);
              return (
                <div key={event.id} className="flex items-start gap-2">
                  {company && (
                    <CompanyPatternIcon
                      companyName={company.name}
                      logoUrl={company.logoUrl}
                      brandColor={company.brandColor}
                      className="h-4 w-4 shrink-0 rounded-[2px] ml-3 mt-2.5"
                    />
                  )}
                  <ActivityRow
                    event={event}
                    agentMap={agentMap}
                    entityNameMap={entityNameMap}
                    entityTitleMap={entityTitleMap}
                    companyPrefix={companyPrefixMap.get(event.companyId)}
                    className="flex-1 min-w-0"
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
