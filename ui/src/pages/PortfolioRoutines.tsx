import { useState, useMemo, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Plus, Repeat } from "lucide-react";
import type { Company, RoutineListItem } from "@paperclipai/shared";
import { routinesApi } from "../api/routines";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { Link } from "@/lib/router";
import { timeAgo } from "../lib/timeAgo";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "../lib/utils";

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "error", label: "Error" },
];

function statusDot(status: string) {
  if (status === "active") return "bg-green-400";
  if (status === "paused") return "bg-yellow-400";
  if (status === "error") return "bg-red-400";
  return "bg-neutral-400";
}

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

interface RoutineRowProps {
  routine: RoutineListItem;
  companyPrefix: string;
  selected: boolean;
  onToggle: () => void;
}

function RoutineRow({ routine, companyPrefix, selected, onToggle }: RoutineRowProps) {
  const nextTrigger = routine.triggers.find((t) => t.enabled && t.nextRunAt);
  const lastFired = routine.lastRun?.triggeredAt ?? routine.triggers.find((t) => t.lastFiredAt)?.lastFiredAt ?? null;

  return (
    <div className={cn("flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent/40 rounded group", selected && "bg-accent/60")}>
      <Checkbox
        checked={selected}
        onCheckedChange={onToggle}
        className="h-3.5 w-3.5 opacity-0 group-hover:opacity-100 transition-opacity data-[state=checked]:opacity-100"
      />
      <span className={cn("h-2 w-2 rounded-full shrink-0", statusDot(routine.status))} />
      <Link
        to={`/${companyPrefix}/routines/${routine.id}`}
        className="flex-1 truncate font-medium hover:underline"
      >
        {routine.title}
      </Link>
      {nextTrigger?.nextRunAt && (
        <span className="text-[11px] text-muted-foreground shrink-0 hidden md:block">
          next {timeAgo(nextTrigger.nextRunAt)}
        </span>
      )}
      <span className="text-[11px] text-muted-foreground shrink-0 w-16 text-right">
        {lastFired ? timeAgo(lastFired) : "—"}
      </span>
    </div>
  );
}

interface CompanySectionProps {
  company: Company;
  routines: RoutineListItem[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: (companyId: string, ids: string[]) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

function CompanySection({ company, routines, selectedIds, onToggle, onToggleAll, collapsed, onToggleCollapse }: CompanySectionProps) {
  const ids = routines.map((r) => r.id);
  const allSelected = ids.length > 0 && ids.every((id) => selectedIds.has(id));
  const someSelected = !allSelected && ids.some((id) => selectedIds.has(id));
  return (
    <div className="mb-1">
      <div className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent/30 cursor-pointer group">
        <Checkbox
          checked={allSelected}
          data-state={someSelected ? "indeterminate" : undefined}
          onCheckedChange={() => onToggleAll(company.id, ids)}
          className="h-3.5 w-3.5 opacity-0 group-hover:opacity-100 transition-opacity data-[state=checked]:opacity-100 data-[state=indeterminate]:opacity-100"
          onClick={(e) => e.stopPropagation()}
        />
        <button className="flex flex-1 items-center gap-2 min-w-0" onClick={onToggleCollapse}>
          {collapsed ? <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
          <CompanyPatternIcon companyName={company.name} logoUrl={company.logoUrl} brandColor={company.brandColor} className="h-5 w-5 shrink-0 rounded-[3px]" />
          <span className="font-medium text-sm truncate">{company.name}</span>
          <span className="text-xs text-muted-foreground ml-1">{routines.length} routine{routines.length !== 1 ? "s" : ""}</span>
        </button>
        <Button variant="ghost" size="icon-sm" className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground" asChild>
          <Link to={`/${company.issuePrefix}/routines`}><Plus className="h-3.5 w-3.5" /></Link>
        </Button>
      </div>
      {!collapsed && (
        <div className="ml-6 flex flex-col">
          {routines.map((r) => (
            <RoutineRow key={r.id} routine={r} companyPrefix={company.issuePrefix} selected={selectedIds.has(r.id)} onToggle={() => onToggle(r.id)} />
          ))}
          {routines.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">No routines match the current filters.</p>}
        </div>
      )}
    </div>
  );
}

export function PortfolioRoutines() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => { setBreadcrumbs([{ label: "Portfolio Routines" }]); }, [setBreadcrumbs]);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [companyIdFilter, setCompanyIdFilter] = useState<string[]>([]);

  const { data, isLoading } = useQuery({
    queryKey: ["portfolio-routines", selectedCompanyId, statusFilter, companyIdFilter],
    queryFn: () => routinesApi.listPortfolio(selectedCompanyId!, {
      status: statusFilter.length === 1 ? statusFilter[0] : undefined,
      companyIds: companyIdFilter.length > 0 ? companyIdFilter : undefined,
    }),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const routines = data?.routines ?? [];
  const companies = useMemo(() => {
    const raw = data?.companies ?? [];
    return [...raw].sort((a, b) => (b.isPortfolioRoot ? 1 : 0) - (a.isPortfolioRoot ? 1 : 0));
  }, [data?.companies]);

  const companyOptions = useMemo(() => companies.map((c) => ({ value: c.id, label: c.name })), [companies]);

  const routinesByCompany = useMemo(() => {
    const map = new Map<string, RoutineListItem[]>();
    for (const c of companies) map.set(c.id, []);
    for (const r of routines) { const list = map.get(r.companyId); if (list) list.push(r); }
    return map;
  }, [routines, companies]);

  function toggleId(id: string) {
    setSelectedIds((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleAll(companyId: string, ids: string[]) {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      const all = ids.every((id) => n.has(id));
      if (all) ids.forEach((id) => n.delete(id)); else ids.forEach((id) => n.add(id));
      return n;
    });
  }
  function toggleCollapse(id: string) {
    setCollapsedIds((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  const hasFilters = statusFilter.length > 0 || companyIdFilter.length > 0;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <h1 className="text-base font-semibold">Portfolio Routines</h1>
        <span className="text-sm text-muted-foreground">{isLoading ? "Loading…" : `${routines.length} routine${routines.length !== 1 ? "s" : ""}`}</span>
      </div>
      <div className="flex items-center gap-2 px-6 py-2.5 border-b border-border shrink-0 flex-wrap">
        <FilterPopover label="Status" options={STATUS_OPTIONS} selected={statusFilter} onChange={setStatusFilter} />
        {companyOptions.length > 0 && (
          <FilterPopover label="Company" options={companyOptions} selected={companyIdFilter} onChange={setCompanyIdFilter} />
        )}
        {hasFilters && (
          <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={() => { setStatusFilter([]); setCompanyIdFilter([]); }}>
            Clear filters
          </Button>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-3">
        {isLoading && <p className="text-sm text-muted-foreground">Loading routines…</p>}
        {!isLoading && routines.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <Repeat className="h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No routines found across the portfolio.</p>
          </div>
        )}
        {!isLoading && companies.map((company) => (
          <CompanySection
            key={company.id}
            company={company}
            routines={routinesByCompany.get(company.id) ?? []}
            selectedIds={selectedIds}
            onToggle={toggleId}
            onToggleAll={toggleAll}
            collapsed={collapsedIds.has(company.id)}
            onToggleCollapse={() => toggleCollapse(company.id)}
          />
        ))}
      </div>
    </div>
  );
}
