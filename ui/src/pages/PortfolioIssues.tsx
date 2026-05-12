import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient, useQueries } from "@tanstack/react-query";
import { Bot, ChevronDown, ChevronRight, ExternalLink, Plus, Check, Tag, User } from "lucide-react";
import type { Agent, Company, Issue, IssueLabel, IssuePriority, IssueStatus } from "@paperclipai/shared";
import { ISSUE_STATUSES, ISSUE_PRIORITIES } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useDialog } from "../context/DialogContext";
import { StatusIcon } from "../components/StatusIcon";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { Link } from "@/lib/router";
import { timeAgo } from "../lib/timeAgo";
import { priorityColor, priorityColorDefault } from "../lib/status-colors";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { IssuePreviewSheet } from "../components/IssuePreviewSheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "../lib/utils";

const DEFAULT_STATUS_FILTER: IssueStatus[] = ISSUE_STATUSES.filter(
  (s) => s !== "done" && s !== "cancelled",
);

const LS_STATUS_KEY = "paperclip:portfolio-issues:statusFilter";
const LS_PRIORITY_KEY = "paperclip:portfolio-issues:priorityFilter";
const LS_COMPANY_KEY = "paperclip:portfolio-issues:companyFilter";

function readLsFilter<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeLsFilter(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore quota errors
  }
}

function statusLabel(status: string) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function priorityLabel(p: string) {
  return p.charAt(0).toUpperCase() + p.slice(1);
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
  const activeLabel = selected.length > 0 && selected.length < options.length
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

interface IssueRowProps {
  issue: Issue;
  companyPrefix: string;
  selected: boolean;
  agentName: string | null;
  labels: IssueLabel[];
  onToggle: () => void;
  onStatusChange: (status: string) => void;
  onOpenPreview: (issue: Issue) => void;
}

const PREVIEW_DESCRIPTION_CHARS = 500;

function statusBadgeLabel(status: string) {
  return status.replace(/_/g, " ");
}

function PortfolioIssueRow({
  issue,
  companyPrefix,
  selected,
  agentName,
  labels,
  onToggle,
  onStatusChange,
  onOpenPreview,
}: IssueRowProps) {
  const issueLabels = (issue.labelIds ?? [])
    .map((id) => labels.find((l) => l.id === id))
    .filter((l): l is IssueLabel => !!l);
  const description = (issue.description ?? "").trim();
  const descriptionPreview = description.length > PREVIEW_DESCRIPTION_CHARS
    ? description.slice(0, PREVIEW_DESCRIPTION_CHARS).trimEnd() + "…"
    : description;

  const assigneeLabel = agentName
    ? agentName
    : issue.assigneeUserId
      ? "User"
      : null;
  const AssigneeIcon = agentName ? Bot : User;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          onClick={() => onOpenPreview(issue)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onOpenPreview(issue);
            }
          }}
          className={cn(
            "flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent/40 rounded group cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500/40",
            selected && "bg-accent/60",
          )}
        >
          <span onClick={(e) => e.stopPropagation()}>
            <Checkbox
              checked={selected}
              onCheckedChange={onToggle}
              className="h-3.5 w-3.5 opacity-0 group-hover:opacity-100 transition-opacity data-[state=checked]:opacity-100"
            />
          </span>

          <span onClick={(e) => e.stopPropagation()}>
            <StatusIcon
              status={issue.status}
              blockerAttention={issue.blockerAttention}
              onChange={onStatusChange}
              className="h-4 w-4 shrink-0"
            />
          </span>

          <span className="text-[10px] font-mono text-muted-foreground shrink-0 w-16 hidden sm:block">
            {issue.identifier ?? ""}
          </span>

          <div className="flex-1 min-w-0 flex items-center gap-1.5">
            <span className="truncate font-medium group-hover:underline">
              {issue.title}
            </span>
            <Link
              to={`/${companyPrefix}/issues/${issue.id}`}
              onClick={(e) => e.stopPropagation()}
              title="Open full page (middle-click for a new tab)"
              aria-label="Open full page"
              className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Link>
          </div>

          {issueLabels.length > 0 && (
            <span className="hidden md:flex items-center gap-1 shrink-0">
              {issueLabels.slice(0, 3).map((l) => (
                <span
                  key={l.id}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded-full border border-border bg-background"
                  title={l.name}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: l.color || "#888" }}
                    aria-hidden
                  />
                  <span className="max-w-[80px] truncate">{l.name}</span>
                </span>
              ))}
              {issueLabels.length > 3 && (
                <span className="text-[10px] text-muted-foreground">+{issueLabels.length - 3}</span>
              )}
            </span>
          )}

          {assigneeLabel ? (
            <span
              className="hidden lg:inline-flex items-center gap-1 text-[11px] text-muted-foreground shrink-0 max-w-[120px]"
              title={`Assigned to ${assigneeLabel}`}
            >
              <AssigneeIcon className="h-3 w-3 shrink-0" />
              <span className="truncate">{assigneeLabel}</span>
            </span>
          ) : (
            <span className="hidden lg:inline-flex items-center text-[11px] text-muted-foreground/50 shrink-0 italic">
              unassigned
            </span>
          )}

          <span
            className={cn(
              "text-[10px] font-semibold uppercase shrink-0",
              priorityColor[issue.priority] ?? priorityColorDefault,
            )}
          >
            {issue.priority?.slice(0, 4).toUpperCase()}
          </span>

          <span className="text-[11px] text-muted-foreground shrink-0 w-14 text-right">
            {timeAgo(issue.updatedAt)}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-lg p-3 text-left whitespace-normal">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-[11px] opacity-80">
            <span className="font-mono">{issue.identifier ?? ""}</span>
            <span>·</span>
            <span>{statusBadgeLabel(issue.status)}</span>
            <span>·</span>
            <span className={cn(priorityColor[issue.priority] ?? priorityColorDefault)}>
              {issue.priority?.toUpperCase()}
            </span>
          </div>
          <div className="text-[13px] font-medium leading-snug break-words">
            {issue.title}
          </div>
          {descriptionPreview ? (
            <div className="text-[12px] leading-snug break-words whitespace-pre-wrap opacity-80 max-h-48 overflow-hidden">
              {descriptionPreview}
            </div>
          ) : (
            <div className="text-[12px] italic opacity-60">No description.</div>
          )}
          {issueLabels.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 pt-1">
              {issueLabels.map((l) => (
                <span
                  key={l.id}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded-full"
                  style={{ backgroundColor: (l.color || "#888") + "33", color: l.color || "inherit" }}
                >
                  {l.name}
                </span>
              ))}
            </div>
          )}
          <div className="text-[11px] opacity-70 pt-1">
            {assigneeLabel ? `Assigned to ${assigneeLabel}` : "Unassigned"} · updated {timeAgo(issue.updatedAt)}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

interface CompanySectionProps {
  company: Company;
  issues: Issue[];
  selectedIds: Set<string>;
  agentNameById: Map<string, string>;
  labels: IssueLabel[];
  onToggleIssue: (id: string) => void;
  onToggleAll: (companyId: string, issueIds: string[]) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onStatusChange: (issueId: string, status: string) => void;
  onNewIssue: (companyId: string) => void;
  onOpenPreview: (issue: Issue) => void;
}

function CompanySection({
  company,
  issues,
  selectedIds,
  agentNameById,
  labels,
  onToggleIssue,
  onToggleAll,
  collapsed,
  onToggleCollapse,
  onStatusChange,
  onNewIssue,
  onOpenPreview,
}: CompanySectionProps) {
  const issueIds = issues.map((i) => i.id);
  const allSelected = issueIds.length > 0 && issueIds.every((id) => selectedIds.has(id));
  const someSelected = !allSelected && issueIds.some((id) => selectedIds.has(id));

  return (
    <div className="mb-1">
      <div className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent/30 cursor-pointer group">
        <Checkbox
          checked={allSelected}
          data-state={someSelected ? "indeterminate" : undefined}
          onCheckedChange={() => onToggleAll(company.id, issueIds)}
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
          <span className="text-xs text-muted-foreground ml-1">{issues.length} open</span>
        </button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground"
          onClick={() => onNewIssue(company.id)}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {!collapsed && (
        <div className="ml-6 flex flex-col">
          {issues.map((issue) => (
            <PortfolioIssueRow
              key={issue.id}
              issue={issue}
              companyPrefix={company.issuePrefix}
              selected={selectedIds.has(issue.id)}
              agentName={issue.assigneeAgentId ? agentNameById.get(issue.assigneeAgentId) ?? null : null}
              labels={labels}
              onToggle={() => onToggleIssue(issue.id)}
              onStatusChange={(status) => onStatusChange(issue.id, status)}
              onOpenPreview={onOpenPreview}
            />
          ))}
          {issues.length === 0 && (
            <p className="px-3 py-2 text-sm text-muted-foreground">No issues match the current filters.</p>
          )}
        </div>
      )}
    </div>
  );
}

interface BulkActionsBarProps {
  count: number;
  onStatusChange: (status: string) => void;
  onComment: () => void;
  onClear: () => void;
  commentOpen: boolean;
  setCommentOpen: (open: boolean) => void;
  commentText: string;
  setCommentText: (text: string) => void;
  onSubmitComment: () => void;
  isPending: boolean;
  labelsByCompanyId: Map<string, IssueLabel[]>;
  companies: Company[];
  selectedIssues: Issue[];
  onToggleLabel: (labelId: string, companyId: string) => void;
}

function BulkActionsBar({
  count,
  onStatusChange,
  onComment,
  onClear,
  commentOpen,
  setCommentOpen,
  commentText,
  setCommentText,
  onSubmitComment,
  isPending,
  labelsByCompanyId,
  companies,
  selectedIssues,
  onToggleLabel,
}: BulkActionsBarProps) {
  const [labelOpen, setLabelOpen] = useState(false);

  const labelRows = useMemo(() => {
    const rows: Array<{ label: IssueLabel; company: Company; state: "all" | "some" | "none" }> = [];
    for (const company of companies) {
      const labels = labelsByCompanyId.get(company.id);
      if (!labels || labels.length === 0) continue;
      const companyIssues = selectedIssues.filter((i) => i.companyId === company.id);
      if (companyIssues.length === 0) continue;
      for (const label of labels) {
        const withLabel = companyIssues.filter((i) => (i.labelIds ?? []).includes(label.id));
        const state =
          withLabel.length === companyIssues.length
            ? "all"
            : withLabel.length > 0
              ? "some"
              : "none";
        rows.push({ label, company, state });
      }
    }
    return rows;
  }, [labelsByCompanyId, companies, selectedIssues]);

  const multiCompany = useMemo(() => {
    const ids = new Set(labelRows.map((r) => r.company.id));
    return ids.size > 1;
  }, [labelRows]);

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-lg border border-border bg-background shadow-lg px-4 py-2.5">
      <span className="text-sm font-medium text-muted-foreground mr-1">
        {count} selected
      </span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1">
            Status
            <ChevronDown className="h-3 w-3 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" side="top" className="mb-1">
          {ISSUE_STATUSES.map((s) => (
            <DropdownMenuItem key={s} onSelect={() => onStatusChange(s)}>
              {statusLabel(s)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Popover open={labelOpen} onOpenChange={setLabelOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1">
            <Tag className="h-3 w-3 opacity-70" />
            Add Label
          </Button>
        </PopoverTrigger>
        <PopoverContent align="center" side="top" className="w-56 mb-1 p-1">
          {labelRows.length === 0 ? (
            <p className="text-xs text-muted-foreground px-2 py-1.5">No labels found</p>
          ) : (
            <div className="flex flex-col">
              {(() => {
                const elements: React.ReactNode[] = [];
                let lastCompanyId: string | null = null;
                for (const { label, company, state } of labelRows) {
                  if (multiCompany && company.id !== lastCompanyId) {
                    lastCompanyId = company.id;
                    elements.push(
                      <p key={`hdr-${company.id}`} className="text-[10px] font-medium text-muted-foreground px-2 pt-2 pb-0.5 first:pt-1">
                        {company.name}
                      </p>,
                    );
                  }
                  elements.push(
                    <button
                      key={label.id}
                      type="button"
                      className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-sm hover:bg-accent text-left"
                      onClick={() => onToggleLabel(label.id, company.id)}
                    >
                      <span
                        className="h-2.5 w-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: label.color }}
                      />
                      <span className="flex-1 truncate">{label.name}</span>
                      {state === "all" && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
                      {state === "some" && <span className="h-1.5 w-1.5 rounded-full bg-primary/50 shrink-0" />}
                    </button>,
                  );
                }
                return elements;
              })()}
            </div>
          )}
        </PopoverContent>
      </Popover>

      <Popover open={commentOpen} onOpenChange={setCommentOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onComment}>
            Add Comment
          </Button>
        </PopoverTrigger>
        <PopoverContent align="center" side="top" className="w-72 mb-1">
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              Add a comment to {count} issue{count !== 1 ? "s" : ""}
            </p>
            <Textarea
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder="Write a comment…"
              className="text-sm resize-none"
              rows={3}
              autoFocus
            />
            <Button
              size="sm"
              onClick={onSubmitComment}
              disabled={!commentText.trim() || isPending}
              className="self-end"
            >
              <Check className="h-3.5 w-3.5 mr-1" />
              Submit
            </Button>
          </div>
        </PopoverContent>
      </Popover>

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

export function PortfolioIssues() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { openNewIssue } = useDialog();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Portfolio Issues" }]);
  }, [setBreadcrumbs]);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [previewIssue, setPreviewIssue] = useState<Issue | null>(null);

  const [statusFilter, setStatusFilter] = useState<IssueStatus[]>(() =>
    readLsFilter<IssueStatus[]>(LS_STATUS_KEY, DEFAULT_STATUS_FILTER),
  );
  const [priorityFilter, setPriorityFilter] = useState<IssuePriority[]>(() =>
    readLsFilter<IssuePriority[]>(LS_PRIORITY_KEY, []),
  );
  const [companyIdFilter, setCompanyIdFilter] = useState<string[]>(() =>
    readLsFilter<string[]>(LS_COMPANY_KEY, []),
  );

  useEffect(() => { writeLsFilter(LS_STATUS_KEY, statusFilter); }, [statusFilter]);
  useEffect(() => { writeLsFilter(LS_PRIORITY_KEY, priorityFilter); }, [priorityFilter]);
  useEffect(() => { writeLsFilter(LS_COMPANY_KEY, companyIdFilter); }, [companyIdFilter]);

  const [commentText, setCommentText] = useState("");
  const [commentOpen, setCommentOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["portfolio-issues", selectedCompanyId, statusFilter, priorityFilter, companyIdFilter],
    queryFn: () =>
      issuesApi.listPortfolio(selectedCompanyId!, {
        statuses: statusFilter,
        priorities: priorityFilter.length > 0 ? priorityFilter : undefined,
        companyIds: companyIdFilter.length > 0 ? companyIdFilter : undefined,
      }),
    enabled: !!selectedCompanyId,
  });

  const issues = data?.issues ?? [];
  const companies = useMemo(() => {
    const raw = data?.companies ?? [];
    return [...raw].sort((a, b) => (b.isPortfolioRoot ? 1 : 0) - (a.isPortfolioRoot ? 1 : 0));
  }, [data?.companies]);

  const companyOptions = useMemo(
    () => companies.map((c) => ({ value: c.id, label: c.name })),
    [companies],
  );

  const issuesByCompany = useMemo(() => {
    const map = new Map<string, Issue[]>();
    for (const company of companies) {
      map.set(company.id, []);
    }
    for (const issue of issues) {
      const list = map.get(issue.companyId);
      if (list) list.push(issue);
    }
    return map;
  }, [issues, companies]);

  const issueById = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const issue of issues) map.set(issue.id, issue);
    return map;
  }, [issues]);

  const selectedCompanyIds = useMemo(() => {
    const ids = new Set<string>();
    for (const id of selectedIds) {
      const issue = issueById.get(id);
      if (issue) ids.add(issue.companyId);
    }
    return [...ids];
  }, [selectedIds, issueById]);

  // Fetch labels for every visible company so the inline label chips on each
  // row resolve, not just the ones with currently-selected issues.
  const visibleCompanyIds = useMemo(() => companies.map((c) => c.id), [companies]);
  const labelQueries = useQueries({
    queries: visibleCompanyIds.map((companyId) => ({
      queryKey: ["labels", companyId],
      queryFn: () => issuesApi.listLabels(companyId),
      staleTime: 5 * 60_000,
    })),
  });

  const labelsByCompanyId = useMemo(() => {
    const map = new Map<string, IssueLabel[]>();
    for (let i = 0; i < visibleCompanyIds.length; i++) {
      const data = labelQueries[i]?.data;
      if (data) map.set(visibleCompanyIds[i]!, data);
    }
    return map;
  }, [visibleCompanyIds, labelQueries]);

  // Portfolio-wide agent map so we can show assignee names without one
  // per-company round trip per row. Stale-times a minute since names change
  // rarely; the inbox refetches the list itself on a faster cadence.
  const { data: portfolioAgentsData } = useQuery({
    queryKey: ["portfolio-issues", "agents", selectedCompanyId],
    queryFn: () => agentsApi.listPortfolio(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
  });
  const agentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of (portfolioAgentsData?.agents as Agent[] | undefined) ?? []) {
      map.set(a.id, a.name);
    }
    return map;
  }, [portfolioAgentsData]);

  const selectedIssues = useMemo(
    () => [...selectedIds].map((id) => issueById.get(id)).filter((i): i is Issue => !!i),
    [selectedIds, issueById],
  );

  const updateMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      issuesApi.update(id, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["portfolio-issues", selectedCompanyId] });
    },
  });

  const commentMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) =>
      issuesApi.addComment(id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["portfolio-issues", selectedCompanyId] });
    },
  });

  function handleToggleIssue(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleToggleAll(companyId: string, issueIds: string[]) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = issueIds.every((id) => next.has(id));
      if (allSelected) {
        issueIds.forEach((id) => next.delete(id));
      } else {
        issueIds.forEach((id) => next.add(id));
      }
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

  function handleStatusChange(issueId: string, status: string) {
    updateMutation.mutate({ id: issueId, status });
  }

  async function handleBulkStatusChange(status: string) {
    const ids = Array.from(selectedIds);
    await Promise.all(ids.map((id) => issuesApi.update(id, { status })));
    queryClient.invalidateQueries({ queryKey: ["portfolio-issues", selectedCompanyId] });
    setSelectedIds(new Set());
  }

  async function handleBulkComment() {
    if (!commentText.trim()) return;
    const ids = Array.from(selectedIds);
    await Promise.all(ids.map((id) => issuesApi.addComment(id, commentText.trim())));
    queryClient.invalidateQueries({ queryKey: ["portfolio-issues", selectedCompanyId] });
    setSelectedIds(new Set());
    setCommentText("");
    setCommentOpen(false);
  }

  async function handleBulkToggleLabel(labelId: string, labelCompanyId: string) {
    const companyIssues = selectedIssues.filter((i) => i.companyId === labelCompanyId);
    const allHave = companyIssues.every((i) => (i.labelIds ?? []).includes(labelId));
    await Promise.all(
      companyIssues.map((issue) => {
        const current = issue.labelIds ?? [];
        const next = allHave
          ? current.filter((l) => l !== labelId)
          : current.includes(labelId)
            ? current
            : [...current, labelId];
        return issuesApi.update(issue.id, { labelIds: next });
      }),
    );
    queryClient.invalidateQueries({ queryKey: ["portfolio-issues", selectedCompanyId] });
  }

  function handleNewIssue(companyId: string) {
    openNewIssue({ companyId });
  }

  const hasActiveFilters =
    statusFilter.length < DEFAULT_STATUS_FILTER.length ||
    priorityFilter.length > 0 ||
    companyIdFilter.length > 0;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <h1 className="text-base font-semibold">Portfolio Issues</h1>
        <span className="text-sm text-muted-foreground">
          {isLoading ? "Loading…" : `${issues.length} open`}
        </span>
      </div>

      <div className="flex items-center gap-2 px-6 py-2.5 border-b border-border shrink-0 flex-wrap">
        <FilterPopover
          label="Status"
          options={ISSUE_STATUSES.map((s) => ({ value: s, label: statusLabel(s) }))}
          selected={statusFilter}
          onChange={(next) => setStatusFilter(next as IssueStatus[])}
        />
        <FilterPopover
          label="Priority"
          options={ISSUE_PRIORITIES.map((p) => ({ value: p, label: priorityLabel(p) }))}
          selected={priorityFilter}
          onChange={(next) => setPriorityFilter(next as IssuePriority[])}
        />
        {companyOptions.length > 0 && (
          <FilterPopover
            label="Company"
            options={companyOptions}
            selected={companyIdFilter}
            onChange={setCompanyIdFilter}
          />
        )}
        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground"
            onClick={() => {
              setStatusFilter(DEFAULT_STATUS_FILTER);
              setPriorityFilter([]);
              setCompanyIdFilter([]);
            }}
          >
            Reset filters
          </Button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground px-2 py-4">Loading issues…</p>
        ) : companies.length === 0 ? (
          <p className="text-sm text-muted-foreground px-2 py-4">No companies found.</p>
        ) : (
          companies.map((company) => {
            const companyIssues = issuesByCompany.get(company.id) ?? [];
            return (
              <CompanySection
                key={company.id}
                company={company}
                issues={companyIssues}
                selectedIds={selectedIds}
                agentNameById={agentNameById}
                labels={labelsByCompanyId.get(company.id) ?? []}
                onToggleIssue={handleToggleIssue}
                onToggleAll={handleToggleAll}
                collapsed={collapsedIds.has(company.id)}
                onToggleCollapse={() => handleToggleCollapse(company.id)}
                onStatusChange={handleStatusChange}
                onNewIssue={handleNewIssue}
                onOpenPreview={(issue) => setPreviewIssue(issue)}
              />
            );
          })
        )}
      </div>

      {selectedIds.size > 0 && (
        <BulkActionsBar
          count={selectedIds.size}
          onStatusChange={handleBulkStatusChange}
          onComment={() => setCommentOpen(true)}
          onClear={() => setSelectedIds(new Set())}
          commentOpen={commentOpen}
          setCommentOpen={setCommentOpen}
          commentText={commentText}
          setCommentText={setCommentText}
          onSubmitComment={handleBulkComment}
          isPending={commentMutation.isPending}
          labelsByCompanyId={labelsByCompanyId}
          companies={companies}
          selectedIssues={selectedIssues}
          onToggleLabel={handleBulkToggleLabel}
        />
      )}

      <IssuePreviewSheet
        issue={previewIssue}
        companyPrefix={
          previewIssue
            ? companies.find((c) => c.id === previewIssue.companyId)?.issuePrefix ?? null
            : null
        }
        agentNameById={agentNameById}
        labels={previewIssue ? labelsByCompanyId.get(previewIssue.companyId) ?? [] : []}
        onOpenChange={(open) => {
          if (!open) setPreviewIssue(null);
        }}
      />
    </div>
  );
}
