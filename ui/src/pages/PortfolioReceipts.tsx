import { useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { History, Sparkles } from "lucide-react";
import type { ActivityEvent, Company } from "@paperclipai/shared";
import { activityApi } from "../api/activity";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import {
  summarizeOutcome,
  isOutcomeAction,
  OUTCOME_CATEGORY_LABELS,
  type OutcomeCategory,
} from "../lib/outcomes";

const PORTFOLIO_RECEIPTS_LIMIT = 800;
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
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [companyFilter, setCompanyFilter] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Portfolio Receipts" }]);
  }, [setBreadcrumbs]);

  const isPortfolioRoot = selectedCompany?.isPortfolioRoot ?? false;

  const { data, isLoading, error } = useQuery({
    queryKey: ["portfolio-activity", "receipts", selectedCompanyId, PORTFOLIO_RECEIPTS_LIMIT],
    queryFn: () =>
      activityApi.listPortfolio(selectedCompanyId!, { limit: PORTFOLIO_RECEIPTS_LIMIT }),
    enabled: !!selectedCompanyId && isPortfolioRoot,
  });

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
      const o = summarizeOutcome(event);
      counts[o.category] += 1;
    }
    return counts;
  }, [outcomes, companyFilter]);

  const filtered = useMemo(() => {
    return outcomes.filter((event) => {
      if (companyFilter && event.companyId !== companyFilter) return false;
      if (filter === "all") return true;
      return summarizeOutcome(event).category === filter;
    });
  }, [outcomes, filter, companyFilter]);

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
                <span className="ml-1.5 text-[10px] tabular-nums text-muted-foreground/70">{count}</span>
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
              ? companyFilter
                ? "No outcomes for this company yet."
                : "No outcomes across the portfolio yet."
              : `No ${OUTCOME_CATEGORY_LABELS[filter].toLowerCase()} ${companyFilter ? "for this company " : ""}yet.`
          }
        />
      ) : (
        <div className="border border-border bg-card">
          {groupedByDay.map((group, gi) => (
            <div key={group.label} className={cn(gi > 0 && "border-t border-border")}>
              <div className="px-4 py-2.5 flex items-baseline justify-between border-b border-border bg-muted/20">
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em]">
                  {group.label}
                </span>
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {group.events.length} outcome{group.events.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="divide-y divide-border">
                {group.events.map((event) => (
                  <PortfolioReceiptRow
                    key={event.id}
                    event={event}
                    company={companyMap.get(event.companyId)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface PortfolioReceiptRowProps {
  event: ActivityEvent;
  company: Company | undefined;
}

function PortfolioReceiptRow({ event, company }: PortfolioReceiptRowProps) {
  const outcome = summarizeOutcome(event);
  const prefix = company?.issuePrefix;

  const link =
    prefix
      ? event.entityType === "issue"
        ? `/${prefix}/issues/${event.entityId}`
        : event.entityType === "approval"
          ? `/${prefix}/approvals/${event.entityId}`
          : event.entityType === "agent"
            ? `/${prefix}/agents/${event.entityId}`
            : event.entityType === "project"
              ? `/${prefix}/projects/${event.entityId}`
              : event.entityType === "goal"
                ? `/${prefix}/goals/${event.entityId}`
                : null
      : null;

  const chipClass = {
    emerald: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    amber: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    sky: "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400",
    violet: "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400",
    red: "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400",
    muted: "border-border bg-muted/40 text-muted-foreground",
  }[outcome.tone];

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
          <span>·</span>
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
  );

  return link ? (
    <Link to={link} className="block hover:bg-accent/40 transition-colors no-underline text-inherit">
      {inner}
    </Link>
  ) : (
    <div>{inner}</div>
  );
}
