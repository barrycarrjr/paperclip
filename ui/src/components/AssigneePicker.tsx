import { useMemo, useState } from "react";
import { ArrowUpRight, Bot, User } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  buildCompanyUserInlineOptions,
  buildCompanyUserLabelMap,
} from "../lib/company-members";
import { formatAssigneeUserLabel } from "../lib/assignees";
import { queryKeys } from "../lib/queryKeys";
import {
  getRecentAssigneeIds,
  getRecentAssigneeSelectionIds,
  sortAgentsByRecency,
  trackRecentAssignee,
  trackRecentAssigneeUser,
} from "../lib/recent-assignees";
import { orderItemsBySelectedAndRecent } from "../lib/recent-selections";
import { cn } from "../lib/utils";
import { AgentIcon } from "./AgentIconPicker";
import { Identity } from "./Identity";

export interface AssigneePickerChange {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

interface AssigneePickerProps {
  /** Company the issue belongs to. Falls back to the active company in context if not provided. */
  companyId?: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  /** Used to offer an "Assign to <creator>" option. */
  createdByUserId?: string | null;
  /** Display the agent name without re-fetching agents just for the trigger label. */
  assigneeAgentName?: string | null;
  onChange: (next: AssigneePickerChange) => void;
  /** Inline (mobile collapsible) vs popover (default desktop). */
  inline?: boolean;
  /** Compact list-row variant — icon + small chip suitable for dense rows. */
  compact?: boolean;
  /** Optional element rendered next to the trigger (e.g. an arrow link to the agent profile). */
  trailing?: React.ReactNode;
  /** Render an arrow link to the assigned agent's profile when an agent is assigned. */
  showAgentLink?: boolean;
  className?: string;
}

/**
 * Inline assignee picker reused by IssueProperties (full issue page), IssuePreviewSheet,
 * and PortfolioIssueRow. Loads agents and company members lazily on first popover open.
 */
export function AssigneePicker({
  companyId: companyIdProp,
  assigneeAgentId,
  assigneeUserId,
  createdByUserId,
  assigneeAgentName,
  onChange,
  inline,
  compact,
  trailing,
  showAgentLink,
  className,
}: AssigneePickerProps) {
  const { selectedCompanyId } = useCompany();
  const companyId = companyIdProp ?? selectedCompanyId ?? null;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId;

  // Lazy-load agents and the user directory only when the picker actually opens.
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId!),
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId && open,
  });
  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId!),
    queryFn: () => accessApi.listUserDirectory(companyId!),
    enabled: !!companyId && open,
  });

  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), [open]);
  const recentAssigneeSelectionIds = useMemo(() => getRecentAssigneeSelectionIds(), [open]);
  const sortedAgents = useMemo(
    () => sortAgentsByRecency((agents ?? []).filter((a) => a.status !== "terminated"), recentAssigneeIds),
    [agents, recentAssigneeIds],
  );
  const userLabelMap = useMemo(
    () => buildCompanyUserLabelMap(companyMembers?.users),
    [companyMembers?.users],
  );
  const otherUserOptions = useMemo(
    () =>
      buildCompanyUserInlineOptions(companyMembers?.users, {
        excludeUserIds: [currentUserId, createdByUserId],
      }),
    [companyMembers?.users, currentUserId, createdByUserId],
  );

  const userLabel = (userId: string | null | undefined) =>
    formatAssigneeUserLabel(userId, currentUserId, userLabelMap);

  const assignedAgent = assigneeAgentId
    ? agents?.find((a) => a.id === assigneeAgentId)
    : null;
  const assigneeUserLabelText = userLabel(assigneeUserId);
  // Prefer caller-supplied name (e.g. from portfolio agentNameById) so the trigger
  // doesn't need to wait for the lazy agents query to populate.
  const triggerAgentName = assignedAgent?.name ?? assigneeAgentName ?? null;
  const creatorUserLabel = userLabel(createdByUserId ?? null);

  const selectedAssigneeValue = assigneeAgentId
    ? `agent:${assigneeAgentId}`
    : assigneeUserId
      ? `user:${assigneeUserId}`
      : "";

  const triggerContent = triggerAgentName ? (
    compact ? (
      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground max-w-[120px]">
        <Bot className="h-3 w-3 shrink-0" />
        <span className="truncate">{triggerAgentName}</span>
      </span>
    ) : (
      <Identity name={triggerAgentName} size="sm" />
    )
  ) : assigneeUserLabelText ? (
    compact ? (
      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground max-w-[120px]">
        <User className="h-3 w-3 shrink-0" />
        <span className="truncate">{assigneeUserLabelText}</span>
      </span>
    ) : (
      <>
        <User className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-sm">{assigneeUserLabelText}</span>
      </>
    )
  ) : compact ? (
    <span className="inline-flex items-center text-[11px] text-muted-foreground/50 italic">
      unassigned
    </span>
  ) : (
    <>
      <User className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-sm text-muted-foreground">Unassigned</span>
    </>
  );

  const pickerOptions = orderItemsBySelectedAndRecent(
    [
      { id: "", kind: "none" as const, label: "No assignee", searchText: "" },
      ...(currentUserId
        ? [{
            id: `user:${currentUserId}`,
            kind: "user" as const,
            userId: currentUserId,
            label: "Assign to me",
            searchText: userLabel(currentUserId) ?? "",
          }]
        : []),
      ...(createdByUserId && createdByUserId !== currentUserId
        ? [{
            id: `user:${createdByUserId}`,
            kind: "user" as const,
            userId: createdByUserId,
            label: creatorUserLabel ? `Assign to ${creatorUserLabel}` : "Assign to requester",
            searchText: creatorUserLabel ?? "requester",
          }]
        : []),
      ...otherUserOptions.map((option) => ({
        id: option.id,
        kind: "user" as const,
        userId: option.id.slice("user:".length),
        label: option.label,
        searchText: option.searchText ?? "",
      })),
      ...sortedAgents.map((agent) => ({
        id: `agent:${agent.id}`,
        kind: "agent" as const,
        agent,
        label: agent.name,
        searchText: `${agent.name} ${agent.role} ${agent.title ?? ""}`,
      })),
    ],
    selectedAssigneeValue,
    recentAssigneeSelectionIds,
  );

  function selectOption(option: (typeof pickerOptions)[number]) {
    if (option.kind === "agent") {
      trackRecentAssignee(option.agent.id);
      onChange({ assigneeAgentId: option.agent.id, assigneeUserId: null });
    } else if (option.kind === "user") {
      trackRecentAssigneeUser(option.userId);
      onChange({ assigneeAgentId: null, assigneeUserId: option.userId });
    } else {
      onChange({ assigneeAgentId: null, assigneeUserId: null });
    }
    setOpen(false);
    setSearch("");
  }

  const filteredOptions = pickerOptions.filter((option) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return `${option.label} ${option.searchText}`.toLowerCase().includes(q);
  });

  const pickerContent = (
    <>
      <input
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
        placeholder="Search assignees..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        autoFocus={!inline}
      />
      <div className="max-h-48 overflow-y-auto overscroll-contain">
        {filteredOptions.map((option) => (
          <button
            key={option.id || "__none__"}
            type="button"
            className={cn(
              "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
              option.id === selectedAssigneeValue && "bg-accent",
            )}
            onClick={() => selectOption(option)}
          >
            {option.kind === "agent" ? (
              <AgentIcon icon={option.agent.icon} className="shrink-0 h-3 w-3 text-muted-foreground" />
            ) : option.kind === "user" ? (
              <User className="h-3 w-3 shrink-0 text-muted-foreground" />
            ) : null}
            {option.label}
          </button>
        ))}
      </div>
    </>
  );

  const triggerButton = (
    <button
      type="button"
      className={cn(
        "inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors min-w-0 max-w-full text-left",
        className,
      )}
    >
      {triggerContent}
    </button>
  );

  const agentLink = showAgentLink && assigneeAgentId ? (
    <Link
      to={`/agents/${assigneeAgentId}`}
      className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-accent/50 transition-colors text-muted-foreground hover:text-foreground"
      onClick={(e) => e.stopPropagation()}
    >
      <ArrowUpRight className="h-3 w-3" />
    </Link>
  ) : null;

  if (inline) {
    return (
      <>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors min-w-0 max-w-full text-left",
            className,
          )}
          onClick={() => setOpen((prev) => !prev)}
        >
          {triggerContent}
        </button>
        {trailing}
        {agentLink}
        {open && (
          <div className="rounded-md border border-border bg-popover p-1 mb-2 w-full">
            {pickerContent}
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setSearch("");
        }}
      >
        <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
        <PopoverContent className="w-52 p-1" align="end" collisionPadding={16}>
          {pickerContent}
        </PopoverContent>
      </Popover>
      {trailing}
      {agentLink}
    </>
  );
}
