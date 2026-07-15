import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CalendarEventDetail } from "@paperclipai/shared";
import { Bell, Loader2, MessageSquare, Monitor, Pencil, Trash2 } from "lucide-react";
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
import { channelLabel, describeCadence, sourceMeta } from "./calendar-utils";

interface EventDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eventId: string | null;
  currentUserId: string | null;
  onEdit: (event: CalendarEventDetail) => void;
  /** Optional company label shown on the portfolio surface. */
  companyLabel?: string | null;
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-right text-sm">{children}</span>
    </div>
  );
}

export function EventDetailDialog({
  open,
  onOpenChange,
  eventId,
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

  const { data: event, isLoading, error } = useQuery({
    queryKey: eventId ? queryKeys.calendar.event(eventId) : ["calendar", "event", "none"],
    queryFn: () => calendarApi.getEvent(eventId!),
    enabled: open && !!eventId,
  });

  const isOwned = !event || currentUserId == null || event.userId === currentUserId;

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

  const meta = event ? sourceMeta(event.source) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {meta ? <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", meta.dot)} /> : null}
            <span className="min-w-0 truncate">{event?.title ?? "Reminder"}</span>
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
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
                <p className="whitespace-pre-wrap text-sm">{event.body}</p>
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
              disabled={!isOwned || deleteMutation.isPending}
              onClick={() => {
                if (confirmingDelete) {
                  deleteMutation.mutate();
                } else {
                  setConfirmingDelete(true);
                }
              }}
            >
              {deleteMutation.isPending ? (
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
              {isOwned ? (
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
