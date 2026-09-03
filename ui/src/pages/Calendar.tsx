import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { CalendarDays, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import type { CalendarEvent, CalendarOccurrence } from "@paperclipai/shared";
import { calendarApi } from "../api/calendar";
import { useActiveCompanyId } from "../hooks/useRouteCompany";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { useCurrentUserId } from "../hooks/useCurrentUserId";
import { queryKeys } from "../lib/queryKeys";
import { readLsFilter, writeLsFilter } from "../lib/persistFilter";
import { EmptyState } from "../components/EmptyState";
import { PageTabBar } from "../components/PageTabBar";
import { CalendarConnectorStatus } from "../components/calendar/CalendarConnectorStatus";
import { EventDialog } from "../components/calendar/EventDialog";
import { EventDetailDialog } from "../components/calendar/EventDetailDialog";
import { EventListRow } from "../components/calendar/EventListRow";
import { MonthGrid } from "../components/calendar/MonthGrid";
import { SourceLegend } from "../components/calendar/SourceLegend";
import {
  addMonths,
  formatMonthTitle,
  isRoutineOccurrence,
  KNOWN_SOURCES,
  monthRange,
} from "../components/calendar/calendar-utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent } from "@/components/ui/tabs";

type CalendarTab = "list" | "calendar";

const LS_HIDDEN_SOURCES_KEY = "paperclip:calendar:hiddenSources";

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function Calendar() {
  // URL-derived, not useCompany()'s selection state: that selection is
  // synced from the route by an effect in Layout that runs one render late.
  // Found reachable here the same way as Email/Everything/PortfolioEmail
  // (P3 audit, 2026-09-03): Calendar is a pinned top-level page and doesn't
  // remount on a company switch, so a stale-company render is one ordinary
  // company switch away, not a theoretical edge case.
  const selectedCompanyId = useActiveCompanyId();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const currentUserId = useCurrentUserId();

  const activeTab: CalendarTab = searchParams.get("tab") === "calendar" ? "calendar" : "list";

  const [viewMonth, setViewMonth] = useState<Date>(() => startOfMonth(new Date()));
  // Stored as an array because a Set does not survive JSON. The shape is
  // re-checked on read so a hand-edited or half-written value cannot throw.
  const [hiddenSources, setHiddenSources] = useState<Set<string>>(() => {
    const stored = readLsFilter<string[]>(LS_HIDDEN_SOURCES_KEY, []);
    return new Set(Array.isArray(stored) ? stored : []);
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  /** Day the operator picked on the grid, seeded into a new reminder. */
  const [createOnDay, setCreateOnDay] = useState<Date | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailEventId, setDetailEventId] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; kind: "fire" | "delete" } | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Calendar" }]);
  }, [setBreadcrumbs]);

  useEffect(() => writeLsFilter(LS_HIDDEN_SOURCES_KEY, [...hiddenSources]), [hiddenSources]);

  // This page doesn't remount on a company switch, and EventDialog's
  // `companyId` prop is passed live (not snapshotted) — so a create/edit
  // dialog left open across a switch would submit its draft to whichever
  // company is active at Send time, not the one the operator opened it
  // under (P3 audit, 2026-09-03; same class of bug already fixed for
  // Email's compose draft and NewIssueDialog's draft). Closing any open
  // dialog on a real company change is simpler and safer than trying to
  // keep the draft and re-target it.
  const prevCalendarCompanyIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevCalendarCompanyIdRef.current === null) {
      prevCalendarCompanyIdRef.current = selectedCompanyId;
      return;
    }
    if (prevCalendarCompanyIdRef.current === selectedCompanyId) return;
    prevCalendarCompanyIdRef.current = selectedCompanyId;
    setDialogOpen(false);
    setEditingEvent(null);
    setCreateOnDay(null);
    setDetailOpen(false);
    setDetailEventId(null);
  }, [selectedCompanyId]);

  const range = useMemo(() => monthRange(viewMonth), [viewMonth]);

  const {
    data: eventsData,
    isLoading: eventsLoading,
    error: eventsError,
  } = useQuery({
    queryKey: queryKeys.calendar.events(selectedCompanyId!),
    queryFn: () => calendarApi.listEvents(selectedCompanyId!),
    enabled: !!selectedCompanyId && activeTab === "list",
  });

  const {
    data: monthData,
    isLoading: monthLoading,
    error: monthError,
  } = useQuery({
    queryKey: queryKeys.calendar.month(selectedCompanyId!, range.from, range.to),
    queryFn: () => calendarApi.getCalendar(selectedCompanyId!, range.from, range.to),
    enabled: !!selectedCompanyId && activeTab === "calendar",
  });

  const events = eventsData?.events ?? [];
  const occurrences = monthData?.occurrences ?? [];

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
      navigate(tab === "calendar" ? "/calendar?tab=calendar" : "/calendar");
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

  function openCreate(day: Date | null = null) {
    setEditingEvent(null);
    setCreateOnDay(day);
    setDialogOpen(true);
  }

  /**
   * A routine entry is scheduled agent work, not a reminder. The reminder
   * dialog cannot edit or delete one, so send the operator to the routine.
   */
  function openOccurrence(occ: CalendarOccurrence) {
    if (isRoutineOccurrence(occ.source)) {
      // Relative: the app's own Link/navigate wrapper (@/lib/router) already
      // applies the active company's prefix from the URL, so there's no need
      // to build it from a (possibly stale) company object.
      navigate(`/routines/${occ.eventId}`);
      return;
    }
    openDetail(occ.eventId);
  }

  function openDetail(eventId: string) {
    setDetailEventId(eventId);
    setDetailOpen(true);
  }

  function isOwned(userId: string): boolean {
    return currentUserId == null || userId === currentUserId;
  }

  if (!selectedCompanyId) {
    return <EmptyState icon={CalendarDays} message="Select a company to view its calendar." />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Calendar</h1>
          <p className="text-sm text-muted-foreground">
            Reminders and scheduled events for this company. A reminder is an event with notifications on.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CalendarConnectorStatus companyId={selectedCompanyId} />
          <Button onClick={() => openCreate()}>
            <Plus className="mr-2 h-4 w-4" />
            New reminder
          </Button>
        </div>
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
            <EmptyState
              icon={CalendarDays}
              message="No reminders yet. Create one to get notified on your schedule."
              action="New reminder"
              onAction={() => openCreate()}
            />
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
                    pending={pending?.id === event.id ? pending.kind : null}
                    onOpen={() => openDetail(event.id)}
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
              <span className="min-w-40 text-center text-sm font-semibold">
                {formatMonthTitle(viewMonth)}
              </span>
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
            <SourceLegend
              sources={[...KNOWN_SOURCES]}
              hiddenSources={hiddenSources}
              onToggle={toggleSource}
            />
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
                <p className="absolute right-0 -top-6 text-xs text-muted-foreground">Loading...</p>
              ) : null}
              <MonthGrid
                viewMonth={viewMonth}
                occurrences={occurrences}
                hiddenSources={hiddenSources}
                onSelectOccurrence={openOccurrence}
                onAddOnDay={(day) => openCreate(day)}
              />
            </div>
          )}
        </TabsContent>
      </Tabs>

      <EventDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        companyId={selectedCompanyId}
        event={editingEvent}
        startOn={createOnDay}
      />

      <EventDetailDialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        eventId={detailEventId}
        currentUserId={currentUserId}
        onEdit={(event) => {
          setDetailOpen(false);
          setEditingEvent(event);
          setDialogOpen(true);
        }}
      />
    </div>
  );
}
