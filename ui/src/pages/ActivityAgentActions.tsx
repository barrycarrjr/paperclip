import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Download, ScrollText } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { auditApi, type AuditActionFilters, type AuditActionRecord } from "../api/audit";
import { ApiError } from "../api/client";
import { EmptyState } from "../components/EmptyState";
import { Identity } from "../components/Identity";
import { useToastActions } from "../context/ToastContext";
import { activityEntityName, activityEntityTitle } from "../lib/activity-entity-names";
import { formatActivityVerb } from "../lib/activity-format";
import { buildCompanyUserProfileMap, type CompanyUserProfile } from "../lib/company-members";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";

const PAGE_SIZE = 50;
const ALL = "__all";

/** Action prefixes offered in the filter (the server matches the start). */
const ACTION_PREFIXES: { value: string; label: string }[] = [
  { value: ALL, label: "All actions" },
  { value: "issue.", label: "Tasks" },
  { value: "agent.", label: "Agents" },
  { value: "heartbeat.", label: "Runs" },
  { value: "approval.", label: "Approvals" },
  { value: "project.", label: "Projects" },
  { value: "goal.", label: "Goals" },
  { value: "cost.", label: "Costs" },
  { value: "company.", label: "Company" },
];

/** What the action was done to (the server matches exactly). */
const ENTITY_TYPES: { value: string; label: string }[] = [
  { value: ALL, label: "All types" },
  { value: "issue", label: "Task" },
  { value: "agent", label: "Agent" },
  { value: "heartbeat_run", label: "Run" },
  { value: "routine", label: "Automation" },
  { value: "project", label: "Project" },
  { value: "goal", label: "Goal" },
  { value: "company", label: "Company" },
];

const ACTOR_TYPE_LABELS: Record<string, string> = {
  agent: "Agent",
  user: "User",
  system: "System",
  plugin: "Plugin",
};

// Dates are whole days in the viewer's own time, as on the Costs page.
function startOfDayIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function endOfDayIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T23:59:59.999`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function ActionTarget({ record, agentMap }: { record: AuditActionRecord; agentMap: Map<string, Agent> }) {
  const { issue, document } = record.entity;
  if (issue) {
    return (
      <Link to={`/issues/${issue.identifier ?? issue.id}`} className="font-medium hover:underline">
        {issue.identifier ?? "the task"}
        {issue.title ? <span className="ml-1 font-normal text-muted-foreground">{issue.title}</span> : null}
      </Link>
    );
  }
  if (document) {
    return <span className="font-medium">{document.key}</span>;
  }
  const targetAgent = record.entityType === "agent" ? agentMap.get(record.entityId) : undefined;
  if (targetAgent) {
    return (
      <Link to={`/agents/${targetAgent.id}`} className="font-medium hover:underline">
        {targetAgent.name}
      </Link>
    );
  }
  // Nothing to link to, such as a deleted task: name it from the row itself.
  const name = activityEntityName(record);
  const title = activityEntityTitle(record);
  if (name || title) {
    return (
      <span>
        {name ? <span className="font-medium">{name}</span> : null}
        {title ? <span className={cn("text-muted-foreground", name && "ml-1")}>{title}</span> : null}
      </span>
    );
  }
  return <span className="text-muted-foreground">{record.entityType.replaceAll("_", " ")}</span>;
}

function AgentActionRow({
  record,
  agentMap,
  userProfileMap,
}: {
  record: AuditActionRecord;
  agentMap: Map<string, Agent>;
  userProfileMap: Map<string, CompanyUserProfile>;
}) {
  const verb = formatActivityVerb(record.action, record.details, { agentMap, userProfileMap });
  const actorAgentId = record.agentId ?? (record.actorType === "agent" ? record.actorId : null);
  const actorAgent = actorAgentId ? agentMap.get(actorAgentId) : undefined;
  const actorUser = record.actorType === "user" && record.actorId ? userProfileMap.get(record.actorId) : undefined;
  const actorName = actorAgent?.name ?? actorUser?.label ?? ACTOR_TYPE_LABELS[record.actorType ?? "system"] ?? "System";
  // No "on behalf of" when the person is the one who acted.
  const showOnBehalf = Boolean(
    record.responsibleUserId
      && !(record.actorType === "user" && record.actorId === record.responsibleUserId),
  );
  const responsibleLabel = record.responsibleUserId
    ? userProfileMap.get(record.responsibleUserId)?.label ?? "a user"
    : null;
  const excerpt = record.entity.comment?.excerpt?.trim();

  return (
    <li className="px-4 py-2 text-sm">
      <div className="flex gap-3">
        <p className="min-w-0 flex-1">
          <Identity
            name={actorName}
            avatarUrl={actorUser?.image ?? null}
            size="xs"
            className="align-middle"
          />
          <span className="ml-1 text-muted-foreground">{verb} </span>
          <ActionTarget record={record} agentMap={agentMap} />
        </p>
        <time
          className="shrink-0 pt-0.5 text-xs text-muted-foreground"
          dateTime={record.createdAt}
          title={new Date(record.createdAt).toLocaleString()}
        >
          {timeAgo(record.createdAt)}
        </time>
      </div>
      {excerpt ? (
        <p className="mt-1 line-clamp-2 border-l-2 border-border pl-2 text-muted-foreground">{excerpt}</p>
      ) : null}
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {showOnBehalf && responsibleLabel ? (
          <span className="rounded-full bg-muted px-2 py-0.5">on behalf of {responsibleLabel}</span>
        ) : null}
        {record.runId && record.agentId ? (
          <Link to={`/agents/${record.agentId}/runs/${record.runId}`} className="hover:underline">
            View run
          </Link>
        ) : null}
        <span className="font-mono">{record.action}</span>
      </div>
    </li>
  );
}

/**
 * The Activity page's "Agent actions" view: every recorded action by an
 * agent, with the person responsible and the run behind it. Only shown to
 * people with "View agent audit actions"; the server checks it again.
 */
export function ActivityAgentActions({ companyId }: { companyId: string }) {
  const { pushToast } = useToastActions();
  const [agent, setAgent] = useState(ALL);
  const [responsibleUser, setResponsibleUser] = useState(ALL);
  const [actionPrefix, setActionPrefix] = useState(ALL);
  const [entityType, setEntityType] = useState(ALL);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [downloading, setDownloading] = useState(false);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const { data: userDirectory } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
  });

  const agentMap = useMemo(() => new Map((agents ?? []).map((a) => [a.id, a])), [agents]);
  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(userDirectory?.users),
    [userDirectory?.users],
  );

  const filters: AuditActionFilters = {
    agentId: agent === ALL ? undefined : agent,
    responsibleUserId: responsibleUser === ALL ? undefined : responsibleUser,
    action: actionPrefix === ALL ? undefined : actionPrefix,
    entityType: entityType === ALL ? undefined : entityType,
    from: startOfDayIso(dateFrom),
    to: endOfDayIso(dateTo),
  };
  const hasActiveFilters = Boolean(
    agent !== ALL || responsibleUser !== ALL || actionPrefix !== ALL || entityType !== ALL || dateFrom || dateTo,
  );

  const feed = useInfiniteQuery({
    queryKey: queryKeys.audit.agentActions(companyId, filters),
    queryFn: ({ pageParam }) =>
      auditApi.listAgentActions(companyId, { ...filters, limit: PAGE_SIZE, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    retry: (count, error) => !(error instanceof ApiError && error.status === 403) && count < 2,
  });
  const items = useMemo(() => feed.data?.pages.flatMap((page) => page.items) ?? [], [feed.data]);

  const clearFilters = () => {
    setAgent(ALL);
    setResponsibleUser(ALL);
    setActionPrefix(ALL);
    setEntityType(ALL);
    setDateFrom("");
    setDateTo("");
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const { blob, truncated, rowCount } = await auditApi.exportAgentActionsCsv(companyId, filters);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `agent-audit-${companyId}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Browsers may read a blob address after click() returns, so keep it
      // alive long enough for the download to start.
      window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
      pushToast(
        truncated
          ? {
            title: "Download started, but the file is not complete",
            body: `It holds only the newest ${rowCount === null ? "" : `${rowCount.toLocaleString()} `}actions. Narrow the filters or dates to get the rest.`,
            tone: "warn",
          }
          : { title: "Download started", tone: "success" },
      );
    } catch (error) {
      pushToast({
        title: "Download failed",
        body: error instanceof Error ? error.message : "Could not download the CSV.",
        tone: "error",
      });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={agent} onValueChange={setAgent}>
          <SelectTrigger aria-label="Agent" className="w-[150px]">
            <SelectValue placeholder="Agent" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All agents</SelectItem>
            {(agents ?? []).map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={responsibleUser} onValueChange={setResponsibleUser}>
          <SelectTrigger aria-label="Responsible user" className="w-[200px]">
            <SelectValue placeholder="Responsible user" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All responsible users</SelectItem>
            {(userDirectory?.users ?? []).map((u) => (
              <SelectItem key={u.principalId} value={u.principalId}>
                {userProfileMap.get(u.principalId)?.label ?? u.principalId.slice(0, 8)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={actionPrefix} onValueChange={setActionPrefix}>
          <SelectTrigger aria-label="Action" className="w-[140px]">
            <SelectValue placeholder="Action" />
          </SelectTrigger>
          <SelectContent>
            {ACTION_PREFIXES.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={entityType} onValueChange={setEntityType}>
          <SelectTrigger aria-label="Type" className="w-[140px]">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            {ENTITY_TYPES.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* One group, so the two dates wrap onto a new line together. */}
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <label className="flex items-center gap-2">
            From
            <Input
              type="date"
              value={dateFrom}
              max={dateTo || undefined}
              onChange={(event) => setDateFrom(event.target.value)}
              className="w-[150px]"
            />
          </label>
          <label className="flex items-center gap-2">
            to
            <Input
              type="date"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(event) => setDateTo(event.target.value)}
              className="w-[150px]"
            />
          </label>
        </div>
        {hasActiveFilters ? (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={handleDownload}
          disabled={downloading || feed.isLoading || items.length === 0}
        >
          <Download className="mr-1.5 h-3.5 w-3.5" />
          {downloading ? "Downloading..." : "Download CSV"}
        </Button>
      </div>

      {feed.isLoading ? (
        <div className="space-y-1">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-11 w-full rounded-none" />
          ))}
        </div>
      ) : feed.error ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-destructive">{feed.error.message}</p>
          <Button variant="outline" size="sm" onClick={() => feed.refetch()}>
            Try again
          </Button>
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          message={hasActiveFilters ? "No agent actions match these filters." : "No agent actions yet."}
        />
      ) : (
        <ul aria-label="Agent actions" className="border border-border rounded-md divide-y divide-border">
          {items.map((record) => (
            <AgentActionRow
              key={record.id}
              record={record}
              agentMap={agentMap}
              userProfileMap={userProfileMap}
            />
          ))}
        </ul>
      )}

      {feed.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => feed.fetchNextPage()}
            disabled={feed.isFetchingNextPage}
          >
            {feed.isFetchingNextPage ? "Loading..." : "Load more"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
