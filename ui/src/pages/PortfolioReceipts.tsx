import { useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { History, Sparkles } from "lucide-react";
import type { ActivityEvent, Agent, Company } from "@paperclipai/shared";
import { activityApi } from "../api/activity";
import { agentsApi } from "../api/agents";
import { useActiveCompanyId, useIsActiveCompanyPortfolioRoot } from "../hooks/useRouteCompany";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { PageTabBar } from "../components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { Identity } from "../components/Identity";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { entityLink } from "../components/ActivityRow";
import { activityEntityName } from "../lib/activity-entity-names";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import {
  summarizeOutcome,
  isOutcomeAction,
  OUTCOME_CATEGORY_LABELS,
  OUTCOME_TONE_CLASS,
  type OutcomeCategory,
} from "../lib/outcomes";

const PORTFOLIO_RECEIPTS_LIMIT = 500;
// The server fetches up to PORTFOLIO_RECEIPTS_LIMIT events per company, merges
// every company's feed, then slices the merged list to this many events total.
const PORTFOLIO_MERGED_EVENT_CAP = 200;
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

export function PortfolioReceipts() {
  // Both URL-derived, not useCompany()'s selection state (P4 sweep,
  // 2026-09-03) — same shape as Everything.tsx/PortfolioEmail.tsx.
  const selectedCompanyId = useActiveCompanyId();
  const isPortfolioRoot = useIsActiveCompanyPortfolioRoot();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [companyFilter, setCompanyFilter] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Portfolio Receipts" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["portfolio-activity", "receipts", selectedCompanyId, PORTFOLIO_RECEIPTS_LIMIT],
    queryFn: () =>
      activityApi.listPortfolio(selectedCompanyId!, { limit: PORTFOLIO_RECEIPTS_LIMIT }),
    enabled: !!selectedCompanyId && isPortfolioRoot,
  });

  // One portfolio-wide agents fetch so rows can show which agent acted.
  const { data: portfolioAgentsData } = useQuery({
    queryKey: ["portfolio-receipts", "agents", selectedCompanyId],
    queryFn: () => agentsApi.listPortfolio(selectedCompanyId!),
    enabled: !!selectedCompanyId && isPortfolioRoot,
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of portfolioAgentsData?.agents ?? []) map.set(a.id, a);
    return map;
  }, [portfolioAgentsData?.agents]);

  const companyMap = useMemo(() => {
    const map = new Map<string, Company>();
    for (const c of data?.companies ?? []) map.set(c.id, c);
    return map;
  }, [data?.companies]);

  const companies = useMemo(() => {
    return Array.from(companyMap.values())
      .filter((c) => !c.isPortfolioRoot && c.status !== "archived")
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [companyMap]);

  const outcomes = useMemo(() => {
    const events = data?.events ?? [];
    return events.filter((e) => isOutcomeAction(e.action));
  }, [data?.events]);

  const categoryCounts = useMemo(() => {
    const counts: Record<FilterKey, number> = {
      all: 0,
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
      if (companyFilter && event.companyId !== companyFilter) continue;
      counts.all += 1;
      const o = summarizeOutcome(event, { agentMap });
      counts[o.category] += 1;
    }
    return counts;
  }, [outcomes, agentMap, companyFilter]);

  const filtered = useMemo(() => {
    return outcomes.filter((event) => {
      if (companyFilter && event.companyId !== companyFilter) return false;
      if (filter === "all") return true;
      return summarizeOutcome(event, { agentMap }).category === filter;
    });
  }, [outcomes, agentMap, filter, companyFilter]);

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
    return <EmptyState icon={History} message="Select a company to view receipts." />;
  }
  if (!isPortfolioRoot) {
    return (
      <EmptyState
        icon={History}
        message="Portfolio Receipts is only available on the HQ (portfolio root) company. For a single-company view, use Receipts."
      />
    );
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
        <h1 className="text-2xl font-semibold tracking-tight">Portfolio Receipts</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Outcome-shaped activity across every company — drafts, approvals, issues, and more.
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {/* Filters: company chips + category tabs */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => setCompanyFilter(null)}
          className={cn(
            "inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] border transition-colors",
            companyFilter === null
              ? "border-foreground bg-foreground text-background"
              : "border-border bg-card text-muted-foreground hover:text-foreground",
          )}
        >
          All companies
        </button>
        {companies.map((c) => (
          <button
            key={c.id}
            onClick={() => setCompanyFilter(companyFilter === c.id ? null : c.id)}
            className={cn(
              "inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] border transition-colors",
              companyFilter === c.id
                ? "border-foreground"
                : "border-border bg-card text-muted-foreground hover:text-foreground",
            )}
          >
            <CompanyPatternIcon
              companyName={c.name}
              logoUrl={c.logoUrl}
              brandColor={c.brandColor}
              className="h-3.5 w-3.5 shrink-0 rounded-[2px]"
            />
            {c.name}
          </button>
        ))}
      </div>

      <Tabs value={filter} onValueChange={(v) => setFilter(v as FilterKey)}>
        <PageTabBar align="start" items={tabItems} />
      </Tabs>

      {filtered.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          message={
            filter === "all"
              ? companyFilter
                ? "No outcomes for this company yet."
                : "No outcomes across the portfolio yet."
              : `No ${OUTCOME_CATEGORY_LABELS[filter].toLowerCase()} ${companyFilter ? "for this company " : ""}yet.`
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
                    <PortfolioReceiptRow
                      key={event.id}
                      event={event}
                      company={companyMap.get(event.companyId)}
                      agentMap={agentMap}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {(data?.events.length ?? 0) >= PORTFOLIO_MERGED_EVENT_CAP && (
        <p className="px-4 py-2 text-xs text-muted-foreground">
          Showing outcomes from the latest events.
        </p>
      )}
    </div>
  );
}

interface PortfolioReceiptRowProps {
  event: ActivityEvent;
  company: Company | undefined;
  agentMap: Map<string, Agent>;
}

function PortfolioReceiptRow({ event, company, agentMap }: PortfolioReceiptRowProps) {
  const outcome = summarizeOutcome(event, { agentMap });
  const agentName =
    event.actorType === "agent" ? agentMap.get(event.actorId)?.name : undefined;

  const link = entityLink(event.entityType, event.entityId, activityEntityName(event), {
    companyPrefix: company?.issuePrefix ? `/${company.issuePrefix}` : null,
  });

  const time = new Date(event.createdAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

  const inner = (
    <div className="grid grid-cols-[64px_18px_1fr_auto] gap-3 items-center px-4 py-2.5">
      <span className="text-[11px] tabular-nums text-muted-foreground">{time}</span>
      {company ? (
        <CompanyPatternIcon
          companyName={company.name}
          logoUrl={company.logoUrl}
          brandColor={company.brandColor}
          className="h-4 w-4 shrink-0 rounded-[2px]"
        />
      ) : (
        <span className="h-4 w-4 shrink-0 rounded-[2px] bg-muted" />
      )}
      <div className="min-w-0">
        <div className="text-sm">
          <span className="font-medium">{outcome.verb}</span>
          {outcome.target && <span className="text-muted-foreground"> {outcome.target}</span>}
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground flex items-center gap-1.5 flex-wrap">
          {company && <span>{company.name}</span>}
          {agentName && (
            <>
              <span>·</span>
              <Identity name={agentName} size="xs" />
            </>
          )}
          <span>·</span>
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
