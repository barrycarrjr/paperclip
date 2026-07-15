import { startTransition, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import type { CalendarEvent, CalendarOccurrence, Company } from "@paperclipai/shared";
import { calendarApi } from "../api/calendar";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { useCurrentUserId } from "../hooks/useCurrentUserId";
import { queryKeys } from "../lib/queryKeys";
import { readLsFilter, writeLsFilter } from "../lib/persistFilter";
import { cn } from "../lib/utils";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { EmptyState } from "../components/EmptyState";
import { PageTabBar } from "../components/PageTabBar";
import { EventDialog } from "../components/calendar/EventDialog";
import { EventDetailDialog } from "../components/calendar/EventDetailDialog";
import { EventListRow } from "../components/calendar/EventListRow";
import { MonthGrid } from "../components/calendar/MonthGrid";
import { SourceLegend } from "../components/calendar/SourceLegend";
import {
  addMonths,
  formatMonthTitle,
  KNOWN_SOURCES,
  monthRange,
} from "../components/calendar/calendar-utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsContent } from "@/components/ui/tabs";

type PortfolioCalendarTab = "list" | "calendar";

const LS_STATUS_KEY = "paperclip:portfolio-calendar:statusFilter";
const LS_COMPANY_KEY = "paperclip:portfolio-calendar:companyFilter";

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

interface FilterPopoverProps {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}

function FilterPopover({ label, options, selected, onChange }: FilterPopoverProps) {
  function toggle(value: string) {
    onChange(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  }
  const activeLabel =
    selected.length > 0 && selected.length < options.length ? `${label}: ${selected.length}` : label;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "h-7 gap-1 text-xs",
            selected.length > 0 && selected.length < options.length && "border-primary/50 text-primary",
          )}
        >
          {activeLabel}
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48 p-1">
        {options.map((option) => (
          <button
            key={option.value}
            onClick={() => toggle(option.value)}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
          >
            <Checkbox
              checked={selected.includes(option.value)}
              onCheckedChange={() => toggle(option.value)}
              className="h-3.5 w-3.5"
            />
            <span className="flex-1 text-left">{option.label}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function CompanyBadge({ company }: { company: Company | undefined }) {
  if (!company) return null;
  return (
    <span className="flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
      <CompanyPatternIcon
        companyName={company.name}
        logoUrl={company.logoUrl}
        brandColor={company.brandColor}
        className="h-3 w-3 shrink-0 rounded-[2px]"
      />
      <span className="max-w-24 truncate">{company.name}</span>
    </span>
  );
}

export function PortfolioCalendar() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const currentUserId = useCurrentUserId();

  const activeTab: PortfolioCalendarTab = searchParams.get("tab") === "calendar" ? "calendar" : "list";

  const [viewMonth, setViewMonth] = useState<Date>(() => startOfMonth(new Date()));
  const [hiddenSources, setHiddenSources] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<string[]>(() => readLsFilter<string[]>(LS_STATUS_KEY, []));
  const [companyIdFilter, setCompanyIdFilter] = useState<string[]>(() => readLsFilter<string[]>(LS_COMPANY_KEY, []));
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailEventId, setDetailEventId] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; kind: "fire" | "delete" } | null>(null);

  useEffect(() => setBreadcrumbs([{ label: "Portfolio Calendar" }]), [setBreadcrumbs]);
  useEffect(() => writeLsFilter(LS_STATUS_KEY, statusFilter), [statusFilter]);
  useEffect(() => writeLsFilter(LS_COMPANY_KEY, companyIdFilter), [companyIdFilter]);

  const range = useMemo(() => monthRange(viewMonth), [viewMonth]);

  const {
    data: eventsData,
    isLoading: eventsLoading,
    error: eventsError,
  } = useQuery({
    queryKey: queryKeys.calendar.portfolioEvents(selectedCompanyId!, { statusFilter, companyIdFilter }),
    queryFn: () =>
      calendarApi.listPortfolioEvents(selectedCompanyId!, {
        status: statusFilter.length > 0 ? statusFilter : undefined,
        companyIds: companyIdFilter.length > 0 ? companyIdFilter : undefined,
      }),
    enabled: !!selectedCompanyId && activeTab === "list",
  });

  const {
    data: monthData,
    isLoading: monthLoading,
    error: monthError,
  } = useQuery({
    queryKey: queryKeys.calendar.portfolioMonth(selectedCompanyId!, range.from, range.to),
    queryFn: () => calendarApi.getPortfolioCalendar(selectedCompanyId!, range.from, range.to),
    enabled: !!selectedCompanyId && activeTab === "calendar",
  });

  const events = eventsData?.events ?? [];
  const companies = useMemo(() => {
    const raw = eventsData?.companies ?? monthData?.companies ?? [];
    return [...raw].sort((a, b) => (b.isPortfolioRoot ? 1 : 0) - (a.isPortfolioRoot ? 1 : 0));
  }, [eventsData?.companies, monthData?.companies]);

  const companyById = useMemo(() => new Map(companies.map((c) => [c.id, c])), [companies]);
  const companyOptions = useMemo(() => companies.map((c) => ({ value: c.id, label: c.name })), [companies]);

  const occurrences = useMemo<CalendarOccurrence[]>(() => {
    let list = monthData?.occurrences ?? [];
    if (companyIdFilter.length > 0) {
      const allowed = new Set(companyIdFilter);
      list = list.filter((occ) => allowed.has(occ.companyId));
    }
    if (statusFilter.length > 0) {
      const allowed = new Set(statusFilter);
      list = list.filter((occ) => allowed.has(occ.status));
    }
    return list;
  }, [monthData?.occurrences, companyIdFilter, statusFilter]);

  const fireMutation = useMutation({
    mutationFn: (id: string) => calendarApi.fireEvent(id),
    onMutate: (id) => setPending({ id, kind: "fire" }),
    onSettled: () => setPending(null),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["calendar"] });
      pushToast({ title: "Reminder fired", tone: "success" });
    },
    onError: (err) =>
      pushToast({
        title: "Failed to fire reminder",
        body: err instanceof Error ? err.message : "Please try again.",
        tone: "error",
      }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => calendarApi.deleteEvent(id),
    onMutate: (id) => setPending({ id, kind: "delete" }),
    onSettled: () => setPending(null),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["calendar"] });
      pushToast({ title: "Reminder deleted", tone: "success" });
    },
    onError: (err) =>
      pushToast({
        title: "Failed to delete reminder",
        body: err instanceof Error ? err.message : "Please try again.",
        tone: "error",
      }),
  });

  function handleTabChange(tab: string) {
    startTransition(() => {
      navigate(tab === "calendar" ? "/portfolio-calendar?tab=calendar" : "/portfolio-calendar");
    });
  }

  function toggleSource(source: string) {
    setHiddenSources((current) => {
      const next = new Set(current);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });
  }

  function isOwned(userId: string): boolean {
    return currentUserId == null || userId === currentUserId;
  }

  const hasFilters = statusFilter.length > 0 || companyIdFilter.length > 0;

  if (!selectedCompanyId) {
    return <EmptyState icon={CalendarDays} message="Select the portfolio root to view the portfolio calendar." />;
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Portfolio Calendar</h1>
        <p className="text-sm text-muted-foreground">
          Reminders and scheduled events across every company in the portfolio.
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <PageTabBar
          align="start"
          value={activeTab}
          onValueChange={handleTabChange}
          items={[
            { value: "list", label: "List" },
            { value: "calendar", label: "Calendar" },
          ]}
        />

        <div className="flex flex-wrap items-center gap-2 pt-4">
          <FilterPopover label="Status" options={STATUS_OPTIONS} selected={statusFilter} onChange={setStatusFilter} />
          {companyOptions.length > 0 ? (
            <FilterPopover
              label="Company"
              options={companyOptions}
              selected={companyIdFilter}
              onChange={setCompanyIdFilter}
            />
          ) : null}
          {hasFilters ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground"
              onClick={() => {
                setStatusFilter([]);
                setCompanyIdFilter([]);
              }}
            >
              Clear filters
            </Button>
          ) : null}
        </div>

        <TabsContent value="list" className="space-y-4">
          {eventsError ? (
            <Card>
              <CardContent className="pt-6 text-sm text-destructive">
                {eventsError instanceof Error ? eventsError.message : "Failed to load events."}
              </CardContent>
            </Card>
          ) : eventsLoading ? (
            <p className="py-8 text-sm text-muted-foreground">Loading events...</p>
          ) : events.length === 0 ? (
            <EmptyState icon={CalendarDays} message="No reminders found across the portfolio." />
          ) : (
            <div className="rounded-lg border border-border">
              {events.map((event) => {
                const owned = isOwned(event.userId);
                return (
                  <EventListRow
                    key={event.id}
                    event={event}
                    isOwned={owned}
                    ownerLabel={owned ? "You" : "Shared"}
                    companyBadge={<CompanyBadge company={companyById.get(event.companyId)} />}
                    pending={pending?.id === event.id ? pending.kind : null}
                    onOpen={() => {
                      setDetailEventId(event.id);
                      setDetailOpen(true);
                    }}
                    onEdit={() => {
                      setEditingEvent(event);
                      setDialogOpen(true);
                    }}
                    onFire={() => fireMutation.mutate(event.id)}
                    onDelete={() => deleteMutation.mutate(event.id)}
                  />
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="calendar" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Previous month"
                onClick={() => setViewMonth((current) => addMonths(current, -1))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="min-w-40 text-center text-sm font-semibold">{formatMonthTitle(viewMonth)}</span>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Next month"
                onClick={() => setViewMonth((current) => addMonths(current, 1))}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs"
                onClick={() => setViewMonth(startOfMonth(new Date()))}
              >
                Today
              </Button>
            </div>
            <SourceLegend sources={[...KNOWN_SOURCES]} hiddenSources={hiddenSources} onToggle={toggleSource} />
          </div>

          {monthError ? (
            <Card>
              <CardContent className="pt-6 text-sm text-destructive">
                {monthError instanceof Error ? monthError.message : "Failed to load calendar."}
              </CardContent>
            </Card>
          ) : (
            <div className="relative">
              {monthLoading ? (
                <p className="absolute -top-6 right-0 text-xs text-muted-foreground">Loading...</p>
              ) : null}
              <MonthGrid
                viewMonth={viewMonth}
                occurrences={occurrences}
                hiddenSources={hiddenSources}
                onSelectOccurrence={(occ) => {
                  setDetailEventId(occ.eventId);
                  setDetailOpen(true);
                }}
              />
            </div>
          )}
        </TabsContent>
      </Tabs>

      <EventDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        companyId={editingEvent?.companyId ?? selectedCompanyId}
        event={editingEvent}
      />

      <EventDetailDialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        eventId={detailEventId}
        currentUserId={currentUserId}
        companyLabel={
          detailEventId
            ? companyById.get(events.find((e) => e.id === detailEventId)?.companyId ?? "")?.name ?? null
            : null
        }
        onEdit={(event) => {
          setDetailOpen(false);
          setEditingEvent(event);
          setDialogOpen(true);
        }}
      />
    </div>
  );
}
