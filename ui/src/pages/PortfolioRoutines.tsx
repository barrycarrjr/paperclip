import { useState, useMemo, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Loader2, MoreHorizontal, Pause, Play, Plus, Repeat, Archive as ArchiveIcon, X } from "lucide-react";
import type { Company, RoutineListItem } from "@paperclipai/shared";
import { routinesApi } from "../api/routines";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { Link } from "@/lib/router";
import { timeAgo } from "../lib/timeAgo";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  pendingAction: "run" | "status" | null;
  onToggle: () => void;
  onRun: () => void;
  onSetStatus: (status: "active" | "paused" | "archived") => void;
}

function RoutineRow({
  routine,
  companyPrefix,
  selected,
  pendingAction,
  onToggle,
  onRun,
  onSetStatus,
}: RoutineRowProps) {
  const nextTrigger = routine.triggers.find((t) => t.enabled && t.nextRunAt);
  const lastFired = routine.lastRun?.triggeredAt ?? routine.triggers.find((t) => t.lastFiredAt)?.lastFiredAt ?? null;
  const isPaused = routine.status === "paused";
  const isArchived = routine.status === "archived";
  const pending = pendingAction !== null;

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
        className={cn("flex-1 truncate font-medium hover:underline", isArchived && "text-muted-foreground line-through")}
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
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <Button
          variant="ghost"
          size="icon-sm"
          className="h-6 w-6"
          title={isArchived ? "Routine is archived — unarchive first" : "Run this routine now (uses defaults — open the routine to set variables first if needed)"}
          disabled={pending || isArchived}
          onClick={(e) => {
            e.stopPropagation();
            onRun();
          }}
        >
          {pendingAction === "run" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="h-6 w-6"
          title={isPaused ? "Resume this routine" : "Pause this routine"}
          disabled={pending || isArchived}
          onClick={(e) => {
            e.stopPropagation();
            onSetStatus(isPaused ? "active" : "paused");
          }}
        >
          {pendingAction === "status" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : isPaused ? (
            <Play className="h-3.5 w-3.5" />
          ) : (
            <Pause className="h-3.5 w-3.5" />
          )}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="h-6 w-6" disabled={pending} onClick={(e) => e.stopPropagation()}>
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link to={`/${companyPrefix}/routines/${routine.id}`}>Open & edit…</Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onRun()} disabled={isArchived}>
              Run now (defaults)
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {isPaused ? (
              <DropdownMenuItem onSelect={() => onSetStatus("active")}>Resume</DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => onSetStatus("paused")} disabled={isArchived}>
                Pause
              </DropdownMenuItem>
            )}
            {isArchived ? (
              <DropdownMenuItem onSelect={() => onSetStatus("active")}>Unarchive</DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => onSetStatus("archived")} className="text-red-600 focus:text-red-600">
                Archive…
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

interface CompanySectionProps {
  company: Company;
  routines: RoutineListItem[];
  selectedIds: Set<string>;
  pendingByRoutineId: Map<string, "run" | "status">;
  onToggle: (id: string) => void;
  onToggleAll: (companyId: string, ids: string[]) => void;
  onRunRoutine: (routine: RoutineListItem) => void;
  onSetRoutineStatus: (routine: RoutineListItem, status: "active" | "paused" | "archived") => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

function CompanySection({
  company,
  routines,
  selectedIds,
  pendingByRoutineId,
  onToggle,
  onToggleAll,
  onRunRoutine,
  onSetRoutineStatus,
  collapsed,
  onToggleCollapse,
}: CompanySectionProps) {
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
            <RoutineRow
              key={r.id}
              routine={r}
              companyPrefix={company.issuePrefix}
              selected={selectedIds.has(r.id)}
              pendingAction={pendingByRoutineId.get(r.id) ?? null}
              onToggle={() => onToggle(r.id)}
              onRun={() => onRunRoutine(r)}
              onSetStatus={(status) => onSetRoutineStatus(r, status)}
            />
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
  const { pushToast } = useToastActions();

  useEffect(() => { setBreadcrumbs([{ label: "Portfolio Routines" }]); }, [setBreadcrumbs]);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [companyIdFilter, setCompanyIdFilter] = useState<string[]>([]);
  const [pendingByRoutineId, setPendingByRoutineId] = useState<Map<string, "run" | "status">>(new Map());
  const [confirmArchive, setConfirmArchive] = useState<{ scope: "single" | "bulk"; ids: string[] } | null>(null);

  function markPending(id: string, kind: "run" | "status") {
    setPendingByRoutineId((prev) => {
      const next = new Map(prev);
      next.set(id, kind);
      return next;
    });
  }
  function clearPending(id: string) {
    setPendingByRoutineId((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }

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

  // Build a flat id→routine map so bulk actions can look up the row's company.
  const routineById = useMemo(() => {
    const map = new Map<string, RoutineListItem>();
    for (const r of routines) map.set(r.id, r);
    return map;
  }, [routines]);

  async function invalidateAfter(routineIds: string[]) {
    const companyIds = new Set<string>();
    for (const id of routineIds) {
      const r = routineById.get(id);
      if (r) companyIds.add(r.companyId);
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["portfolio-routines"] }),
      ...Array.from(companyIds).map((cid) =>
        queryClient.invalidateQueries({ queryKey: ["routines", cid] }),
      ),
    ]);
  }

  const runMutation = useMutation({
    mutationFn: async (routine: RoutineListItem) => {
      markPending(routine.id, "run");
      return routinesApi.run(routine.id, {});
    },
    onSettled: (_data, _err, routine) => clearPending(routine.id),
    onSuccess: async (_data, routine) => {
      await invalidateAfter([routine.id]);
      pushToast({
        title: "Routine started",
        body: `${routine.title} queued. Open the routine to follow the run.`,
        tone: "success",
      });
    },
    onError: (err, routine) => {
      pushToast({
        title: `Couldn't run ${routine.title}`,
        body: err instanceof Error ? err.message : "Open the routine to run with variables.",
        tone: "error",
      });
    },
  });

  const setStatusMutation = useMutation({
    mutationFn: async ({ routine, status }: { routine: RoutineListItem; status: "active" | "paused" | "archived" }) => {
      markPending(routine.id, "status");
      return routinesApi.update(routine.id, { status });
    },
    onSettled: (_data, _err, vars) => clearPending(vars.routine.id),
    onSuccess: async (_data, { routine, status }) => {
      await invalidateAfter([routine.id]);
      const verb = status === "active" ? "resumed" : status === "paused" ? "paused" : "archived";
      pushToast({
        title: `${routine.title} ${verb}`,
        tone: "success",
      });
    },
    onError: (err, { routine }) => {
      pushToast({
        title: `Couldn't update ${routine.title}`,
        body: err instanceof Error ? err.message : "Try again.",
        tone: "error",
      });
    },
  });

  function handleRunRoutine(routine: RoutineListItem) {
    if (pendingByRoutineId.has(routine.id)) return;
    runMutation.mutate(routine);
  }

  function handleSetRoutineStatus(routine: RoutineListItem, status: "active" | "paused" | "archived") {
    if (pendingByRoutineId.has(routine.id)) return;
    if (status === "archived") {
      setConfirmArchive({ scope: "single", ids: [routine.id] });
      return;
    }
    setStatusMutation.mutate({ routine, status });
  }

  const selectedRoutines = useMemo(
    () => Array.from(selectedIds).map((id) => routineById.get(id)).filter((r): r is RoutineListItem => !!r),
    [selectedIds, routineById],
  );
  const selectedCount = selectedRoutines.length;
  const selectedNonArchived = selectedRoutines.filter((r) => r.status !== "archived");

  async function bulkApply(
    items: RoutineListItem[],
    action: "run" | "pause" | "resume" | "archive",
  ) {
    if (items.length === 0) return;
    const results = await Promise.allSettled(
      items.map(async (routine) => {
        markPending(routine.id, action === "run" ? "run" : "status");
        try {
          if (action === "run") {
            await routinesApi.run(routine.id, {});
          } else {
            const status = action === "pause" ? "paused" : action === "resume" ? "active" : "archived";
            await routinesApi.update(routine.id, { status });
          }
        } finally {
          clearPending(routine.id);
        }
      }),
    );
    await invalidateAfter(items.map((r) => r.id));
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length === 0) {
      pushToast({
        title: `${items.length} routine${items.length === 1 ? "" : "s"} ${action === "run" ? "started" : action === "pause" ? "paused" : action === "resume" ? "resumed" : "archived"}`,
        tone: "success",
      });
    } else {
      pushToast({
        title: `${failed.length} of ${items.length} failed`,
        body: failed
          .map((r) => (r.status === "rejected" && r.reason instanceof Error ? r.reason.message : "Unknown error"))
          .slice(0, 3)
          .join(" · "),
        tone: "error",
      });
    }
  }

  function handleBulk(action: "run" | "pause" | "resume" | "archive") {
    if (action === "archive") {
      setConfirmArchive({ scope: "bulk", ids: selectedNonArchived.map((r) => r.id) });
      return;
    }
    bulkApply(selectedNonArchived, action);
  }

  async function confirmArchiveNow() {
    if (!confirmArchive) return;
    const items = confirmArchive.ids
      .map((id) => routineById.get(id))
      .filter((r): r is RoutineListItem => !!r);
    setConfirmArchive(null);
    if (confirmArchive.scope === "single" && items[0]) {
      setStatusMutation.mutate({ routine: items[0], status: "archived" });
    } else {
      await bulkApply(items, "archive");
    }
  }

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
            pendingByRoutineId={pendingByRoutineId}
            onToggle={toggleId}
            onToggleAll={toggleAll}
            onRunRoutine={handleRunRoutine}
            onSetRoutineStatus={handleSetRoutineStatus}
            collapsed={collapsedIds.has(company.id)}
            onToggleCollapse={() => toggleCollapse(company.id)}
          />
        ))}
      </div>

      {selectedCount > 0 && (
        <BulkActionsBar
          count={selectedCount}
          selectedNonArchivedCount={selectedNonArchived.length}
          onRun={() => handleBulk("run")}
          onPause={() => handleBulk("pause")}
          onResume={() => handleBulk("resume")}
          onArchive={() => handleBulk("archive")}
          onClear={() => setSelectedIds(new Set())}
        />
      )}

      {confirmArchive && (
        <ArchiveConfirmDialog
          count={confirmArchive.ids.length}
          onCancel={() => setConfirmArchive(null)}
          onConfirm={confirmArchiveNow}
        />
      )}
    </div>
  );
}

interface BulkActionsBarProps {
  count: number;
  selectedNonArchivedCount: number;
  onRun: () => void;
  onPause: () => void;
  onResume: () => void;
  onArchive: () => void;
  onClear: () => void;
}

function BulkActionsBar({ count, selectedNonArchivedCount, onRun, onPause, onResume, onArchive, onClear }: BulkActionsBarProps) {
  const disabled = selectedNonArchivedCount === 0;
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-lg border border-border bg-background shadow-lg px-4 py-2.5">
      <span className="text-sm font-medium text-muted-foreground mr-1">
        {count} selected
      </span>
      <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={onRun} disabled={disabled}>
        <Play className="h-3 w-3" /> Run
      </Button>
      <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={onPause} disabled={disabled}>
        <Pause className="h-3 w-3" /> Pause
      </Button>
      <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={onResume} disabled={disabled}>
        <Play className="h-3 w-3" /> Resume
      </Button>
      <Button variant="outline" size="sm" className="h-7 text-xs gap-1 text-red-600 hover:text-red-700" onClick={onArchive} disabled={disabled}>
        <ArchiveIcon className="h-3 w-3" /> Archive
      </Button>
      <span className="text-[11px] text-muted-foreground/70 mx-1">·</span>
      <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 text-muted-foreground" onClick={onClear}>
        <X className="h-3 w-3" /> Clear
      </Button>
    </div>
  );
}

interface ArchiveConfirmDialogProps {
  count: number;
  onCancel: () => void;
  onConfirm: () => void;
}

function ArchiveConfirmDialog({ count, onCancel, onConfirm }: ArchiveConfirmDialogProps) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onCancel}
    >
      <div
        className="bg-background border border-border rounded-lg shadow-xl p-5 max-w-md w-[90vw]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold mb-2">Archive {count} routine{count === 1 ? "" : "s"}?</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Archived routines won't run on their schedule. You can unarchive them later from this page.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
          <Button variant="default" size="sm" className="bg-red-600 hover:bg-red-700 text-white" onClick={onConfirm}>
            Archive
          </Button>
        </div>
      </div>
    </div>
  );
}
