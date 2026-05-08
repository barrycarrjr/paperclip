import { useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { History, Sparkles } from "lucide-react";
import type { ActivityEvent, Agent } from "@paperclipai/shared";
import { activityApi } from "../api/activity";
import { agentsApi } from "../api/agents";
import { accessApi } from "../api/access";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Identity } from "../components/Identity";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import { buildCompanyUserProfileMap, type CompanyUserProfile } from "../lib/company-members";
import {
  summarizeOutcome,
  isOutcomeAction,
  OUTCOME_CATEGORY_LABELS,
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
  const { selectedCompanyId } = useCompany();
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
      <div className="border-b border-border">
        <div className="flex flex-wrap gap-0">
          {FILTER_ORDER.map((key) => {
            const count = categoryCounts[key];
            const active = filter === key;
            const disabled = key !== "all" && count === 0;
            return (
              <button
                key={key}
                onClick={() => !disabled && setFilter(key)}
                disabled={disabled}
                className={cn(
                  "px-3.5 py-2 text-[12px] -mb-px border-b-2 transition-colors",
                  active
                    ? "text-foreground border-foreground"
                    : "text-muted-foreground border-transparent hover:text-foreground",
                  disabled && "opacity-40 cursor-not-allowed hover:text-muted-foreground",
                )}
              >
                {OUTCOME_CATEGORY_LABELS[key]}
                <span className="ml-1.5 text-[10px] tabular-nums text-muted-foreground/70">
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

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
        <div className="border border-border bg-card">
          {groupedByDay.map((group, gi) => {
            const total = group.events.length;
            return (
              <div key={group.label} className={cn(gi > 0 && "border-t border-border")}>
                <div className="px-4 py-2.5 flex items-baseline justify-between border-b border-border bg-muted/20">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em]">
                    {group.label}
                  </span>
                  <span className="text-[11px] text-muted-foreground tabular-nums">
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

  const link =
    event.entityType === "issue"
      ? `/issues/${event.entityId}`
      : event.entityType === "approval"
        ? `/approvals/${event.entityId}`
        : event.entityType === "agent"
          ? `/agents/${event.entityId}`
          : event.entityType === "project"
            ? `/projects/${event.entityId}`
            : event.entityType === "goal"
              ? `/goals/${event.entityId}`
              : null;

  const chipClass = {
    emerald: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    amber: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    sky: "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400",
    violet: "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400",
    red: "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400",
    muted: "border-border bg-muted/40 text-muted-foreground",
  }[outcome.tone];

  const Wrapper = link
    ? ({ children }: { children: React.ReactNode }) => (
        <Link to={link} className="block hover:bg-accent/40 transition-colors no-underline text-inherit">
          {children}
        </Link>
      )
    : ({ children }: { children: React.ReactNode }) => <div>{children}</div>;

  const time = new Date(event.createdAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <Wrapper>
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
        <span
          className={cn(
            "inline-flex items-center px-2 py-0.5 text-[10px] font-medium border whitespace-nowrap",
            chipClass,
          )}
        >
          {outcome.chip}
        </span>
      </div>
    </Wrapper>
  );
}
