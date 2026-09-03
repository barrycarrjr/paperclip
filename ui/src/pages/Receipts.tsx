import { useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { History, Sparkles } from "lucide-react";
import type { ActivityEvent, Agent } from "@paperclipai/shared";
import { activityApi } from "../api/activity";
import { agentsApi } from "../api/agents";
import { accessApi } from "../api/access";
import { useActiveCompanyId } from "../hooks/useRouteCompany";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { PageTabBar } from "../components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { Identity } from "../components/Identity";
import { entityLink } from "../components/ActivityRow";
import { activityEntityName } from "../lib/activity-entity-names";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import { buildCompanyUserProfileMap, type CompanyUserProfile } from "../lib/company-members";
import {
  summarizeOutcome,
  isOutcomeAction,
  OUTCOME_CATEGORY_LABELS,
  OUTCOME_TONE_CLASS,
  type OutcomeCategory,
} from "../lib/outcomes";

const RECEIPTS_LIMIT = 500;
type FilterKey = OutcomeCategory | "all";

const FILTER_ORDER: FilterKey[] = [
  "all",
  "draft",
  "approval",
  "issue",
  "agent",
  "project",
  "goal",
  "system",
  "other",
];

function dayKey(d: Date): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const eventDay = new Date(d);
  eventDay.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today.getTime() - eventDay.getTime()) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) {
    return eventDay.toLocaleDateString(undefined, { weekday: "long" });
  }
  return eventDay.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function dayHeaderLabel(d: Date): string {
  const key = dayKey(d);
  if (key === "Today" || key === "Yesterday") {
    const date = d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    return `${key} · ${date}`;
  }
  return key;
}

export function Receipts() {
  // URL-derived, not useCompany()'s selection state (P4 sweep, 2026-09-03) —
  // see Calendar.tsx's identical fix for the general pattern.
  const selectedCompanyId = useActiveCompanyId();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [filter, setFilter] = useState<FilterKey>("all");

  useEffect(() => {
    setBreadcrumbs([{ label: "Receipts" }]);
  }, [setBreadcrumbs]);

  const { data: activity, isLoading, error } = useQuery({
    queryKey: [...queryKeys.activity(selectedCompanyId!), { limit: RECEIPTS_LIMIT, view: "receipts" }],
    queryFn: () => activityApi.list(selectedCompanyId!, { limit: RECEIPTS_LIMIT }),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: members } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(members?.users),
    [members?.users],
  );

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const outcomes = useMemo(() => {
    if (!activity) return [];
    return activity.filter((e) => isOutcomeAction(e.action));
  }, [activity]);

  const categoryCounts = useMemo(() => {
    const counts: Record<FilterKey, number> = {
      all: outcomes.length,
      draft: 0,
      approval: 0,
      issue: 0,
      agent: 0,
      project: 0,
      goal: 0,
      system: 0,
      other: 0,
    };
    for (const event of outcomes) {
      const o = summarizeOutcome(event, { agentMap });
      counts[o.category] += 1;
    }
    return counts;
  }, [outcomes, agentMap]);

  const filtered = useMemo(() => {
    if (filter === "all") return outcomes;
    return outcomes.filter((e) => summarizeOutcome(e, { agentMap }).category === filter);
  }, [outcomes, agentMap, filter]);

  const groupedByDay = useMemo(() => {
    const groups = new Map<string, { label: string; date: Date; events: ActivityEvent[] }>();
    for (const event of filtered) {
      const d = new Date(event.createdAt);
      const key = dayKey(d);
      const existing = groups.get(key);
      if (existing) {
        existing.events.push(event);
      } else {
        groups.set(key, { label: dayHeaderLabel(d), date: d, events: [event] });
      }
    }
    return Array.from(groups.values()).sort((a, b) => b.date.getTime() - a.date.getTime());
  }, [filtered]);

  if (!selectedCompanyId) {
    return <EmptyState icon={History} message="Select a company to view its receipt feed." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  // Zero-count tabs are hidden rather than disabled (PageTabBar has no
  // disabled state). The active tab always stays visible so the selection
  // never points at a tab that is not on screen.
  const tabItems = FILTER_ORDER
    .filter((key) => key === "all" || key === filter || categoryCounts[key] > 0)
    .map((key) => ({
      value: key,
      label: (
        <>
          {OUTCOME_CATEGORY_LABELS[key]}
          <span className="ml-1.5 text-[10px] tabular-nums text-muted-foreground/70">
            {categoryCounts[key]}
          </span>
        </>
      ),
    }));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Receipts</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What your agents actually did, framed as outcomes — drafts, approvals, issues, and more.
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {/* Filter tabs */}
      <Tabs value={filter} onValueChange={(v) => setFilter(v as FilterKey)}>
        <PageTabBar align="start" items={tabItems} />
      </Tabs>

      {filtered.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          message={
            filter === "all"
              ? "No outcomes yet. Your agents will start filling this up as they work."
              : `No ${OUTCOME_CATEGORY_LABELS[filter].toLowerCase()} yet.`
          }
        />
      ) : (
        <div className="border border-border rounded-md overflow-hidden bg-card">
          {groupedByDay.map((group, gi) => {
            const total = group.events.length;
            return (
              <div key={group.label} className={cn(gi > 0 && "border-t border-border")}>
                <div className="px-4 py-2 flex items-baseline justify-between border-b border-border bg-muted/50">
                  <span className="text-sm font-medium">{group.label}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {total} outcome{total === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="divide-y divide-border">
                  {group.events.map((event) => (
                    <ReceiptRow
                      key={event.id}
                      event={event}
                      agentMap={agentMap}
                      userProfileMap={userProfileMap}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {activity && activity.length === RECEIPTS_LIMIT && (
        <p className="px-4 py-2 text-xs text-muted-foreground">
          Showing outcomes from the latest {RECEIPTS_LIMIT} events.
        </p>
      )}
    </div>
  );
}

interface ReceiptRowProps {
  event: ActivityEvent;
  agentMap: Map<string, Agent>;
  userProfileMap: Map<string, CompanyUserProfile>;
}

function ReceiptRow({ event, agentMap, userProfileMap }: ReceiptRowProps) {
  const outcome = summarizeOutcome(event, { agentMap });
  const actorName =
    event.actorType === "agent"
      ? agentMap.get(event.actorId)?.name
      : event.actorType === "user"
        ? userProfileMap.get(event.actorId)?.label ?? null
        : event.actorType === "system"
          ? "System"
          : null;

  const link = entityLink(event.entityType, event.entityId, activityEntityName(event));

  const time = new Date(event.createdAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

  const inner = (
    <div className="grid grid-cols-[68px_1fr_auto] gap-3 items-center px-4 py-2.5">
      <span className="text-[11px] tabular-nums text-muted-foreground">{time}</span>
      <div className="min-w-0">
        <div className="text-sm">
          <span className="font-medium">{outcome.verb}</span>
          {outcome.target && (
            <span className="text-muted-foreground"> {outcome.target}</span>
          )}
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground flex items-center gap-1.5 flex-wrap">
          {actorName && (
            <>
              <Identity name={actorName} size="xs" />
              <span>·</span>
            </>
          )}
          <span>{event.entityType}</span>
          <span>·</span>
          <span className="text-muted-foreground/70 tabular-nums">{timeAgo(event.createdAt)}</span>
        </div>
      </div>
      <span className={OUTCOME_TONE_CLASS[outcome.tone]}>{outcome.chip}</span>
    </div>
  );

  return link ? (
    <Link to={link} className="block hover:bg-accent/40 transition-colors no-underline text-inherit">
      {inner}
    </Link>
  ) : (
    <div>{inner}</div>
  );
}
