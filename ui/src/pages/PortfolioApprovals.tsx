import { useState, useMemo, useEffect, useRef } from "react";
import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ClipboardCheck, Layers, Lock, ShieldCheck } from "lucide-react";
import type { Agent, Approval, Company } from "@paperclipai/shared";
import { approvalsApi } from "../api/approvals";
import { agentsApi } from "../api/agents";
import { useActiveCompanyId, useIsActiveCompanyPortfolioRoot } from "../hooks/useRouteCompany";
import { usePortfolioCompanyOptions } from "../hooks/usePortfolioCompanyOptions";
import { useApprovalSelection, selectAllState } from "../hooks/useApprovalSelection";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { ApprovalCard } from "../components/ApprovalCard";
import { ApprovalBulkBar } from "../components/ApprovalBulkBar";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { EmptyState } from "../components/EmptyState";
import { FilterPopover } from "../components/FilterPopover";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "../lib/utils";
import { queryKeys } from "../lib/queryKeys";
import { invalidateAttention } from "../lib/invalidate-attention";
import { bulkFailureMessage, isBulkResolvable, type BulkApprovalAction } from "../lib/approval-bulk";
import { PAGE_SCROLL_BOX_END_ROOM_CLASS } from "../lib/narrow-layout";

const STATUS_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "revision_requested", label: "Revision Requested" },
];

type ApprovalSelection = ReturnType<typeof useApprovalSelection>;

interface CompanySectionProps {
  company: Company;
  approvals: Approval[];
  agentsById: Map<string, Agent>;
  selection: ApprovalSelection;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onApprove: (approval: Approval) => void;
  onReject: (approval: Approval) => void;
  busy: boolean;
  pendingActionFor: (id: string) => "approve" | "reject" | null;
}

// The same cards as the company Approvals page, grouped by company, so a
// request can be read and decided here without opening each company.
function CompanySection({
  company,
  approvals,
  agentsById,
  selection,
  collapsed,
  onToggleCollapse,
  onApprove,
  onReject,
  busy,
  pendingActionFor,
}: CompanySectionProps) {
  const selectableIds = approvals.filter(isBulkResolvable).map((a) => a.id);
  const selectAll = selectAllState(selectableIds, selection.isSelected);
  return (
    <section className="mb-5" aria-label={company.name}>
      <div className="flex items-center gap-2 px-1 py-1.5">
        {selectableIds.length > 0 && (
          <Checkbox
            checked={selectAll}
            onCheckedChange={() => selection.setMany(selectableIds, selectAll !== true)}
            aria-label={`Select all ${company.name} approvals`}
          />
        )}
        <button className="flex flex-1 items-center gap-2 min-w-0 text-left" onClick={onToggleCollapse} aria-expanded={!collapsed}>
          {collapsed ? <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
          <CompanyPatternIcon companyName={company.name} logoUrl={company.logoUrl} brandColor={company.brandColor} className="h-5 w-5 shrink-0 rounded-[3px]" />
          <span className="font-medium text-sm truncate">{company.name}</span>
          <span className="text-xs text-muted-foreground ml-1">{approvals.length}</span>
        </button>
      </div>
      {!collapsed && (
        <div className="mt-2 grid gap-3">
          {approvals.map((a) => (
            <ApprovalCard
              key={a.id}
              approval={a}
              requesterAgent={a.requestedByAgentId ? agentsById.get(a.requestedByAgentId) ?? null : null}
              detailLink={`/${company.issuePrefix}/approvals/${a.id}`}
              onApprove={() => onApprove(a)}
              onReject={() => onReject(a)}
              isPending={busy}
              pendingAction={pendingActionFor(a.id)}
              selected={selection.isSelected(a.id)}
              onSelectedChange={(next) => selection.toggle(a.id, next)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function PortfolioApprovalsEmptyHero() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center gap-6 py-12 text-center">
      <div className="relative">
        <div className="rounded-2xl border border-dashed border-border bg-muted/30 p-5">
          <ClipboardCheck className="h-10 w-10 text-primary" strokeWidth={1.5} />
        </div>
      </div>

      <div className="space-y-2">
        <h2 className="text-xl font-semibold text-foreground">Cross-Company Governance Cockpit</h2>
        <p className="max-w-lg text-sm text-muted-foreground leading-relaxed">
          Portfolio Approvals gives executive operators centralized control over sensitive actions requested by agents across all operating companies in your portfolio.
        </p>
      </div>

      <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-3 text-left">
        <div className="rounded-lg border border-border/70 bg-card p-4 shadow-xs">
          <div className="mb-2 flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Layers className="h-4 w-4" />
          </div>
          <h3 className="text-sm font-medium text-foreground">Unified Inbox</h3>
          <p className="mt-1 text-xs text-muted-foreground leading-normal">
            Review pending budget expenditures, command runs, and deployments across all subsidiaries without switching contexts.
          </p>
        </div>

        <div className="rounded-lg border border-border/70 bg-card p-4 shadow-xs">
          <div className="mb-2 flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Lock className="h-4 w-4" />
          </div>
          <h3 className="text-sm font-medium text-foreground">Batch Operations</h3>
          <p className="mt-1 text-xs text-muted-foreground leading-normal">
            Select and batch-approve routine requests across companies in seconds with bulk actions.
          </p>
        </div>

        <div className="rounded-lg border border-border/70 bg-card p-4 shadow-xs">
          <div className="mb-2 flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <h3 className="text-sm font-medium text-foreground">Audit Compliance</h3>
          <p className="mt-1 text-xs text-muted-foreground leading-normal">
            Maintain a transparent, immutable record of approvals, rejections, and reviewer rationales portfolio-wide.
          </p>
        </div>
      </div>
    </div>
  );
}

export function PortfolioApprovals() {
  // Both URL-derived, not useCompany()'s selection state (P3 audit,
  // 2026-09-03) — see Calendar.tsx's identical fix for the general pattern.
  // This page also had no HQ-only gate at all, unlike every sibling
  // Portfolio* page (PortfolioBrief/PortfolioEmail/PortfolioDirectives/
  // PortfolioReceipts) — added below.
  const selectedCompanyId = useActiveCompanyId();
  const isPortfolioRoot = useIsActiveCompanyPortfolioRoot();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => { setBreadcrumbs([{ label: "Portfolio Approvals" }]); }, [setBreadcrumbs]);

  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState("pending");
  const [companyIdFilter, setCompanyIdFilter] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);

  // This page doesn't remount on a company switch, so a filter/selection
  // picked under one company otherwise survives it (P3 audit, 2026-09-03) —
  // same class of gap bullet 7 fixed for Issues/Inbox/Memories, not applied
  // here at the time.
  const prevCompanyIdRef = useRef(selectedCompanyId);
  useEffect(() => {
    if (prevCompanyIdRef.current === selectedCompanyId) return;
    prevCompanyIdRef.current = selectedCompanyId;
    setCollapsedIds(new Set());
    setActionError(null);
    setStatusFilter("pending");
    setCompanyIdFilter([]);
  }, [selectedCompanyId]);

  const { data, isLoading } = useQuery({
    queryKey: ["portfolio-approvals", selectedCompanyId, statusFilter, companyIdFilter],
    queryFn: () => approvalsApi.listPortfolio(selectedCompanyId!, {
      status: statusFilter,
      companyIds: companyIdFilter.length > 0 ? companyIdFilter : undefined,
    }),
    enabled: !!selectedCompanyId && isPortfolioRoot,
    refetchInterval: 30_000,
  });

  const approvals = data?.approvals ?? [];
  const companies = useMemo(() => {
    const raw = data?.companies ?? [];
    return [...raw].sort((a, b) => (b.isPortfolioRoot ? 1 : 0) - (a.isPortfolioRoot ? 1 : 0));
  }, [data?.companies]);

  // Sourced outside the filtered response, or picking one company would leave
  // it as the only option in its own menu.
  const companyOptions = usePortfolioCompanyOptions();

  const approvalsByCompany = useMemo(() => {
    const map = new Map<string, Approval[]>();
    for (const c of companies) map.set(c.id, []);
    for (const a of approvals) { const list = map.get(a.companyId); if (list) list.push(a); }
    return map;
  }, [approvals, companies]);

  // Only companies with something to show get a section: a list of empty
  // companies pushed the real requests below the fold.
  const companiesWithApprovals = useMemo(
    () => companies.filter((c) => (approvalsByCompany.get(c.id)?.length ?? 0) > 0),
    [companies, approvalsByCompany],
  );

  // "Requested by" on each card needs that company's agents.
  const agentQueries = useQueries({
    queries: companiesWithApprovals.map((c) => ({
      queryKey: queryKeys.agents.list(c.id),
      queryFn: () => agentsApi.list(c.id),
    })),
  });
  const agentsById = new Map<string, Agent>();
  for (const q of agentQueries) for (const agent of q.data ?? []) agentsById.set(agent.id, agent);

  // Selection follows the on-screen order, so the bulk run goes top to bottom.
  const selectableIds = companiesWithApprovals.flatMap((c) =>
    (approvalsByCompany.get(c.id) ?? []).filter(isBulkResolvable).map((a) => a.id),
  );
  const selection = useApprovalSelection(
    selectableIds,
    `${selectedCompanyId ?? ""}|${statusFilter}|${companyIdFilter.join(",")}`,
  );
  const selectAll = selectAllState(selectableIds, selection.isSelected);

  function refreshAfterDecision(companyIds: Iterable<string>) {
    queryClient.invalidateQueries({ queryKey: ["portfolio-approvals"] });
    for (const id of new Set(companyIds)) {
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(id) });
      invalidateAttention(queryClient, id);
    }
  }

  const approveMutation = useMutation({
    mutationFn: (approval: Approval) => approvalsApi.approve(approval.id),
    onSuccess: (_result, approval) => {
      setActionError(null);
      refreshAfterDecision([approval.companyId]);
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Failed to approve"),
  });
  const rejectMutation = useMutation({
    mutationFn: (approval: Approval) => approvalsApi.reject(approval.id),
    onSuccess: (_result, approval) => {
      setActionError(null);
      refreshAfterDecision([approval.companyId]);
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Failed to reject"),
  });
  const busy = approveMutation.isPending || rejectMutation.isPending || selection.runningAction !== null;
  function pendingActionFor(id: string): "approve" | "reject" | null {
    if (approveMutation.isPending && approveMutation.variables?.id === id) return "approve";
    if (rejectMutation.isPending && rejectMutation.variables?.id === id) return "reject";
    return null;
  }

  function toggleCollapse(id: string) {
    setCollapsedIds((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  async function runBulk(action: BulkApprovalAction) {
    const companyById = new Map(approvals.map((a) => [a.id, a.companyId]));
    const touched = selection.selectedIds.map((id) => companyById.get(id)).filter((id): id is string => !!id);
    const result = await selection.run(action);
    if (!result) return;
    setActionError(bulkFailureMessage(result, action));
    refreshAfterDecision(touched);
  }

  if (!selectedCompanyId) {
    return <EmptyState icon={ClipboardCheck} message="Select a company to view its approvals." />;
  }
  if (!isPortfolioRoot) {
    return (
      <EmptyState
        icon={ClipboardCheck}
        message="Portfolio Approvals is only available on the HQ (portfolio root) company."
      />
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <h1 className="text-base font-semibold">Portfolio Approvals</h1>
        <span className="text-sm text-muted-foreground">{isLoading ? "Loading…" : `${approvals.length} ${statusFilter}`}</span>
      </div>
      <div className="flex items-center gap-2 px-6 py-2.5 border-b border-border shrink-0 flex-wrap">
        <FilterPopover
          label="Status"
          options={STATUS_OPTIONS}
          selected={[statusFilter]}
          onChange={(next) => setStatusFilter(next[0] ?? "pending")}
        />
        {companyOptions.length > 0 && (
          <FilterPopover label="Company" options={companyOptions} selected={companyIdFilter} onChange={setCompanyIdFilter} />
        )}
        {selectableIds.length > 0 && (
          <label className="ml-auto flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={selectAll}
              onCheckedChange={() => selection.setMany(selectableIds, selectAll !== true)}
              aria-label="Select all approvals"
            />
            Select all ({selectableIds.length})
          </label>
        )}
      </div>
      <div className={cn("flex-1 min-h-0 overflow-y-auto px-6 py-3", PAGE_SCROLL_BOX_END_ROOM_CLASS)}>
        {actionError && <p className="mb-3 text-sm text-destructive">{actionError}</p>}
        {isLoading && <p className="text-sm text-muted-foreground">Loading approvals…</p>}
        {!isLoading && approvals.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <ClipboardCheck className="h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No {statusFilter} approvals across the portfolio.</p>
          </div>
        )}
        {!isLoading && companiesWithApprovals.map((company) => (
          <CompanySection
            key={company.id}
            company={company}
            approvals={approvalsByCompany.get(company.id) ?? []}
            agentsById={agentsById}
            selection={selection}
            collapsed={collapsedIds.has(company.id)}
            onToggleCollapse={() => toggleCollapse(company.id)}
            onApprove={(approval) => approveMutation.mutate(approval)}
            onReject={(approval) => rejectMutation.mutate(approval)}
            busy={busy}
            pendingActionFor={pendingActionFor}
          />
        ))}
      </div>
      {selection.selectedIds.length > 0 && (
        <ApprovalBulkBar
          count={selection.selectedIds.length}
          onApprove={() => void runBulk("approve")}
          onReject={() => void runBulk("reject")}
          onClear={selection.clear}
          runningAction={selection.runningAction}
        />
      )}
    </div>
  );
}
