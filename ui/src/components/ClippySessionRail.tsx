import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronRight, ListFilter, MessageSquare, SquarePen } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCompanyOptional } from "../context/CompanyContext";
import { useActiveCompanyId } from "../hooks/useRouteCompany";
import { useClippySessionActions } from "../hooks/useClippySessionActions";
import {
  chatApi,
  type ChatSession,
  type ChatSessionListFilters,
  type ChatSessionSort,
  type ChatSessionStatus,
} from "../api/chat";
import { cn } from "../lib/utils";
import { ClippyChatRow, type ClippyChatRowCompany } from "./ClippyChatRow";

type LastActivity = "1d" | "7d" | "30d" | "all";
type GroupBy = "company" | "date" | "none";
type CompanyScope = "current" | "all";

export interface ClippySessionFilters {
  status: ChatSessionStatus;
  lastActivity: LastActivity;
  companyScope: CompanyScope;
  groupBy: GroupBy;
  sort: ChatSessionSort;
}

const DEFAULT_FILTERS: ClippySessionFilters = {
  status: "active",
  lastActivity: "all",
  companyScope: "all",
  groupBy: "none",
  sort: "recency",
};

const FILTERS_STORAGE_KEY = "paperclip.clippy.filters";

function readFilters(): ClippySessionFilters {
  if (typeof window === "undefined") return DEFAULT_FILTERS;
  try {
    const raw = window.localStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return DEFAULT_FILTERS;
    const parsed = JSON.parse(raw) as Partial<ClippySessionFilters>;
    return { ...DEFAULT_FILTERS, ...parsed };
  } catch {
    return DEFAULT_FILTERS;
  }
}

function writeFilters(filters: ClippySessionFilters) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(filters));
  } catch {
    /* ignore */
  }
}

function lastActivityDaysFor(v: LastActivity): number | undefined {
  if (v === "1d") return 1;
  if (v === "7d") return 7;
  if (v === "30d") return 30;
  return undefined;
}

const STATUS_LABEL: Record<ChatSessionStatus, string> = {
  active: "Active",
  archived: "Archived",
  all: "All",
};

const LAST_ACTIVITY_LABEL: Record<LastActivity, string> = {
  "1d": "1d",
  "7d": "7d",
  "30d": "30d",
  all: "All",
};

const SORT_LABEL: Record<ChatSessionSort, string> = {
  recency: "Recency",
  title: "Title",
  created: "Created",
};

const GROUP_LABEL: Record<GroupBy, string> = {
  company: "Company",
  date: "Date",
  none: "None",
};

const COMPANY_SCOPE_LABEL: Record<CompanyScope, string> = {
  current: "Current",
  all: "All",
};

export interface ClippySessionListState {
  filters: ClippySessionFilters;
  updateFilters: (patch: Partial<ClippySessionFilters>) => void;
  resetFilters: () => void;
  filtersDiffer: boolean;
  /** The query key of the list as filtered now, for putting a new chat straight into it. */
  queryKey: readonly unknown[];
  sessions: ChatSession[];
  hasCompanyContext: boolean;
}

/**
 * The full chat list with its filters, kept across reloads. The full Clippy
 * page and Clippy's full screen layout both use it, so they show the same
 * chats the same way.
 */
export function useClippySessionList(): ClippySessionListState {
  // URL-derived, not useCompany()'s selection state (P4 sweep, 2026-09-03):
  // see Calendar.tsx's/NewAgent.tsx's identical fix.
  const selectedCompanyId = useActiveCompanyId();
  const [filters, setFilters] = useState<ClippySessionFilters>(() => readFilters());

  // Persist filter state across reloads so the user doesn't re-tune on every visit.
  useEffect(() => {
    writeFilters(filters);
  }, [filters]);

  const apiFilters: ChatSessionListFilters = {
    status: filters.status,
    lastActivityDays: lastActivityDaysFor(filters.lastActivity),
    sort: filters.sort,
    // Server-side company filter only kicks in if the user picked "Current"
    // AND there's actually a selected company. Otherwise we return everything
    // and let the user see cross-company chats.
    companyId: filters.companyScope === "current" && selectedCompanyId ? selectedCompanyId : undefined,
  };
  const queryKey = ["clippy", "sessions", apiFilters] as const;

  const sessionsQuery = useQuery({
    queryKey,
    queryFn: () => chatApi.listSessions(apiFilters).then((r) => r.sessions),
  });

  return {
    filters,
    updateFilters: (patch) => setFilters((prev) => ({ ...prev, ...patch })),
    resetFilters: () => setFilters(DEFAULT_FILTERS),
    filtersDiffer: JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS),
    queryKey,
    sessions: sessionsQuery.data ?? [],
    hasCompanyContext: Boolean(selectedCompanyId),
  };
}

interface ClippySessionRailProps {
  list: ClippySessionListState;
  /** The open chat. Null while a new chat is being written. */
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onDeleted?: (id: string) => void;
  onArchiveChanged?: (session: ChatSession) => void;
  /** Hide the "Clippy" title row's name where the surrounding window already says it. */
  showTitle?: boolean;
  className?: string;
}

/**
 * The list of every chat beside a conversation: new chat and filters at the
 * top, then the chats, optionally grouped by company or date.
 */
export function ClippySessionRail({
  list,
  activeId,
  onSelect,
  onNewChat,
  onDeleted,
  onArchiveChanged,
  showTitle = true,
  className,
}: ClippySessionRailProps) {
  const companies = useCompanyOptional()?.companies ?? [];
  const { filters, sessions, filtersDiffer } = list;
  const actions = useClippySessionActions({ onDeleted, onArchiveChanged });

  const companyById = useMemo(() => {
    const map = new Map<string, ClippyChatRowCompany>();
    for (const c of companies) map.set(c.id, { name: c.name, brandColor: c.brandColor });
    return map;
  }, [companies]);

  const grouped = useMemo(() => groupSessions(sessions, filters.groupBy, companyById), [sessions, filters.groupBy, companyById]);

  return (
    <aside aria-label="Chats" className={cn("flex w-64 shrink-0 flex-col border-r border-border bg-background", className)}>
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        {showTitle ? (
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            <MessageSquare className="h-4 w-4" />
            Clippy
          </div>
        ) : (
          <div className="text-xs font-medium text-muted-foreground">Chats</div>
        )}
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={onNewChat} title="New chat">
            <SquarePen className="mr-1 h-3.5 w-3.5" /> New
          </Button>
          <FilterMenu
            filters={filters}
            onChange={list.updateFilters}
            onClear={list.resetFilters}
            hasActiveFilters={filtersDiffer}
            hasCompanyContext={list.hasCompanyContext}
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          <div className="px-3 py-4 text-xs text-muted-foreground">
            {filters.status === "archived"
              ? "No archived chats."
              : filtersDiffer
                ? "No chats match the current filters."
                : "No chats yet."}
          </div>
        ) : (
          grouped.map((group) => (
            <div key={group.key}>
              {group.label && (
                <div className="sticky top-0 z-[1] border-b border-border/60 bg-muted/50 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </div>
              )}
              <ul className="flex flex-col gap-0.5 p-1.5">
                {group.items.map((s) => (
                  <ClippyChatRow
                    key={s.id}
                    session={s}
                    // Grouped by company, the heading already names it.
                    company={filters.groupBy !== "company" && s.companyId ? companyById.get(s.companyId) ?? null : null}
                    active={s.id === activeId}
                    onSelect={() => onSelect(s.id)}
                    onRename={(title) => actions.rename(s.id, title)}
                    onArchiveToggle={() => actions.setArchived(s.id, !s.archivedAt)}
                    onDelete={() => actions.remove(s.id)}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

interface SessionGroup {
  key: string;
  label: string | null;
  items: ChatSession[];
}

function groupSessions(
  sessions: ChatSession[],
  groupBy: GroupBy,
  companyById: Map<string, ClippyChatRowCompany>,
): SessionGroup[] {
  if (groupBy === "none") {
    return [{ key: "all", label: null, items: sessions }];
  }
  if (groupBy === "company") {
    const buckets = new Map<string, SessionGroup>();
    for (const s of sessions) {
      const id = s.companyId ?? "__none__";
      const label =
        s.companyId === null
          ? "No company"
          : companyById.get(s.companyId)?.name ?? "Unknown company";
      const existing = buckets.get(id);
      if (existing) existing.items.push(s);
      else buckets.set(id, { key: id, label, items: [s] });
    }
    return [...buckets.values()].sort((a, b) => (a.label ?? "").localeCompare(b.label ?? ""));
  }
  // group by date
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const buckets: Record<string, SessionGroup> = {
    today: { key: "today", label: "Today", items: [] },
    yesterday: { key: "yesterday", label: "Yesterday", items: [] },
    week: { key: "week", label: "This week", items: [] },
    month: { key: "month", label: "This month", items: [] },
    earlier: { key: "earlier", label: "Earlier", items: [] },
  };
  for (const s of sessions) {
    const ts = new Date(s.updatedAt).getTime();
    const ageDays = (now - ts) / day;
    if (ageDays < 1) buckets.today.items.push(s);
    else if (ageDays < 2) buckets.yesterday.items.push(s);
    else if (ageDays < 7) buckets.week.items.push(s);
    else if (ageDays < 30) buckets.month.items.push(s);
    else buckets.earlier.items.push(s);
  }
  return Object.values(buckets).filter((g) => g.items.length > 0);
}

function FilterMenu({
  filters,
  onChange,
  onClear,
  hasActiveFilters,
  hasCompanyContext,
}: {
  filters: ClippySessionFilters;
  onChange: (patch: Partial<ClippySessionFilters>) => void;
  onClear: () => void;
  hasActiveFilters: boolean;
  hasCompanyContext: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          className="relative"
          aria-label="Filter and sort"
          title="Filter and sort"
        >
          <ListFilter className="h-4 w-4" />
          {hasActiveFilters && (
            <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-primary" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Filters
        </DropdownMenuLabel>

        <FilterSubmenu
          label="Status"
          value={STATUS_LABEL[filters.status]}
          options={(["active", "archived", "all"] as const).map((v) => ({
            value: v,
            label: STATUS_LABEL[v],
          }))}
          selected={filters.status}
          onSelect={(v) => onChange({ status: v })}
        />

        <FilterSubmenu
          label="Company"
          value={
            filters.companyScope === "current" && !hasCompanyContext
              ? "All"
              : COMPANY_SCOPE_LABEL[filters.companyScope]
          }
          options={[
            { value: "all" as const, label: "All companies" },
            {
              value: "current" as const,
              label: hasCompanyContext ? "Current company" : "Current (none selected)",
              disabled: !hasCompanyContext,
            },
          ]}
          selected={filters.companyScope}
          onSelect={(v) => onChange({ companyScope: v })}
        />

        <FilterSubmenu
          label="Last activity"
          value={LAST_ACTIVITY_LABEL[filters.lastActivity]}
          options={(["1d", "7d", "30d", "all"] as const).map((v) => ({
            value: v,
            label: LAST_ACTIVITY_LABEL[v],
          }))}
          selected={filters.lastActivity}
          onSelect={(v) => onChange({ lastActivity: v })}
        />

        <DropdownMenuSeparator />

        <FilterSubmenu
          label="Group by"
          value={GROUP_LABEL[filters.groupBy]}
          options={(["company", "date", "none"] as const).map((v) => ({
            value: v,
            label: GROUP_LABEL[v],
          }))}
          selected={filters.groupBy}
          onSelect={(v) => onChange({ groupBy: v })}
        />

        <FilterSubmenu
          label="Sort by"
          value={SORT_LABEL[filters.sort]}
          options={(["recency", "title", "created"] as const).map((v) => ({
            value: v,
            label: SORT_LABEL[v],
          }))}
          selected={filters.sort}
          onSelect={(v) => onChange({ sort: v })}
        />

        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onClear}
          disabled={!hasActiveFilters}
          className="text-xs"
        >
          Clear filters
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FilterSubmenu<T extends string>({
  label,
  value,
  options,
  selected,
  onSelect,
}: {
  label: string;
  value: string;
  options: Array<{ value: T; label: string; disabled?: boolean }>;
  selected: T;
  onSelect: (v: T) => void;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="flex items-center justify-between gap-4 text-xs">
        <span>{label}</span>
        <span className="flex items-center gap-1 text-muted-foreground">
          {value}
          <ChevronRight className="h-3 w-3" />
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-44">
        {options.map((opt) => (
          <DropdownMenuItem
            key={opt.value}
            disabled={opt.disabled}
            onSelect={() => onSelect(opt.value)}
            className="flex items-center justify-between text-xs"
          >
            <span>{opt.label}</span>
            {selected === opt.value && <Check className="h-3 w-3" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
