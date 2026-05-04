import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ClipboardCheck } from "lucide-react";
import type { Approval, Company } from "@paperclipai/shared";
import { approvalsApi } from "../api/approvals";
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
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "revision_requested", label: "Revision Requested" },
];

function typeLabel(type: string) {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
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

interface ApprovalRowProps {
  approval: Approval;
  companyPrefix: string;
  selected: boolean;
  onToggle: () => void;
  onApprove: () => void;
  onReject: () => void;
}

function ApprovalRow({ approval, companyPrefix, selected, onToggle, onApprove, onReject }: ApprovalRowProps) {
  const isPending = approval.status === "pending";
  return (
    <div className={cn("flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent/40 rounded group", selected && "bg-accent/60")}>
      <Checkbox
        checked={selected}
        onCheckedChange={onToggle}
        className="h-3.5 w-3.5 opacity-0 group-hover:opacity-100 transition-opacity data-[state=checked]:opacity-100"
      />
      <span className="text-[10px] font-semibold uppercase text-muted-foreground shrink-0 w-24 hidden sm:block">
        {typeLabel(approval.type)}
      </span>
      <Link
        to={`/${companyPrefix}/approvals/${approval.id}`}
        className="flex-1 truncate font-medium hover:underline text-foreground"
      >
        {(approval.payload as Record<string, unknown>)?.title as string ?? approval.id.slice(0, 8)}
      </Link>
      <span className="text-[11px] text-muted-foreground shrink-0 w-16 text-right">{timeAgo(approval.createdAt)}</span>
      {isPending && (
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <Button size="sm" variant="outline" className="h-6 text-xs px-2" onClick={onApprove}>Approve</Button>
          <Button size="sm" variant="outline" className="h-6 text-xs px-2 text-destructive hover:text-destructive" onClick={onReject}>Reject</Button>
        </div>
      )}
    </div>
  );
}

interface CompanySectionProps {
  company: Company;
  approvals: Approval[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: (companyId: string, ids: string[]) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}

function CompanySection({ company, approvals, selectedIds, onToggle, onToggleAll, collapsed, onToggleCollapse, onApprove, onReject }: CompanySectionProps) {
  const ids = approvals.map((a) => a.id);
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
          <span className="text-xs text-muted-foreground ml-1">{approvals.length}</span>
        </button>
      </div>
      {!collapsed && (
        <div className="ml-6 flex flex-col">
          {approvals.map((a) => (
            <ApprovalRow
              key={a.id}
              approval={a}
              companyPrefix={company.issuePrefix}
              selected={selectedIds.has(a.id)}
              onToggle={() => onToggle(a.id)}
              onApprove={() => onApprove(a.id)}
              onReject={() => onReject(a.id)}
            />
          ))}
          {approvals.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">No approvals match the current filters.</p>}
        </div>
      )}
    </div>
  );
}

function BulkActionsBar({ count, onApprove, onReject, onClear, isPending }: { count: number; onApprove: () => void; onReject: () => void; onClear: () => void; isPending: boolean }) {
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-lg border border-border bg-background shadow-lg px-4 py-2.5">
      <span className="text-sm font-medium text-muted-foreground mr-1">{count} selected</span>
      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onApprove} disabled={isPending}>Approve all</Button>
      <Button variant="outline" size="sm" className="h-7 text-xs text-destructive hover:text-destructive" onClick={onReject} disabled={isPending}>Reject all</Button>
      <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={onClear}>✕ Deselect</Button>
    </div>
  );
}

export function PortfolioApprovals() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => { setBreadcrumbs([{ label: "Portfolio Approvals" }]); }, [setBreadcrumbs]);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState("pending");
  const [companyIdFilter, setCompanyIdFilter] = useState<string[]>([]);

  const { data, isLoading } = useQuery({
    queryKey: ["portfolio-approvals", selectedCompanyId, statusFilter, companyIdFilter],
    queryFn: () => approvalsApi.listPortfolio(selectedCompanyId!, {
      status: statusFilter,
      companyIds: companyIdFilter.length > 0 ? companyIdFilter : undefined,
    }),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const approvals = data?.approvals ?? [];
  const companies = useMemo(() => {
    const raw = data?.companies ?? [];
    return [...raw].sort((a, b) => (b.isPortfolioRoot ? 1 : 0) - (a.isPortfolioRoot ? 1 : 0));
  }, [data?.companies]);

  const companyOptions = useMemo(() => companies.map((c) => ({ value: c.id, label: c.name })), [companies]);

  const approvalsByCompany = useMemo(() => {
    const map = new Map<string, Approval[]>();
    for (const c of companies) map.set(c.id, []);
    for (const a of approvals) { const list = map.get(a.companyId); if (list) list.push(a); }
    return map;
  }, [approvals, companies]);

  const approveMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.approve(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["portfolio-approvals", selectedCompanyId] }),
  });
  const rejectMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.reject(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["portfolio-approvals", selectedCompanyId] }),
  });
  const isMutating = approveMutation.isPending || rejectMutation.isPending;

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
  async function bulkApprove() {
    await Promise.all(Array.from(selectedIds).map((id) => approvalsApi.approve(id)));
    queryClient.invalidateQueries({ queryKey: ["portfolio-approvals", selectedCompanyId] });
    setSelectedIds(new Set());
  }
  async function bulkReject() {
    await Promise.all(Array.from(selectedIds).map((id) => approvalsApi.reject(id)));
    queryClient.invalidateQueries({ queryKey: ["portfolio-approvals", selectedCompanyId] });
    setSelectedIds(new Set());
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
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-3">
        {isLoading && <p className="text-sm text-muted-foreground">Loading approvals…</p>}
        {!isLoading && approvals.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <ClipboardCheck className="h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No {statusFilter} approvals across the portfolio.</p>
          </div>
        )}
        {!isLoading && companies.map((company) => (
          <CompanySection
            key={company.id}
            company={company}
            approvals={approvalsByCompany.get(company.id) ?? []}
            selectedIds={selectedIds}
            onToggle={toggleId}
            onToggleAll={toggleAll}
            collapsed={collapsedIds.has(company.id)}
            onToggleCollapse={() => toggleCollapse(company.id)}
            onApprove={(id) => approveMutation.mutate(id)}
            onReject={(id) => rejectMutation.mutate(id)}
          />
        ))}
      </div>
      {selectedIds.size > 0 && (
        <BulkActionsBar count={selectedIds.size} onApprove={bulkApprove} onReject={bulkReject} onClear={() => setSelectedIds(new Set())} isPending={isMutating} />
      )}
    </div>
  );
}
