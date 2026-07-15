import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  CalendarEvent,
  CalendarEventDetail,
  CalendarEventKind,
  CalendarIntervalUnit,
  CalendarScheduleKind,
  CreateCalendarEvent,
} from "@paperclipai/shared";
import { calendarApi } from "@/api/calendar";
import { useToastActions } from "@/context/ToastContext";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { toDateInputValue, toDateTimeLocalValue } from "./calendar-utils";

type EditableEvent = CalendarEvent | CalendarEventDetail;

interface EventDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  /** When provided the dialog edits this event; otherwise it creates one. */
  event?: EditableEvent | null;
}

interface EventDraft {
  title: string;
  body: string;
  kind: CalendarEventKind;
  scheduleKind: CalendarScheduleKind;
  onceAt: string;
  intervalCount: number;
  intervalUnit: CalendarIntervalUnit;
  intervalStartDate: string;
  timeOfDay: string;
  cronExpression: string;
  timezone: string;
  allDay: boolean;
  notify: boolean;
  desktop: boolean;
  slack: boolean;
  slackTarget: string;
  leadTimeMinutes: number;
}

const KIND_OPTIONS: { value: CalendarEventKind; label: string }[] = [
  { value: "reminder", label: "Reminder" },
  { value: "appointment", label: "Appointment" },
  { value: "deadline", label: "Deadline" },
];

const INTERVAL_UNITS: { value: CalendarIntervalUnit; label: string }[] = [
  { value: "day", label: "day" },
  { value: "week", label: "week" },
  { value: "month", label: "month" },
];

const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
];

const CADENCE_OPTIONS: { value: CalendarScheduleKind; label: string }[] = [
  { value: "once", label: "Once" },
  { value: "interval", label: "Repeats" },
  { value: "cron", label: "Cron" },
];

function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function defaultOnceAt(): string {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  now.setHours(now.getHours() + 1);
  return toDateTimeLocalValue(now);
}

function createDefaultDraft(): EventDraft {
  const now = new Date();
  return {
    title: "",
    body: "",
    kind: "reminder",
    scheduleKind: "once",
    onceAt: defaultOnceAt(),
    intervalCount: 1,
    intervalUnit: "week",
    intervalStartDate: toDateInputValue(now),
    timeOfDay: "09:00",
    cronExpression: "0 9 * * *",
    timezone: localTimezone(),
    allDay: false,
    notify: true,
    desktop: true,
    slack: false,
    slackTarget: "",
    leadTimeMinutes: 0,
  };
}

function draftFromEvent(event: EditableEvent): EventDraft {
  const base = createDefaultDraft();
  return {
    ...base,
    title: event.title,
    body: event.body ?? "",
    kind: (event.kind as CalendarEventKind) ?? "reminder",
    scheduleKind: (event.scheduleKind as CalendarScheduleKind) ?? "once",
    onceAt: event.scheduleKind === "once" ? toDateTimeLocalValue(event.anchorAt) || base.onceAt : base.onceAt,
    intervalCount: event.intervalCount ?? 1,
    intervalUnit: (event.intervalUnit as CalendarIntervalUnit) ?? "week",
    intervalStartDate: toDateInputValue(event.anchorAt) || base.intervalStartDate,
    timeOfDay: event.timeOfDay ?? "09:00",
    cronExpression: event.cronExpression ?? base.cronExpression,
    timezone: event.timezone || base.timezone,
    allDay: event.allDay,
    notify: event.notify,
    desktop: event.channels.includes("desktop"),
    slack: event.channels.includes("slack"),
    slackTarget: event.slackTarget ?? "",
    leadTimeMinutes: event.leadTimeMinutes ?? 0,
  };
}

function localToIso(local: string): string | null {
  if (!local) return null;
  const date = new Date(local);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function buildBody(draft: EventDraft): CreateCalendarEvent {
  const channels: ("desktop" | "slack")[] = [];
  if (draft.desktop) channels.push("desktop");
  if (draft.slack) channels.push("slack");

  const base = {
    title: draft.title.trim(),
    body: draft.body.trim() ? draft.body.trim() : null,
    kind: draft.kind,
    timezone: draft.timezone,
    allDay: draft.allDay,
    notify: draft.notify,
    channels: channels.length > 0 ? channels : (["desktop"] as ("desktop" | "slack")[]),
    leadTimeMinutes: Number.isFinite(draft.leadTimeMinutes) ? Math.max(0, draft.leadTimeMinutes) : 0,
    slackTarget: draft.slack ? draft.slackTarget.trim() || null : null,
  };

  if (draft.scheduleKind === "once") {
    return { ...base, scheduleKind: "once", anchorAt: localToIso(draft.onceAt) };
  }
  if (draft.scheduleKind === "interval") {
    return {
      ...base,
      scheduleKind: "interval",
      intervalUnit: draft.intervalUnit,
      intervalCount: Math.max(1, draft.intervalCount),
      timeOfDay: draft.timeOfDay,
      anchorAt: localToIso(`${draft.intervalStartDate}T${draft.timeOfDay}`),
    };
  }
  return { ...base, scheduleKind: "cron", cronExpression: draft.cronExpression.trim() };
}

function isDraftComplete(draft: EventDraft): boolean {
  if (!draft.title.trim()) return false;
  if (draft.scheduleKind === "once") return !!draft.onceAt;
  if (draft.scheduleKind === "interval") {
    return draft.intervalCount >= 1 && !!draft.timeOfDay && !!draft.intervalStartDate;
  }
  return !!draft.cronExpression.trim();
}

export function EventDialog({ open, onOpenChange, companyId, event }: EventDialogProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const isEdit = !!event;
  const [draft, setDraft] = useState<EventDraft>(createDefaultDraft);

  useEffect(() => {
    if (!open) return;
    setDraft(event ? draftFromEvent(event) : createDefaultDraft());
  }, [open, event]);

  const timezoneOptions = useMemo(() => {
    const set = new Set<string>([localTimezone(), ...COMMON_TIMEZONES]);
    if (draft.timezone) set.add(draft.timezone);
    return Array.from(set);
  }, [draft.timezone]);

  const patch = (next: Partial<EventDraft>) => setDraft((current) => ({ ...current, ...next }));

  const mutation = useMutation({
    mutationFn: () => {
      const body = buildBody(draft);
      return event
        ? calendarApi.updateEvent(event.id, body)
        : calendarApi.createEvent(companyId, body);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["calendar"] });
      pushToast({
        title: isEdit ? "Reminder updated" : "Reminder created",
        tone: "success",
      });
      onOpenChange(false);
    },
    onError: (mutationError) => {
      pushToast({
        title: isEdit ? "Failed to update reminder" : "Failed to create reminder",
        body: mutationError instanceof Error ? mutationError.message : "Please try again.",
        tone: "error",
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (!mutation.isPending ? onOpenChange(next) : undefined)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="border-b border-border/60 px-5 py-4">
          <DialogTitle>{isEdit ? "Edit reminder" : "New reminder"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the schedule and notification settings for this reminder."
              : "Schedule a reminder or event and choose how you want to be notified."}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[65vh] space-y-5 overflow-y-auto px-5 py-4">
          <div className="space-y-1.5">
            <Label htmlFor="calendar-event-title">Title</Label>
            <Input
              id="calendar-event-title"
              value={draft.title}
              onChange={(e) => patch({ title: e.target.value })}
              placeholder="e.g. Renew business license"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="calendar-event-body">Notes</Label>
            <Textarea
              id="calendar-event-body"
              value={draft.body}
              onChange={(e) => patch({ body: e.target.value })}
              placeholder="Optional details..."
              rows={3}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Kind</Label>
              <Select value={draft.kind} onValueChange={(value) => patch({ kind: value as CalendarEventKind })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KIND_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Timezone</Label>
              <Select value={draft.timezone} onValueChange={(value) => patch({ timezone: value })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {timezoneOptions.map((tz) => (
                    <SelectItem key={tz} value={tz}>
                      {tz}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Schedule</Label>
            <div className="flex gap-1">
              {CADENCE_OPTIONS.map((option) => (
                <Button
                  key={option.value}
                  type="button"
                  size="sm"
                  variant={draft.scheduleKind === option.value ? "default" : "outline"}
                  className="h-8 px-3 text-xs"
                  onClick={() => patch({ scheduleKind: option.value })}
                >
                  {option.label}
                </Button>
              ))}
            </div>

            {draft.scheduleKind === "once" ? (
              <div className="space-y-1.5 pt-1">
                <Label htmlFor="calendar-once-at" className="text-xs text-muted-foreground">
                  Date &amp; time
                </Label>
                <Input
                  id="calendar-once-at"
                  type="datetime-local"
                  value={draft.onceAt}
                  onChange={(e) => patch({ onceAt: e.target.value })}
                  className="w-full"
                />
              </div>
            ) : null}

            {draft.scheduleKind === "interval" ? (
              <div className="space-y-3 pt-1">
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <span>Every</span>
                  <Input
                    type="number"
                    min={1}
                    value={draft.intervalCount}
                    onChange={(e) => patch({ intervalCount: Number(e.target.value) || 1 })}
                    className="w-16"
                  />
                  <Select
                    value={draft.intervalUnit}
                    onValueChange={(value) => patch({ intervalUnit: value as CalendarIntervalUnit })}
                  >
                    <SelectTrigger className="w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {INTERVAL_UNITS.map((unit) => (
                        <SelectItem key={unit.value} value={unit.value}>
                          {draft.intervalCount === 1 ? unit.label : `${unit.label}s`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="calendar-interval-start" className="text-xs text-muted-foreground">
                      Starting
                    </Label>
                    <Input
                      id="calendar-interval-start"
                      type="date"
                      value={draft.intervalStartDate}
                      onChange={(e) => patch({ intervalStartDate: e.target.value })}
                      className="w-full"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="calendar-interval-time" className="text-xs text-muted-foreground">
                      At
                    </Label>
                    <Input
                      id="calendar-interval-time"
                      type="time"
                      value={draft.timeOfDay}
                      onChange={(e) => patch({ timeOfDay: e.target.value })}
                      className="w-full"
                    />
                  </div>
                </div>
              </div>
            ) : null}

            {draft.scheduleKind === "cron" ? (
              <div className="space-y-1.5 pt-1">
                <Label htmlFor="calendar-cron" className="text-xs text-muted-foreground">
                  Cron expression
                </Label>
                <Input
                  id="calendar-cron"
                  value={draft.cronExpression}
                  onChange={(e) => patch({ cronExpression: e.target.value })}
                  placeholder="0 9 * * *"
                  className="w-full font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  Five fields: minute hour day-of-month month day-of-week
                </p>
              </div>
            ) : null}
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={draft.allDay}
              onCheckedChange={(checked) => patch({ allDay: checked === true })}
            />
            All-day event
          </label>

          <div className="space-y-3 rounded-md border border-border/60 p-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <Checkbox
                checked={draft.notify}
                onCheckedChange={(checked) => patch({ notify: checked === true })}
              />
              Notify me
            </label>
            {draft.notify ? (
              <div className="space-y-3 pl-6">
                <div className="flex flex-wrap gap-4">
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={draft.desktop}
                      onCheckedChange={(checked) => patch({ desktop: checked === true })}
                    />
                    Desktop
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={draft.slack}
                      onCheckedChange={(checked) => patch({ slack: checked === true })}
                    />
                    Slack
                  </label>
                </div>
                {draft.slack ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="calendar-slack-target" className="text-xs text-muted-foreground">
                      Slack target (channel or user)
                    </Label>
                    <Input
                      id="calendar-slack-target"
                      value={draft.slackTarget}
                      onChange={(e) => patch({ slackTarget: e.target.value })}
                      placeholder="#reminders or @you"
                      className={cn("w-full", draft.slack && !draft.slackTarget.trim() && "aria-invalid:border-destructive")}
                    />
                  </div>
                ) : null}
                <div className="space-y-1.5">
                  <Label htmlFor="calendar-lead-time" className="text-xs text-muted-foreground">
                    Lead time (minutes before)
                  </Label>
                  <Input
                    id="calendar-lead-time"
                    type="number"
                    min={0}
                    value={draft.leadTimeMinutes}
                    onChange={(e) => patch({ leadTimeMinutes: Number(e.target.value) || 0 })}
                    className="w-32"
                  />
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <DialogFooter className="border-t border-border/60 px-5 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={
              mutation.isPending ||
              !isDraftComplete(draft) ||
              (draft.notify && draft.slack && !draft.slackTarget.trim())
            }
          >
            {mutation.isPending ? "Saving..." : isEdit ? "Save changes" : "Create reminder"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
