import type { ReactNode } from "react";
import type { CalendarEvent } from "@paperclipai/shared";
import {
  Bell,
  Loader2,
  MessageSquare,
  Monitor,
  MoreHorizontal,
  Pencil,
  Play,
  Trash2,
} from "lucide-react";
import { cn, formatDateTime } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { channelLabel, describeCadence, sourceMeta } from "./calendar-utils";

interface EventListRowProps {
  event: CalendarEvent;
  ownerLabel: string;
  isOwned: boolean;
  /** Optional trailing/leading context (a company pill on the portfolio view). */
  companyBadge?: ReactNode;
  pending?: "fire" | "delete" | null;
  onOpen: () => void;
  onEdit: () => void;
  onFire: () => void;
  onDelete: () => void;
}

function ChannelBadge({ channel }: { channel: string }) {
  const Icon = channel === "slack" ? MessageSquare : Monitor;
  return (
    <Badge variant="outline" className="gap-1 text-[11px] font-normal">
      <Icon className="h-3 w-3" />
      {channelLabel(channel)}
    </Badge>
  );
}

export function EventListRow({
  event,
  ownerLabel,
  isOwned,
  companyBadge,
  pending = null,
  onOpen,
  onEdit,
  onFire,
  onDelete,
}: EventListRowProps) {
  const meta = sourceMeta(event.source);
  const isActive = event.status === "active";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event_) => {
        if (event_.key === "Enter" || event_.key === " ") {
          event_.preventDefault();
          onOpen();
        }
      }}
      className="group flex cursor-pointer flex-col gap-3 border-b border-border px-3 py-3 transition-colors last:border-b-0 hover:bg-accent/50 sm:flex-row sm:items-center"
    >
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("h-2 w-2 shrink-0 rounded-full", meta.dot)} />
          <span className="truncate text-sm font-medium">{event.title}</span>
          {event.notify ? (
            <Bell className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Reminder" />
          ) : null}
          {companyBadge}
          {!isActive ? (
            <span className="text-xs text-muted-foreground">{event.status}</span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="truncate">{ownerLabel}</span>
          <span>{describeCadence(event)}</span>
          <span>Next: {event.nextRunAt ? formatDateTime(event.nextRunAt) : "—"}</span>
        </div>
      </div>

      <div
        className="flex items-center gap-2"
        onClick={(event_) => event_.stopPropagation()}
      >
        {event.notify ? (
          <div className="hidden items-center gap-1 sm:flex">
            {event.channels.map((channel) => (
              <ChannelBadge key={channel} channel={channel} />
            ))}
          </div>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`More actions for ${event.title}`}
            >
              {pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <MoreHorizontal className="h-4 w-4" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onEdit} disabled={!isOwned}>
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onFire} disabled={!isOwned || pending === "fire"}>
              <Play className="h-3.5 w-3.5" />
              Fire now
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={onDelete}
              disabled={!isOwned || pending === "delete"}
              className="text-red-600 focus:text-red-600"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
