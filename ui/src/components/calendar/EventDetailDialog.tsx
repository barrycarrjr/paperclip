import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CalendarEventDetail, CalendarOccurrence } from "@paperclipai/shared";
import { Bell, ExternalLink, Loader2, MapPin, MessageSquare, Monitor, Pencil, Trash2 } from "lucide-react";
import { calendarApi } from "@/api/calendar";
import { queryKeys } from "@/lib/queryKeys";
import { cn, formatDateTime } from "@/lib/utils";
import { useToastActions } from "@/context/ToastContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { channelLabel, describeCadence, resolveNotificationTime, sourceMeta } from "./calendar-utils";

interface EventDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eventId: string | null;
  occurrence?: CalendarOccurrence | null;
  currentUserId: string | null;
  onEdit: (event: CalendarEventDetail) => void;
  /** Optional company label shown on the portfolio surface. */
  companyLabel?: string | null;
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right text-sm break-words">{children}</span>
    </div>
  );
}

export function EventDetailDialog({
  open,
  onOpenChange,
  eventId,
  occurrence,
  currentUserId,
  onEdit,
  companyLabel,
}: EventDetailDialogProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    if (!open) setConfirmingDelete(false);
  }, [open]);

  const isGoogle = occurrence?.source === "google";

  const { data: event, isLoading, error } = useQuery({
    queryKey: eventId ? queryKeys.calendar.event(eventId) : ["calendar", "event", "none"],
    queryFn: () => calendarApi.getEvent(eventId!),
    enabled: open && !!eventId && !isGoogle,
  });

  const isOwned = isGoogle || !event || currentUserId == null || event.userId === currentUserId;

  const deleteMutation = useMutation({
    mutationFn: () => calendarApi.deleteEvent(eventId!),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["calendar"] });
      pushToast({ title: "Reminder deleted", tone: "success" });
      onOpenChange(false);
    },
    onError: (mutationError) => {
      pushToast({
        title: "Failed to delete reminder",
        body: mutationError instanceof Error ? mutationError.message : "Please try again.",
        tone: "error",
      });
    },
  });

  const deleteGoogleMutation = useMutation({
    mutationFn: () => calendarApi.deleteGoogleEvent(occurrence!.companyId, occurrence!.eventId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["calendar"] });
      pushToast({ title: "Google Calendar event deleted", tone: "success" });
      onOpenChange(false);
    },
    onError: (mutationError) => {
      pushToast({
        title: "Failed to delete Google Calendar event",
        body: mutationError instanceof Error ? mutationError.message : "Please try again.",
        tone: "error",
      });
    },
  });

  const meta = isGoogle ? sourceMeta("google") : event ? sourceMeta(event.source) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {meta ? <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", meta.dot)} /> : null}
            <span className="min-w-0 truncate">{isGoogle ? occurrence?.title ?? "Google Calendar Event" : event?.title ?? "Reminder"}</span>
          </DialogTitle>
        </DialogHeader>

        {isGoogle && occurrence ? (
          <div className="divide-y divide-border">
            {companyLabel ? <DetailRow label="Company">{companyLabel}</DetailRow> : null}
            <DetailRow label="Source">
              <Badge variant="outline" className="border-emerald-500/25 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                Google Calendar
              </Badge>
            </DetailRow>
            <DetailRow label="When">
              {occurrence.allDay
                ? `All day (${formatDateTime(occurrence.start).split(" ")[0]})`
                : `${formatDateTime(occurrence.start)}${occurrence.end ? ` – ${formatDateTime(occurrence.end)}` : ""}`}
            </DetailRow>
            {occurrence.location ? (
              <DetailRow label="Location">
                <span className="inline-flex items-center gap-1">
                  <MapPin className="h-3 w-3 shrink-0 text-muted-foreground" />
                  {occurrence.location}
                </span>
              </DetailRow>
            ) : null}
            {occurrence.body ? (
              <div className="py-2">
                <p className="mb-1 text-xs text-muted-foreground">Notes</p>
                <p className="text-sm whitespace-pre-wrap wrap-anywhere">{occurrence.body}</p>
              </div>
            ) : null}
          </div>
        ) : isLoading ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading...
          </div>
        ) : error ? (
          <p className="py-6 text-sm text-destructive">
            {error instanceof Error ? error.message : "Failed to load reminder."}
          </p>
        ) : event ? (
          <div className="divide-y divide-border">
            {companyLabel ? <DetailRow label="Company">{companyLabel}</DetailRow> : null}
            <DetailRow label="Kind">
              <span className="capitalize">{event.kind}</span>
            </DetailRow>
            <DetailRow label="Status">
              <Badge variant="outline" className="capitalize">
                {event.status}
              </Badge>
            </DetailRow>
            <DetailRow label="Schedule">{describeCadence(event)}</DetailRow>
            <DetailRow label="Next">
              {event.nextRunAt ? formatDateTime(event.nextRunAt) : "—"}
            </DetailRow>
            {event.notify && (() => {
              // A10/F13: the notification time is distinct from the
              // occurrence time above whenever a lead time is set — say so
              // explicitly rather than leaving the reader to assume they
              // match, and skip the row entirely when there's nothing to
              // notify at yet (no next occurrence) rather than showing "—".
              const notification = resolveNotificationTime(event);
              if (!notification) return null;
              return (
                <DetailRow label="Notifies">
                  {formatDateTime(notification.notifyAt)}
                  {notification.leadsEvent && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      ({event.leadTimeMinutes}m before)
                    </span>
                  )}
                </DetailRow>
              );
            })()}
            <DetailRow label="Last fired">
              {event.lastFiredAt ? formatDateTime(event.lastFiredAt) : "Never"}
            </DetailRow>
            <DetailRow label="Notifications">
              {event.notify ? (
                <span className="flex flex-wrap items-center justify-end gap-1">
                  <Bell className="h-3.5 w-3.5 text-muted-foreground" />
                  {event.channels.map((channel) => (
                    <Badge key={channel} variant="outline" className="gap-1 text-[11px] font-normal">
                      {channel === "slack" ? (
                        <MessageSquare className="h-3 w-3" />
                      ) : (
                        <Monitor className="h-3 w-3" />
                      )}
                      {channelLabel(channel)}
                    </Badge>
                  ))}
                </span>
              ) : (
                <span className="text-muted-foreground">Off</span>
              )}
            </DetailRow>
            {event.body ? (
              <div className="py-2">
                <p className="mb-1 text-xs text-muted-foreground">Notes</p>
                <p className="text-sm whitespace-pre-wrap wrap-anywhere">{event.body}</p>
              </div>
            ) : null}
          </div>
        ) : null}

        {event ? (
          <DialogFooter className="sm:justify-between">
            <Button
              variant="ghost"
              size="sm"
              className={cn("text-red-600 hover:text-red-700", !isOwned && "invisible")}
              disabled={!isOwned || (isGoogle ? deleteGoogleMutation.isPending : deleteMutation.isPending)}
              onClick={() => {
                if (confirmingDelete) {
                  if (isGoogle) { deleteGoogleMutation.mutate(); } else { deleteMutation.mutate(); }
                } else {
                  setConfirmingDelete(true);
                }
              }}
            >
              {(isGoogle ? deleteGoogleMutation.isPending : deleteMutation.isPending) ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              {confirmingDelete ? "Confirm delete" : "Delete"}
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              {isGoogle && occurrence?.htmlLink ? (
              <Button variant="outline" size="sm" className="gap-1" onClick={() => window.open(occurrence.htmlLink!, "_blank", "noopener,noreferrer")}>
                <ExternalLink className="h-3.5 w-3.5" />
                Google Calendar
              </Button>
            ) : null}
            {!isGoogle && isOwned && event ? (
                <Button size="sm" onClick={() => onEdit(event)}>
                  <Pencil className="h-3.5 w-3.5" />
                  Edit
                </Button>
              ) : null}
            </div>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
