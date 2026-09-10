import { useState, useMemo, useEffect, useCallback, type ReactNode } from "react";
import { useQueries, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Heart, Pencil, Plus, Users } from "lucide-react";
import type { Agent, AgentRole, AgentStatus, Company } from "@paperclipai/shared";
import { AGENT_ROLES, AGENT_STATUSES, AGENT_ROLE_LABELS } from "@paperclipai/shared";
import { agentsApi, type OrgNode } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { useActiveCompanyId } from "../hooks/useRouteCompany";
import { usePortfolioCompanyOptions } from "../hooks/usePortfolioCompanyOptions";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { LiveRunIndicator } from "../components/LiveRunIndicator";
import { OrgTreeNode } from "../components/OrgTreeNode";
import {
  CompanyRoutePrefixProvider,
  Link,
  Outlet,
  useLocation,
  useNavigate,
} from "@/lib/router";
import { timeAgo } from "../lib/timeAgo";
import { agentStatusDot, agentStatusDotDefault } from "../lib/status-colors";
import { getAdapterLabel } from "../adapters/adapter-display-registry";
import { agentRouteRef } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "../lib/utils";
import { readLsFilter, writeLsFilter } from "../lib/persistFilter";
import { Tabs } from "@/components/ui/tabs";
import { PageTabBar } from "../components/PageTabBar";
import { TeamCurrentWork } from "../components/TeamCurrentWork";
import { TeamActivityTimeline } from "../components/TeamActivityTimeline";
import { EntityRow } from "../components/EntityRow";
import { StatusBadge } from "../components/StatusBadge";
import {
  PORTFOLIO_TEAM_DEFAULT_TAB,
  PORTFOLIO_TEAM_TABS,
  portfolioTeamTabForPath,
  type PortfolioTeamTab,
} from "../lib/portfolio-team-tabs";

// Keep the original storage keys so the Teams transition does not throw away
// an operator's saved filters from the screen's previous name.
const LS_STATUS_KEY = "paperclip:portfolio-agents:statusFilter";
const LS_ROLE_KEY = "paperclip:portfolio-agents:roleFilter";
const LS_COMPANY_KEY = "paperclip:portfolio-agents:companyFilter";

const VISIBLE_STATUSES: AgentStatus[] = AGENT_STATUSES.filter((s) => s !== "terminated");

function statusLabel(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Org tree is fetched per-company from an unfiltered endpoint, so when
// status/role filters are active we trim it client-side against the filtered
// agent set. Surviving descendants are promoted past any dropped ancestor so a
// matching agent stays visible even when its manager is filtered out.
function filterOrgTree(nodes: OrgNode[], keepIds: Set<string>): OrgNode[] {
  const result: OrgNode[] = [];
  for (const node of nodes) {
    const filteredReports = filterOrgTree(node.reports ?? [], keepIds);
    if (keepIds.has(node.id)) {
      result.push({ ...node, reports: filteredReports });
    } else {
      result.push(...filteredReports);
    }
  }
  return result;
}

interface FilterOption {
  value: string;
  label: string;
}

interface FilterPopoverProps {
  label: string;
  options: FilterOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}

function FilterPopover({ label, options, selected, onChange }: FilterPopoverProps) {
  function toggle(value: string) {
    onChange(
      selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value],
    );
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
            selected.length > 0 &&
              selected.length < options.length &&
              "border-primary/50 text-primary",
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
            <Checkbox
              checked={selected.includes(opt.value)}
              onCheckedChange={() => toggle(opt.value)}
              className="h-3.5 w-3.5"
            />
            <span className="flex-1 text-left">{opt.label}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

interface TeamMemberRowProps {
  agent: Agent;
  companyPrefix: string;
  selected: boolean;
  liveRun: { runId: string; liveCount: number } | null;
  onToggle: () => void;
}

function PortfolioTeamMemberRow({
  agent,
  companyPrefix,
  selected,
  liveRun,
  onToggle,
}: TeamMemberRowProps) {
  const dotClass = agentStatusDot[agent.status] ?? agentStatusDotDefault;
  const heartbeatLabel = agent.lastHeartbeatAt ? timeAgo(agent.lastHeartbeatAt) : null;
  const adapterLabel = getAdapterLabel(agent.adapterType);

  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent/40 rounded group",
        selected && "bg-accent/60",
        agent.pausedAt && "opacity-60",
      )}
    >
      <Checkbox
        checked={selected}
        onCheckedChange={onToggle}
        className="h-3.5 w-3.5 opacity-0 group-hover:opacity-100 transition-opacity data-[state=checked]:opacity-100"
      />

      <span className={cn("h-2 w-2 rounded-full shrink-0", dotClass)} />

      <span className="text-[10px] font-semibold uppercase text-muted-foreground shrink-0 w-14 hidden sm:block">
        {AGENT_ROLE_LABELS[agent.role as AgentRole] ?? agent.role}
      </span>

      <Link
        to={`/${companyPrefix}/agents/${agent.id}`}
        className="flex-1 min-w-0 hover:underline"
      >
        <div className="truncate font-medium">{agent.name}</div>
        {agent.title && (
          <div className="truncate text-[11px] text-muted-foreground/80 font-normal">
            {agent.title}
          </div>
        )}
      </Link>

      {liveRun && (
        <LiveRunIndicator
          agentRef={agentRouteRef(agent)}
          runId={liveRun.runId}
          liveCount={liveRun.liveCount}
        />
      )}

      <span className="hidden lg:block w-28 text-right font-mono text-[11px] text-muted-foreground/80 truncate">
        {adapterLabel}
      </span>

      <Tooltip>
        <TooltipTrigger asChild>
          <span className="text-[11px] text-muted-foreground shrink-0 w-20 text-right inline-flex items-center justify-end gap-1 cursor-default">
            <Heart className="h-2.5 w-2.5" aria-hidden />
            {heartbeatLabel ?? "—"}
          </span>
        </TooltipTrigger>
        <TooltipContent side="left" className="text-xs">
          {agent.lastHeartbeatAt
            ? `Last heartbeat ${new Date(agent.lastHeartbeatAt).toLocaleString()}`
            : "Never reported a heartbeat"}
          {" · "}
          <span className="opacity-70">{statusLabel(agent.status)}</span>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

interface TeamSectionHeaderProps {
  company: Company;
  agents: Agent[];
  liveRunByAgent: Map<string, { runId: string; liveCount: number }>;
  collapsed: boolean;
  onToggleCollapse: () => void;
  hasMemberFilters: boolean;
  selectedIds?: Set<string>;
  onToggleAll?: (companyId: string, agentIds: string[]) => void;
  openPath?: string;
  openTitle?: string;
  countNoun?: string;
  addPath?: string;
  addLabel?: string;
}

function TeamSectionHeader({
  company,
  agents,
  liveRunByAgent,
  collapsed,
  onToggleCollapse,
  hasMemberFilters,
  selectedIds,
  onToggleAll,
  openPath,
  openTitle = "Team",
  countNoun = "member",
  addPath,
  addLabel = "agent",
}: TeamSectionHeaderProps) {
  const agentIds = agents.map((a) => a.id);
  const allSelected =
    Boolean(selectedIds) && agentIds.length > 0 && agentIds.every((id) => selectedIds!.has(id));
  const someSelected =
    Boolean(selectedIds) && !allSelected && agentIds.some((id) => selectedIds!.has(id));
  const liveCount = agentIds.filter((id) => liveRunByAgent.has(id)).length;
  const pausedCount = agents.filter((agent) => agent.status === "paused").length;
  const errorCount = agents.filter((agent) => agent.status === "error").length;
  const membersLabel = `${agents.length}${hasMemberFilters ? " matching" : ""} ${countNoun}${
    agents.length === 1 ? "" : "s"
  }`;
  const memberPanelId = `portfolio-team-${company.id}`;

  return (
    <div className="flex min-w-0 items-center gap-2 px-3 py-3 group">
      {selectedIds && onToggleAll && (
        <Checkbox
          checked={someSelected ? "indeterminate" : allSelected}
          onCheckedChange={() => onToggleAll(company.id, agentIds)}
          aria-label={`Select all members of ${company.name}`}
          className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=checked]:opacity-100 data-[state=indeterminate]:opacity-100"
        />
      )}

      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        onClick={onToggleCollapse}
        aria-expanded={!collapsed}
        aria-controls={memberPanelId}
      >
        {collapsed ? (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <CompanyPatternIcon
          companyName={company.name}
          logoUrl={company.logoUrl}
          brandColor={company.brandColor}
          className="h-8 w-8 shrink-0 rounded-md"
        />
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{company.name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            Team · {membersLabel}
          </span>
        </span>
      </button>

      <div
        className="hidden shrink-0 items-center gap-1.5 lg:flex"
        aria-label={`${company.name} team status`}
      >
        {liveCount > 0 && (
          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
            {liveCount} live
          </span>
        )}
        {pausedCount > 0 && (
          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
            {pausedCount} paused
          </span>
        )}
        {errorCount > 0 && (
          <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
            {errorCount} error{errorCount === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <Button variant="outline" size="sm" className="h-7 shrink-0 gap-1.5 px-2 text-xs" asChild>
        <Link
          to={openPath ?? `/${company.issuePrefix}/team`}
          title={`Open ${company.name} ${openTitle}`}
        >
          <Users className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Open team</span>
        </Link>
      </Button>
      {addPath && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="h-7 w-7 shrink-0 text-muted-foreground"
          asChild
        >
          <Link
            to={addPath}
            title={`Add an ${addLabel} to ${company.name}`}
            aria-label={`Add an ${addLabel} to ${company.name}`}
          >
            <Plus className="h-3.5 w-3.5" />
          </Link>
        </Button>
      )}
    </div>
  );
}

interface TeamSectionProps {
  company: Company;
  agents: Agent[];
  selectedIds: Set<string>;
  liveRunByAgent: Map<string, { runId: string; liveCount: number }>;
  onToggleAgent: (id: string) => void;
  onToggleAll: (companyId: string, agentIds: string[]) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  hasMemberFilters: boolean;
}

function PortfolioTeamSection({
  company,
  agents,
  selectedIds,
  liveRunByAgent,
  onToggleAgent,
  onToggleAll,
  collapsed,
  onToggleCollapse,
  hasMemberFilters,
}: TeamSectionProps) {
  return (
    <section className="mb-3 overflow-hidden rounded-lg border border-border bg-background">
      <TeamSectionHeader
        company={company}
        agents={agents}
        liveRunByAgent={liveRunByAgent}
        selectedIds={selectedIds}
        onToggleAll={onToggleAll}
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        hasMemberFilters={hasMemberFilters}
        openPath={`/${company.issuePrefix}/agents/all`}
        openTitle="Agents"
        addPath={`/${company.issuePrefix}/agents/new`}
      />

      {!collapsed && (
        <div
          id={`portfolio-team-${company.id}`}
          className="border-t border-border bg-muted/10 p-2 sm:pl-10"
        >
          {agents.map((agent) => (
            <PortfolioTeamMemberRow
              key={agent.id}
              agent={agent}
              companyPrefix={company.issuePrefix}
              selected={selectedIds.has(agent.id)}
              liveRun={liveRunByAgent.get(agent.id) ?? null}
              onToggle={() => onToggleAgent(agent.id)}
            />
          ))}
          {agents.length === 0 && (
            <p className="px-3 py-3 text-sm text-muted-foreground">
              {hasMemberFilters
                ? "No team members match the current filters."
                : "This team has no agents yet."}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

interface BulkActionsBarProps {
  count: number;
  onPause: () => void;
  onResume: () => void;
  onClear: () => void;
  isPending: boolean;
}

function BulkActionsBar({ count, onPause, onResume, onClear, isPending }: BulkActionsBarProps) {
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-lg border border-border bg-background shadow-lg px-4 py-2.5">
      <span className="text-sm font-medium text-muted-foreground mr-1">
        {count} selected
      </span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1" disabled={isPending}>
            Pause
            <ChevronDown className="h-3 w-3 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" side="top" className="mb-1">
          <DropdownMenuItem onSelect={onPause}>Pause selected</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1" disabled={isPending}>
            Resume
            <ChevronDown className="h-3 w-3 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" side="top" className="mb-1">
          <DropdownMenuItem onSelect={onResume}>Resume selected</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        variant="ghost"
        size="sm"
        className="h-7 text-xs text-muted-foreground"
        onClick={onClear}
      >
        ✕ Deselect
      </Button>
    </div>
  );
}

function PortfolioTeamsRoster({ forcedView }: { forcedView: "list" | "org" }) {
  // URL-derived, not useCompany()'s selection state (P3 audit, 2026-09-03) —
  // see Calendar.tsx's identical fix for the general pattern.
  const selectedCompanyId = useActiveCompanyId();
  const queryClient = useQueryClient();

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<AgentStatus[]>(() =>
    readLsFilter<AgentStatus[]>(LS_STATUS_KEY, []),
  );
  const [roleFilter, setRoleFilter] = useState<AgentRole[]>(() =>
    readLsFilter<AgentRole[]>(LS_ROLE_KEY, []),
  );
  const [companyIdFilter, setCompanyIdFilter] = useState<string[]>(() =>
    readLsFilter<string[]>(LS_COMPANY_KEY, []),
  );
  useEffect(() => { writeLsFilter(LS_STATUS_KEY, statusFilter); }, [statusFilter]);
  useEffect(() => { writeLsFilter(LS_ROLE_KEY, roleFilter); }, [roleFilter]);
  useEffect(() => { writeLsFilter(LS_COMPANY_KEY, companyIdFilter); }, [companyIdFilter]);
  const view = forcedView;

  const { data, isLoading } = useQuery({
    queryKey: ["portfolio-agents", selectedCompanyId, statusFilter, roleFilter, companyIdFilter],
    queryFn: () =>
      agentsApi.listPortfolio(selectedCompanyId!, {
        statuses: statusFilter.length > 0 ? statusFilter : undefined,
        roles: roleFilter.length > 0 ? roleFilter : undefined,
        companyIds: companyIdFilter.length > 0 ? companyIdFilter : undefined,
      }),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const agents = data?.agents ?? [];
  const companies = useMemo(() => {
    const raw = data?.companies ?? [];
    return [...raw].sort((a, b) => (b.isPortfolioRoot ? 1 : 0) - (a.isPortfolioRoot ? 1 : 0));
  }, [data?.companies]);
  const hasMemberFilters = statusFilter.length > 0 || roleFilter.length > 0;
  const hasFilters = hasMemberFilters || companyIdFilter.length > 0;

  // Not `companies`: that list is what came back through the company filter,
  // so sourcing the filter's own options from it collapses the menu to the one
  // company already picked.
  const companyOptions = usePortfolioCompanyOptions();

  const agentsByCompany = useMemo(() => {
    const map = new Map<string, Agent[]>();
    for (const company of companies) map.set(company.id, []);
    for (const agent of agents) {
      const list = map.get(agent.companyId);
      if (list) list.push(agent);
    }
    return map;
  }, [agents, companies]);

  // Live runs are queried per-company (no portfolio endpoint). Each result is
  // an array of running/queued runs we use to pulse a "Live" indicator on the
  // row. 15s refetch matches the per-company Agents page.
  const liveRunQueries = useQueries({
    queries: companies.map((c) => ({
      queryKey: ["portfolio-agents", "live-runs", c.id],
      queryFn: () => heartbeatsApi.liveRunsForCompany(c.id),
      enabled: !!c.id,
      refetchInterval: 15_000,
    })),
  });

  const liveRunByAgent = useMemo(() => {
    const map = new Map<string, { runId: string; liveCount: number }>();
    companies.forEach((_company, idx) => {
      const runs = liveRunQueries[idx]?.data ?? [];
      for (const r of runs) {
        if (r.status !== "running" && r.status !== "queued") continue;
        const existing = map.get(r.agentId);
        if (existing) {
          existing.liveCount += 1;
          continue;
        }
        map.set(r.agentId, { runId: r.id, liveCount: 1 });
      }
    });
    return map;
  }, [companies, liveRunQueries]);

  // Org tree per-company — only fetched when the operator picks "Org" view.
  // Result feeds the per-company OrgTreeNode renderer.
  const orgQueries = useQueries({
    queries: companies.map((c) => ({
      queryKey: ["portfolio-agents", "org", c.id],
      queryFn: () => agentsApi.org(c.id),
      enabled: !!c.id && view === "org",
      staleTime: 60_000,
    })),
  });
  const orgByCompanyId = useMemo(() => {
    const map = new Map<string, OrgNode[] | undefined>();
    companies.forEach((c, idx) => {
      map.set(c.id, orgQueries[idx]?.data);
    });
    return map;
  }, [companies, orgQueries]);

  // Agent lookup for the org tree (it shows adapter / heartbeat info
  // pulled from the full Agent record, not the slim OrgNode).
  const agentById = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents) map.set(a.id, a);
    return map;
  }, [agents]);

  const pauseMutation = useMutation({
    mutationFn: (id: string) => {
      const companyId = agentById.get(id)?.companyId;
      return agentsApi.pause(id, companyId);
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["portfolio-agents", selectedCompanyId] }),
  });

  const resumeMutation = useMutation({
    mutationFn: (id: string) => {
      const companyId = agentById.get(id)?.companyId;
      return agentsApi.resume(id, companyId);
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["portfolio-agents", selectedCompanyId] }),
  });

  const isMutating = pauseMutation.isPending || resumeMutation.isPending;

  function handleToggleAgent(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleToggleAll(companyId: string, agentIds: string[]) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = agentIds.every((id) => next.has(id));
      if (allSelected) agentIds.forEach((id) => next.delete(id));
      else agentIds.forEach((id) => next.add(id));
      return next;
    });
  }

  function handleToggleCollapse(companyId: string) {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(companyId)) next.delete(companyId);
      else next.add(companyId);
      return next;
    });
  }

  async function handleBulkPause() {
    await Promise.all(Array.from(selectedIds).map((id) => pauseMutation.mutateAsync(id)));
    queryClient.invalidateQueries({ queryKey: ["portfolio-agents", selectedCompanyId] });
    setSelectedIds(new Set());
  }

  async function handleBulkResume() {
    await Promise.all(Array.from(selectedIds).map((id) => resumeMutation.mutateAsync(id)));
    queryClient.invalidateQueries({ queryKey: ["portfolio-agents", selectedCompanyId] });
    setSelectedIds(new Set());
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex shrink-0 flex-col gap-2 border-b border-border px-6 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold">{view === "list" ? "Agents" : "Org chart"}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {view === "list"
              ? "Every agent grouped under the company team that owns it."
              : "Reporting lines shown separately for each company team."}
          </p>
        </div>
        <span className="shrink-0 text-sm text-muted-foreground">
          {isLoading
            ? "Loading…"
            : `${companies.length} team${companies.length === 1 ? "" : "s"} · ${
                agents.length
              }${hasMemberFilters ? " matching" : ""} member${agents.length === 1 ? "" : "s"}`}
        </span>
      </div>

      <div className="flex items-center gap-2 px-6 py-2.5 border-b border-border shrink-0 flex-wrap">
        <FilterPopover
          label="Member status"
          options={VISIBLE_STATUSES.map((s) => ({ value: s, label: statusLabel(s) }))}
          selected={statusFilter}
          onChange={(next) => setStatusFilter(next as AgentStatus[])}
        />
        <FilterPopover
          label="Member role"
          options={AGENT_ROLES.map((r) => ({ value: r, label: AGENT_ROLE_LABELS[r] }))}
          selected={roleFilter}
          onChange={(next) => setRoleFilter(next as AgentRole[])}
        />
        {companyOptions.length > 0 && (
          <FilterPopover
            label="Team"
            options={companyOptions}
            selected={companyIdFilter}
            onChange={setCompanyIdFilter}
          />
        )}
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground"
            onClick={() => {
              setStatusFilter([]);
              setRoleFilter([]);
              setCompanyIdFilter([]);
            }}
          >
            Clear filters
          </Button>
        )}

      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-3">
        {isLoading && (
          <p className="text-sm text-muted-foreground">Loading teams…</p>
        )}

        {!isLoading && companies.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <Users className="h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No teams found.</p>
          </div>
        )}

        {!isLoading && view === "list" &&
          companies.map((company) => {
            const companyAgents = agentsByCompany.get(company.id) ?? [];
            return (
              <PortfolioTeamSection
                key={company.id}
                company={company}
                agents={companyAgents}
                selectedIds={selectedIds}
                liveRunByAgent={liveRunByAgent}
                onToggleAgent={handleToggleAgent}
                onToggleAll={handleToggleAll}
                collapsed={collapsedIds.has(company.id)}
                onToggleCollapse={() => handleToggleCollapse(company.id)}
                hasMemberFilters={hasMemberFilters}
              />
            );
          })}

        {!isLoading && view === "org" &&
          companies.map((company) => {
            const rawOrgNodes = orgByCompanyId.get(company.id);
            const orgLoading = !orgByCompanyId.has(company.id) || rawOrgNodes === undefined;
            const companyAgents = agentsByCompany.get(company.id) ?? [];
            const orgNodes = hasMemberFilters
              ? filterOrgTree(rawOrgNodes ?? [], new Set(companyAgents.map((a) => a.id)))
              : (rawOrgNodes ?? []);
            const collapsed = collapsedIds.has(company.id);
            return (
              <section
                key={company.id}
                className="mb-3 overflow-hidden rounded-lg border border-border bg-background"
              >
                <TeamSectionHeader
                  company={company}
                  agents={companyAgents}
                  liveRunByAgent={liveRunByAgent}
                  collapsed={collapsed}
                  onToggleCollapse={() => handleToggleCollapse(company.id)}
                  hasMemberFilters={hasMemberFilters}
                  openPath={`/${company.issuePrefix}/org`}
                  openTitle="Org chart"
                />
                {!collapsed && (
                  <div
                    id={`portfolio-team-${company.id}`}
                    className="border-t border-border bg-muted/10 p-2 sm:pl-10"
                  >
                    {orgLoading ? (
                      <p className="px-3 py-3 text-sm text-muted-foreground">
                        Loading reporting lines…
                      </p>
                    ) : orgNodes.length === 0 ? (
                      <p className="px-3 py-3 text-sm text-muted-foreground">
                        {hasMemberFilters && (rawOrgNodes ?? []).length > 0
                          ? "No team members match the current filters."
                          : "No reporting hierarchy is defined for this team."}
                      </p>
                    ) : (
                      orgNodes.map((node) => (
                        <OrgTreeNode
                          key={node.id}
                          node={node}
                          depth={0}
                          agentMap={agentById}
                          liveRunByAgent={liveRunByAgent}
                          companyPrefix={company.issuePrefix}
                        />
                      ))
                    )}
                  </div>
                )}
              </section>
            );
          })}
      </div>

      {view === "list" && selectedIds.size > 0 && (
        <BulkActionsBar
          count={selectedIds.size}
          onPause={handleBulkPause}
          onResume={handleBulkResume}
          onClear={() => setSelectedIds(new Set())}
          isPending={isMutating}
        />
      )}
    </div>
  );
}

function companyDestination(company: Company, relativePath: string): string {
  return `/${company.issuePrefix}${relativePath}`;
}

/**
 * Portfolio Teams uses the same five destinations as a company's Team page.
 * They are real routes, rather than local view state, so each tab can be
 * bookmarked and scope switching can preserve the question being asked.
 */
export function PortfolioTeams() {
  const location = useLocation();
  const navigate = useNavigate();
  const { setBreadcrumbs } = useBreadcrumbs();
  const activeTab = portfolioTeamTabForPath(location.pathname) ?? PORTFOLIO_TEAM_DEFAULT_TAB;
  const items = useMemo(
    () => PORTFOLIO_TEAM_TABS.map((tab) => ({ value: tab.id, label: tab.label })),
    [],
  );

  const goToTab = useCallback(
    (value: string) => {
      const tab = PORTFOLIO_TEAM_TABS.find((candidate) => candidate.id === value);
      if (!tab || tab.id === activeTab.id) return;
      navigate(tab.to);
    },
    [activeTab.id, navigate],
  );

  useEffect(() => {
    setBreadcrumbs(
      activeTab.id === PORTFOLIO_TEAM_DEFAULT_TAB.id
        ? [{ label: "Portfolio Teams" }]
        : [
            { label: "Portfolio Teams", href: PORTFOLIO_TEAM_DEFAULT_TAB.to },
            { label: activeTab.label },
          ],
    );
  }, [activeTab.id, activeTab.label, setBreadcrumbs]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="shrink-0 border-b border-border px-6 pt-4">
        <div className="pb-3">
          <h1 className="text-base font-semibold">Portfolio Teams</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            The same operational Team views across every company, grouped by team so company
            ownership and boundaries stay visible.
          </p>
        </div>
        <Tabs value={activeTab.id} onValueChange={goToTab} activationMode="manual">
          <PageTabBar
            items={items}
            value={activeTab.id}
            onValueChange={goToTab}
            align="start"
            label="Portfolio Teams section"
          />
        </Tabs>
      </div>
      <div className="min-h-0 min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}

function usePortfolioTeamsOverview(companyIds: string[] = []) {
  const selectedCompanyId = useActiveCompanyId();
  const { data, isLoading, error } = useQuery({
    queryKey: ["portfolio-agents", selectedCompanyId, [], [], companyIds],
    queryFn: () =>
      agentsApi.listPortfolio(selectedCompanyId!, {
        companyIds: companyIds.length > 0 ? companyIds : undefined,
      }),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const agents = data?.agents ?? [];
  const companies = useMemo(() => {
    const raw = data?.companies ?? [];
    return [...raw].sort((a, b) => (b.isPortfolioRoot ? 1 : 0) - (a.isPortfolioRoot ? 1 : 0));
  }, [data?.companies]);
  const agentsByCompany = useMemo(() => {
    const map = new Map<string, Agent[]>();
    for (const company of companies) map.set(company.id, []);
    for (const agent of agents) map.get(agent.companyId)?.push(agent);
    return map;
  }, [agents, companies]);

  const liveRunQueries = useQueries({
    queries: companies.map((company) => ({
      queryKey: ["portfolio-agents", "live-runs", company.id],
      queryFn: () => heartbeatsApi.liveRunsForCompany(company.id),
      refetchInterval: 15_000,
    })),
  });
  const liveRunByAgent = useMemo(() => {
    const map = new Map<string, { runId: string; liveCount: number }>();
    companies.forEach((_company, index) => {
      for (const run of liveRunQueries[index]?.data ?? []) {
        if (run.status !== "running" && run.status !== "queued") continue;
        const existing = map.get(run.agentId);
        if (existing) existing.liveCount += 1;
        else map.set(run.agentId, { runId: run.id, liveCount: 1 });
      }
    });
    return map;
  }, [companies, liveRunQueries]);

  return { companies, agents, agentsByCompany, liveRunByAgent, isLoading, error };
}

function PortfolioTeamDrilldown({
  tab,
  description,
  children,
}: {
  tab: PortfolioTeamTab;
  description: string;
  children: (company: Company) => ReactNode;
}) {
  const { companies, agents, agentsByCompany, liveRunByAgent, isLoading, error } =
    usePortfolioTeamsOverview();
  const [expandedIds, setExpandedIds] = useState<Set<string> | null>(null);
  const defaultExpandedId = companies[0]?.id ?? null;

  const toggle = (companyId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current ?? (defaultExpandedId ? [defaultExpandedId] : []));
      if (next.has(companyId)) next.delete(companyId);
      else next.add(companyId);
      return next;
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-1 border-b border-border px-6 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>
        <span className="shrink-0 text-sm text-muted-foreground">
          {isLoading
            ? "Loading..."
            : `${companies.length} team${companies.length === 1 ? "" : "s"} · ${agents.length} member${agents.length === 1 ? "" : "s"}`}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">
        {error && <p className="text-sm text-destructive">{error.message}</p>}
        {isLoading && <p className="text-sm text-muted-foreground">Loading teams...</p>}
        {!isLoading && companies.length === 0 && <PortfolioTeamsEmpty />}
        {!isLoading &&
          companies.map((company) => {
            const teamAgents = agentsByCompany.get(company.id) ?? [];
            const expanded = expandedIds
              ? expandedIds.has(company.id)
              : company.id === defaultExpandedId;
            return (
              <section
                key={company.id}
                className="mb-3 overflow-hidden rounded-lg border border-border bg-background"
              >
                <TeamSectionHeader
                  company={company}
                  agents={teamAgents}
                  liveRunByAgent={liveRunByAgent}
                  collapsed={!expanded}
                  onToggleCollapse={() => toggle(company.id)}
                  hasMemberFilters={false}
                  openPath={companyDestination(company, tab.companyTo)}
                  openTitle={tab.label}
                />
                {expanded && (
                  <div
                    id={`portfolio-team-${company.id}`}
                    className="border-t border-border bg-muted/10 p-4"
                  >
                    <CompanyRoutePrefixProvider companyPrefix={company.issuePrefix}>
                      {children(company)}
                    </CompanyRoutePrefixProvider>
                  </div>
                )}
              </section>
            );
          })}
      </div>
    </div>
  );
}

export function PortfolioTeamsRightNow() {
  const tab = PORTFOLIO_TEAM_TABS.find((candidate) => candidate.id === "team")!;
  return (
    <PortfolioTeamDrilldown
      tab={tab}
      description="Scan each team's live, paused, and error totals, then expand a team for the same current-work controls available inside that company."
    >
      {(company) => <TeamCurrentWork companyId={company.id} />}
    </PortfolioTeamDrilldown>
  );
}

export function PortfolioTeamsTimeline() {
  const tab = PORTFOLIO_TEAM_TABS.find((candidate) => candidate.id === "team-timeline")!;
  return (
    <PortfolioTeamDrilldown
      tab={tab}
      description="Compare recent activity team by team. Expand a company to use the same range, ordering, refresh, and run drill-down controls as its Team timeline."
    >
      {(company) => <TeamActivityTimeline companyId={company.id} />}
    </PortfolioTeamDrilldown>
  );
}

export function PortfolioTeamsAgents() {
  return <PortfolioTeamsRoster forcedView="list" />;
}

export function PortfolioTeamsOrg() {
  return <PortfolioTeamsRoster forcedView="org" />;
}

function PortfolioAssistantRow({ company, agent }: { company: Company; agent: Agent }) {
  const navigate = useNavigate();
  const detailPath = companyDestination(company, `/agents/${agentRouteRef(agent)}`);
  const editPath = companyDestination(company, `/assistants/${agent.id}/edit`);
  return (
    <EntityRow
      title={agent.name}
      subtitle={agent.title ?? "Assistant"}
      to={detailPath}
      leading={
        <span className="relative flex h-2.5 w-2.5">
          <span
            className={`absolute inline-flex h-full w-full rounded-full ${agentStatusDot[agent.status] ?? agentStatusDotDefault}`}
          />
        </span>
      }
      trailing={
        <div className="flex items-center gap-2">
          <StatusBadge status={agent.status} />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Edit ${agent.name}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              navigate(editPath);
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        </div>
      }
    />
  );
}

export function PortfolioTeamsAssistants() {
  const [companyIdFilter, setCompanyIdFilter] = useState<string[]>(() =>
    readLsFilter<string[]>(LS_COMPANY_KEY, []),
  );
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  useEffect(() => writeLsFilter(LS_COMPANY_KEY, companyIdFilter), [companyIdFilter]);
  const { companies, agents, agentsByCompany, liveRunByAgent, isLoading, error } =
    usePortfolioTeamsOverview(companyIdFilter);
  const companyOptions = usePortfolioCompanyOptions();
  const assistants = agents.filter(
    (agent) => agent.role === "assistant" && agent.status !== "terminated",
  );

  const toggleCollapse = (companyId: string) => {
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(companyId)) next.delete(companyId);
      else next.add(companyId);
      return next;
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-6 py-2.5">
        {companyOptions.length > 0 && (
          <FilterPopover
            label="Team"
            options={companyOptions}
            selected={companyIdFilter}
            onChange={setCompanyIdFilter}
          />
        )}
        {companyIdFilter.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground"
            onClick={() => setCompanyIdFilter([])}
          >
            Clear filters
          </Button>
        )}
        <span className="ml-auto text-sm text-muted-foreground">
          {isLoading
            ? "Loading..."
            : `${assistants.length} assistant${assistants.length === 1 ? "" : "s"} across ${companies.length} team${companies.length === 1 ? "" : "s"}`}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">
        <p className="mb-3 max-w-3xl text-sm text-muted-foreground">
          AI personas that act on your behalf, kept inside the company team that owns their
          instructions, channels, and budget.
        </p>
        {error && <p className="text-sm text-destructive">{error.message}</p>}
        {isLoading && <p className="text-sm text-muted-foreground">Loading teams...</p>}
        {!isLoading && companies.length === 0 && <PortfolioTeamsEmpty />}
        {!isLoading &&
          companies.map((company) => {
            const companyAssistants = (agentsByCompany.get(company.id) ?? [])
              .filter((agent) => agent.role === "assistant" && agent.status !== "terminated")
              .sort((left, right) => left.name.localeCompare(right.name));
            const collapsed = collapsedIds.has(company.id);
            return (
              <section
                key={company.id}
                className="mb-3 overflow-hidden rounded-lg border border-border bg-background"
              >
                <TeamSectionHeader
                  company={company}
                  agents={companyAssistants}
                  liveRunByAgent={liveRunByAgent}
                  collapsed={collapsed}
                  onToggleCollapse={() => toggleCollapse(company.id)}
                  hasMemberFilters={false}
                  countNoun="assistant"
                  openPath={companyDestination(company, "/assistants")}
                  openTitle="Assistants"
                  addPath={companyDestination(company, "/assistants/new")}
                  addLabel="assistant"
                />
                {!collapsed && (
                  <div
                    id={`portfolio-team-${company.id}`}
                    className="border-t border-border bg-muted/10 p-2 sm:pl-10"
                  >
                    {companyAssistants.length === 0 ? (
                      <p className="px-3 py-3 text-sm text-muted-foreground">
                        This team has no assistants yet.
                      </p>
                    ) : (
                      <div className="overflow-hidden rounded border border-border bg-background">
                        {companyAssistants.map((assistant) => (
                          <PortfolioAssistantRow
                            key={assistant.id}
                            company={company}
                            agent={assistant}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </section>
            );
          })}
      </div>
    </div>
  );
}

function PortfolioTeamsEmpty() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20">
      <Users className="h-8 w-8 text-muted-foreground/40" />
      <p className="text-sm text-muted-foreground">No teams found.</p>
    </div>
  );
}
