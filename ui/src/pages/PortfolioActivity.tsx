import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, History } from "lucide-react";
import type { ActivityEvent, Company } from "@paperclipai/shared";
import { activityApi } from "../api/activity";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { timeAgo } from "../lib/timeAgo";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "../lib/utils";

interface FilterPopoverProps {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}

function FilterPopover({ label, options, selected, onChange }: FilterPopoverProps) {
  function toggle(v: string) {
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  }
  const activeLabel =
    selected.length > 0 && selected.length < options.length
      ? `${label}: ${selected.length}`
      : label;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "h-7 text-xs gap-1",
            selected.length > 0 && selected.length < options.length && "border-primary/50 text-primary",
          )}
        >
          {activeLabel}
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48 p-1">
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => toggle(opt.value)}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
          >
            <Checkbox checked={selected.includes(opt.value)} onCheckedChange={() => toggle(opt.value)} className="h-3.5 w-3.5" />
            <span className="flex-1 text-left">{opt.label}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

interface ActivityRowProps {
  event: ActivityEvent;
  company: Company | undefined;
}

function ActivityRow({ event, company }: ActivityRowProps) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-accent/30 rounded">
      {company && (
        <CompanyPatternIcon
          companyName={company.name}
          logoUrl={company.logoUrl}
          brandColor={company.brandColor}
          className="h-4 w-4 shrink-0 rounded-[2px]"
        />
      )}
      <span className="text-[10px] font-semibold text-muted-foreground shrink-0 w-28 truncate hidden sm:block">
        {event.action}
      </span>
      <span className="flex-1 truncate text-muted-foreground">
        <span className="font-medium text-foreground">{event.actorType}</span>
        {" · "}
        {event.entityType}
        {event.entityId ? ` ${event.entityId.slice(0, 8)}` : ""}
      </span>
      <span className="text-[11px] text-muted-foreground shrink-0 w-14 text-right">{timeAgo(event.createdAt)}</span>
    </div>
  );
}

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

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <h1 className="text-base font-semibold">Portfolio Activity</h1>
        <span className="text-sm text-muted-foreground">{isLoading ? "Loading…" : `${events.length} events`}</span>
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
        {isLoading && <p className="text-sm text-muted-foreground">Loading activity…</p>}
        {!isLoading && events.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <History className="h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No recent activity across the portfolio.</p>
          </div>
        )}
        {!isLoading && events.map((event) => (
          <ActivityRow key={event.id} event={event} company={companyMap.get(event.companyId)} />
        ))}
      </div>
    </div>
  );
}
