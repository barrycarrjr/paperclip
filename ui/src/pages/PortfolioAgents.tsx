import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Plus, Users } from "lucide-react";
import type { Agent, AgentRole, AgentStatus, Company } from "@paperclipai/shared";
import { AGENT_ROLES, AGENT_STATUSES, AGENT_ROLE_LABELS } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { Link } from "@/lib/router";
import { timeAgo } from "../lib/timeAgo";
import { agentStatusDot, agentStatusDotDefault } from "../lib/status-colors";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "../lib/utils";

const VISIBLE_STATUSES: AgentStatus[] = AGENT_STATUSES.filter((s) => s !== "terminated");

function statusLabel(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
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

interface AgentRowProps {
  agent: Agent;
  companyPrefix: string;
  selected: boolean;
  onToggle: () => void;
}

function PortfolioAgentRow({ agent, companyPrefix, selected, onToggle }: AgentRowProps) {
  const dotClass = agentStatusDot[agent.status] ?? agentStatusDotDefault;
  const heartbeatLabel = agent.lastHeartbeatAt ? timeAgo(agent.lastHeartbeatAt) : null;

  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent/40 rounded group",
        selected && "bg-accent/60",
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
        className="flex-1 truncate font-medium hover:underline"
      >
        {agent.name}
      </Link>

      <span className="text-[11px] text-muted-foreground shrink-0 hidden md:block">
        {statusLabel(agent.status)}
      </span>

      <span className="text-[11px] text-muted-foreground shrink-0 w-16 text-right">
        {heartbeatLabel ? `♡ ${heartbeatLabel}` : "—"}
      </span>
    </div>
  );
}

interface CompanySectionProps {
  company: Company;
  agents: Agent[];
  selectedIds: Set<string>;
  onToggleAgent: (id: string) => void;
  onToggleAll: (companyId: string, agentIds: string[]) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

function CompanySection({
  company,
  agents,
  selectedIds,
  onToggleAgent,
  onToggleAll,
  collapsed,
  onToggleCollapse,
}: CompanySectionProps) {
  const agentIds = agents.map((a) => a.id);
  const allSelected = agentIds.length > 0 && agentIds.every((id) => selectedIds.has(id));
  const someSelected = !allSelected && agentIds.some((id) => selectedIds.has(id));

  return (
    <div className="mb-1">
      <div className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent/30 cursor-pointer group">
        <Checkbox
          checked={allSelected}
          data-state={someSelected ? "indeterminate" : undefined}
          onCheckedChange={() => onToggleAll(company.id, agentIds)}
          className="h-3.5 w-3.5 opacity-0 group-hover:opacity-100 transition-opacity data-[state=checked]:opacity-100 data-[state=indeterminate]:opacity-100"
          onClick={(e) => e.stopPropagation()}
        />
        <button
          className="flex flex-1 items-center gap-2 min-w-0"
          onClick={onToggleCollapse}
        >
          {collapsed
            ? <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
          <CompanyPatternIcon
            companyName={company.name}
            logoUrl={company.logoUrl}
            brandColor={company.brandColor}
            className="h-5 w-5 shrink-0 rounded-[3px]"
          />
          <span className="font-medium text-sm truncate">{company.name}</span>
          <span className="text-xs text-muted-foreground ml-1">{agents.length} agent{agents.length !== 1 ? "s" : ""}</span>
        </button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground"
          asChild
        >
          <Link to={`/${company.issuePrefix}/agents/new`}>
            <Plus className="h-3.5 w-3.5" />
          </Link>
        </Button>
      </div>

      {!collapsed && (
        <div className="ml-6 flex flex-col">
          {agents.map((agent) => (
            <PortfolioAgentRow
              key={agent.id}
              agent={agent}
              companyPrefix={company.issuePrefix}
              selected={selectedIds.has(agent.id)}
              onToggle={() => onToggleAgent(agent.id)}
            />
          ))}
          {agents.length === 0 && (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              No agents match the current filters.
            </p>
          )}
        </div>
      )}
    </div>
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

export function PortfolioAgents() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Portfolio Agents" }]);
  }, [setBreadcrumbs]);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<AgentStatus[]>([]);
  const [roleFilter, setRoleFilter] = useState<AgentRole[]>([]);
  const [companyIdFilter, setCompanyIdFilter] = useState<string[]>([]);

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

  const companyOptions = useMemo(
    () => companies.map((c) => ({ value: c.id, label: c.name })),
    [companies],
  );

  const agentsByCompany = useMemo(() => {
    const map = new Map<string, Agent[]>();
    for (const company of companies) map.set(company.id, []);
    for (const agent of agents) {
      const list = map.get(agent.companyId);
      if (list) list.push(agent);
    }
    return map;
  }, [agents, companies]);

  const pauseMutation = useMutation({
    mutationFn: (id: string) => agentsApi.pause(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["portfolio-agents", selectedCompanyId] }),
  });

  const resumeMutation = useMutation({
    mutationFn: (id: string) => agentsApi.resume(id),
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
    await Promise.all(Array.from(selectedIds).map((id) => agentsApi.pause(id)));
    queryClient.invalidateQueries({ queryKey: ["portfolio-agents", selectedCompanyId] });
    setSelectedIds(new Set());
  }

  async function handleBulkResume() {
    await Promise.all(Array.from(selectedIds).map((id) => agentsApi.resume(id)));
    queryClient.invalidateQueries({ queryKey: ["portfolio-agents", selectedCompanyId] });
    setSelectedIds(new Set());
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <h1 className="text-base font-semibold">Portfolio Agents</h1>
        <span className="text-sm text-muted-foreground">
          {isLoading ? "Loading…" : `${agents.length} agent${agents.length !== 1 ? "s" : ""}`}
        </span>
      </div>

      <div className="flex items-center gap-2 px-6 py-2.5 border-b border-border shrink-0 flex-wrap">
        <FilterPopover
          label="Status"
          options={VISIBLE_STATUSES.map((s) => ({ value: s, label: statusLabel(s) }))}
          selected={statusFilter}
          onChange={(next) => setStatusFilter(next as AgentStatus[])}
        />
        <FilterPopover
          label="Role"
          options={AGENT_ROLES.map((r) => ({ value: r, label: AGENT_ROLE_LABELS[r] }))}
          selected={roleFilter}
          onChange={(next) => setRoleFilter(next as AgentRole[])}
        />
        {companyOptions.length > 0 && (
          <FilterPopover
            label="Company"
            options={companyOptions}
            selected={companyIdFilter}
            onChange={setCompanyIdFilter}
          />
        )}
        {(statusFilter.length > 0 || roleFilter.length > 0 || companyIdFilter.length > 0) && (
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
          <p className="text-sm text-muted-foreground">Loading agents…</p>
        )}

        {!isLoading && companies.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <Users className="h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No companies found.</p>
          </div>
        )}

        {!isLoading &&
          companies.map((company) => {
            const companyAgents = agentsByCompany.get(company.id) ?? [];
            return (
              <CompanySection
                key={company.id}
                company={company}
                agents={companyAgents}
                selectedIds={selectedIds}
                onToggleAgent={handleToggleAgent}
                onToggleAll={handleToggleAll}
                collapsed={collapsedIds.has(company.id)}
                onToggleCollapse={() => handleToggleCollapse(company.id)}
              />
            );
          })}
      </div>

      {selectedIds.size > 0 && (
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
