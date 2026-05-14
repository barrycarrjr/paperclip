import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronRight,
  ListFilter,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { useCompany } from "../context/CompanyContext";
import {
  chatApi,
  type ChatSession,
  type ChatSessionListFilters,
  type ChatSessionSort,
  type ChatSessionStatus,
} from "../api/chat";
import { ClippyConversation } from "../components/ClippyConversation";
import { cn } from "../lib/utils";

type LastActivity = "1d" | "7d" | "30d" | "all";
type GroupBy = "company" | "date" | "none";
type CompanyScope = "current" | "all";

interface Filters {
  status: ChatSessionStatus;
  lastActivity: LastActivity;
  companyScope: CompanyScope;
  groupBy: GroupBy;
  sort: ChatSessionSort;
}

const DEFAULT_FILTERS: Filters = {
  status: "active",
  lastActivity: "all",
  companyScope: "all",
  groupBy: "none",
  sort: "recency",
};

const FILTERS_STORAGE_KEY = "paperclip.clippy.filters";

function readFilters(): Filters {
  if (typeof window === "undefined") return DEFAULT_FILTERS;
  try {
    const raw = window.localStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return DEFAULT_FILTERS;
    const parsed = JSON.parse(raw) as Partial<Filters>;
    return { ...DEFAULT_FILTERS, ...parsed };
  } catch {
    return DEFAULT_FILTERS;
  }
}

function writeFilters(filters: Filters) {
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

export function Clippy() {
  const qc = useQueryClient();
  const { selectedCompanyId, companies } = useCompany();
  const [filters, setFilters] = useState<Filters>(() => readFilters());

  // Persist filter state across reloads so the user doesn't re-tune on every visit.
  useEffect(() => {
    writeFilters(filters);
  }, [filters]);

  const updateFilters = (patch: Partial<Filters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
  };

  const apiFilters: ChatSessionListFilters = {
    status: filters.status,
    lastActivityDays: lastActivityDaysFor(filters.lastActivity),
    sort: filters.sort,
    // Server-side company filter only kicks in if the user picked "Current"
    // AND there's actually a selected company. Otherwise we return everything
    // and let the user see cross-company chats.
    companyId:
      filters.companyScope === "current" && selectedCompanyId ? selectedCompanyId : undefined,
  };

  const sessionsQuery = useQuery({
    queryKey: ["clippy", "sessions", apiFilters],
    queryFn: () => chatApi.listSessions(apiFilters).then((r) => r.sessions),
  });
  const sessions = sessionsQuery.data ?? [];

  const initialSessionFromUrl = useMemo(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    return params.get("session");
  }, []);
  const [activeId, setActiveId] = useState<string | null>(initialSessionFromUrl);

  useEffect(() => {
    if (activeId) return;
    if (sessions.length > 0) setActiveId(sessions[0].id);
  }, [activeId, sessions]);

  const createMutation = useMutation({
    mutationFn: () =>
      chatApi
        .createSession({
          companyId: selectedCompanyId ?? null,
          pageContext: window.location.pathname,
        })
        .then((r) => r.session),
    onSuccess: (session) => {
      qc.invalidateQueries({ queryKey: ["clippy", "sessions"] });
      setActiveId(session.id);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => chatApi.deleteSession(id),
    onSuccess: (_, deletedId) => {
      qc.invalidateQueries({ queryKey: ["clippy", "sessions"] });
      if (activeId === deletedId) setActiveId(null);
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      chatApi.patchSession(id, { title }).then((r) => r.session),
    onSuccess: (session) => {
      qc.setQueryData(["clippy", "session", session.id], session);
      qc.invalidateQueries({ queryKey: ["clippy", "sessions"] });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      chatApi.patchSession(id, { archived }).then((r) => r.session),
    onSuccess: (session) => {
      qc.setQueryData(["clippy", "session", session.id], session);
      qc.invalidateQueries({ queryKey: ["clippy", "sessions"] });
      // Drop the active session if archiving made it disappear from the
      // current filter. The user can switch filters or pick another chat.
      if (activeId === session.id && filters.status === "active" && session.archivedAt) {
        setActiveId(null);
      }
    },
  });

  const companyNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of companies) map.set(c.id, c.name);
    return map;
  }, [companies]);

  const grouped = useMemo(
    () => groupSessions(sessions, filters.groupBy, companyNameById),
    [sessions, filters.groupBy, companyNameById],
  );

  const filtersDiffer = JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS);

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-background">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            <MessageSquare className="h-4 w-4" />
            Clippy
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending}
              title="New chat"
            >
              <Plus className="mr-1 h-3 w-3" /> New
            </Button>
            <FilterMenu
              filters={filters}
              onChange={updateFilters}
              onClear={() => setFilters(DEFAULT_FILTERS)}
              hasActiveFilters={filtersDiffer}
              hasCompanyContext={Boolean(selectedCompanyId)}
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
                <ul className="flex flex-col">
                  {group.items.map((s) => (
                    <SessionRailItem
                      key={s.id}
                      session={s}
                      active={s.id === activeId}
                      onClick={() => setActiveId(s.id)}
                      onRename={(title) => renameMutation.mutate({ id: s.id, title })}
                      onArchiveToggle={() =>
                        archiveMutation.mutate({ id: s.id, archived: !s.archivedAt })
                      }
                      onDelete={() => deleteMutation.mutate(s.id)}
                    />
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <ClippyConversation sessionId={activeId} />
      </main>
    </div>
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
  companyNameById: Map<string, string>,
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
          : companyNameById.get(s.companyId) ?? "Unknown company";
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
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
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

function SessionRailItem({
  session,
  active,
  onClick,
  onDelete,
  onRename,
  onArchiveToggle,
}: {
  session: ChatSession;
  active: boolean;
  onClick: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
  onArchiveToggle: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isArchived = Boolean(session.archivedAt);

  useEffect(() => {
    if (!renaming) return;
    const id = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(id);
  }, [renaming]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed.length > 0 && trimmed !== session.title) {
      onRename(trimmed);
    }
    setRenaming(false);
  };

  return (
    <li>
      <div
        className={cn(
          "group flex items-center gap-2 px-3 py-2 text-xs",
          active ? "bg-accent" : "hover:bg-accent/50",
          isArchived && "opacity-60",
        )}
      >
        {renaming ? (
          <Input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setDraft(session.title);
                setRenaming(false);
              }
            }}
            className="h-7 min-w-0 flex-1 px-2 text-xs"
            aria-label="Rename chat"
          />
        ) : (
          <button
            type="button"
            onClick={onClick}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setDraft(session.title);
              setRenaming(true);
            }}
            className="min-w-0 flex-1 truncate text-left"
            title={`${session.title} — double-click to rename`}
          >
            <div className="truncate font-medium">{session.title}</div>
            <div className="truncate text-[10px] text-muted-foreground">
              {isArchived ? "Archived · " : ""}
              {session.model}
            </div>
          </button>
        )}
        {!renaming && (
          <>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onArchiveToggle();
              }}
              className="invisible text-muted-foreground hover:text-foreground group-hover:visible"
              title={isArchived ? "Unarchive" : "Archive"}
              aria-label={isArchived ? "Unarchive chat" : "Archive chat"}
            >
              {isArchived ? (
                <ArchiveRestore className="h-3.5 w-3.5" />
              ) : (
                <Archive className="h-3.5 w-3.5" />
              )}
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => e.stopPropagation()}
                  className="invisible text-muted-foreground hover:text-foreground group-hover:visible data-[state=open]:visible"
                  title="More"
                  aria-label="More actions"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuItem
                  onSelect={() => {
                    setDraft(session.title);
                    setRenaming(true);
                  }}
                  className="text-xs"
                >
                  <Pencil className="mr-2 h-3 w-3" /> Rename
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onArchiveToggle()} className="text-xs">
                  {isArchived ? (
                    <>
                      <ArchiveRestore className="mr-2 h-3 w-3" /> Unarchive
                    </>
                  ) : (
                    <>
                      <Archive className="mr-2 h-3 w-3" /> Archive
                    </>
                  )}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    if (window.confirm(`Delete "${session.title}" permanently?`)) onDelete();
                  }}
                  className="text-xs text-destructive focus:text-destructive"
                >
                  <Trash2 className="mr-2 h-3 w-3" /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
    </li>
  );
}
