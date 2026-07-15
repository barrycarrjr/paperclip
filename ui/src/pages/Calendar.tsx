import { startTransition, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { CalendarDays, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import type { CalendarEvent } from "@paperclipai/shared";
import { calendarApi } from "../api/calendar";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { useCurrentUserId } from "../hooks/useCurrentUserId";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageTabBar } from "../components/PageTabBar";
import { EventDialog } from "../components/calendar/EventDialog";
import { EventDetailDialog } from "../components/calendar/EventDetailDialog";
import { EventListRow } from "../components/calendar/EventListRow";
import { MonthGrid } from "../components/calendar/MonthGrid";
import { SourceLegend } from "../components/calendar/SourceLegend";
import { addMonths, formatMonthTitle, KNOWN_SOURCES, monthRange } from "../components/calendar/calendar-utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent } from "@/components/ui/tabs";

type CalendarTab = "list" | "calendar";

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function Calendar() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const currentUserId = useCurrentUserId();

  const activeTab: CalendarTab = searchParams.get("tab") === "calendar" ? "calendar" : "list";

  const [viewMonth, setViewMonth] = useState<Date>(() => startOfMonth(new Date()));
  const [hiddenSources, setHiddenSources] = useState<Set<string>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailEventId, setDetailEventId] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; kind: "fire" | "delete" } | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Calendar" }]);
  }, [setBreadcrumbs]);

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

  function openCreate() {
    setEditingEvent(null);
    setDialogOpen(true);
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
        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" />
          New reminder
        </Button>
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
              onAction={openCreate}
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
                onSelectOccurrence={(occ) => openDetail(occ.eventId)}
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
