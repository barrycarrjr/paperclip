import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClock, AlertCircle, Loader2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToastActions } from "@/context/ToastContext";
import { makeEmailToolsApi, type EmailSnooze } from "@/api/emailTools";
import { describeSnoozeUntil } from "@/lib/email-snooze";
import { FILLS_OR_KEEPS_HEIGHT_CLASS } from "@/lib/narrow-layout";
import { cn } from "@/lib/utils";

/** Every snooze list for one email-tools install starts with this. */
export function emailSnoozesQueryKey(pluginId: string, companyId?: string, mailbox?: string) {
  return ["email-snoozes", pluginId, ...(companyId ? [companyId] : []), ...(mailbox ? [mailbox] : [])];
}

/**
 * The snoozed emails in one mailbox, and a way to bring one back now.
 * `onChanged` runs after an email comes back, so the page can refresh the
 * mail list it has just reappeared in.
 */
export function useEmailSnoozes(input: {
  pluginId: string | null | undefined;
  companyId: string | null | undefined;
  mailbox: string | null | undefined;
  enabled?: boolean;
  onChanged?: () => void;
}) {
  const { pluginId, companyId, mailbox, enabled = true, onChanged } = input;
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const ready = !!pluginId && !!companyId && !!mailbox;

  const query = useQuery({
    queryKey: emailSnoozesQueryKey(pluginId ?? "", companyId ?? "", mailbox ?? ""),
    queryFn: () => makeEmailToolsApi(pluginId!, companyId!).listSnoozes(mailbox!),
    enabled: ready && enabled,
    // Snoozes come back on their own once a minute, so the list follows.
    refetchInterval: 60_000,
  });

  const unsnooze = useMutation({
    mutationFn: (snooze: EmailSnooze) => makeEmailToolsApi(pluginId!, companyId!).unsnoozeMessage(snooze.id),
    onSuccess: (_, snooze) => {
      pushToast({ title: "Brought back, unread", body: snooze.subject || "(no subject)", tone: "success" });
    },
    onError: (err) => {
      pushToast({ title: "Could not bring it back", body: (err as Error).message, tone: "error" });
    },
    onSettled: () => {
      if (pluginId) queryClient.invalidateQueries({ queryKey: emailSnoozesQueryKey(pluginId) });
      onChanged?.();
    },
  });

  return {
    snoozes: query.data?.snoozes ?? [],
    loading: query.isLoading,
    error: (query.error as Error | null) ?? null,
    unsnooze: (snooze: EmailSnooze) => unsnooze.mutate(snooze),
    unsnoozingId: unsnooze.isPending ? unsnooze.variables?.id ?? null : null,
  };
}

/** What the list says about when one snooze ends. */
export function snoozeStatusText(snooze: EmailSnooze, now: Date = new Date()): {
  text: string;
  problem: boolean;
} {
  if (snooze.last_error) {
    const gaveUp = snooze.attempts >= 5;
    return {
      text: gaveUp
        ? `Could not come back on its own: ${snooze.last_error}. Use "Bring back now".`
        : `Coming back failed (${snooze.last_error}); trying again.`,
      problem: true,
    };
  }
  const wake = new Date(snooze.wake_at);
  if (wake.getTime() <= now.getTime()) return { text: "Coming back within a minute", problem: false };
  return { text: `Comes back ${describeSnoozeUntil(wake, now)}`, problem: false };
}

/**
 * The "Snoozed" list: each snoozed email, when it comes back, and a button
 * to bring it back now. The emails themselves sit in a hidden folder on the
 * mail server until then, so this list is the way to see them.
 */
export function EmailSnoozedList({
  snoozes,
  loading,
  error,
  onUnsnooze,
  unsnoozingId,
  fill = true,
}: {
  snoozes: EmailSnooze[];
  loading: boolean;
  error: Error | null;
  onUnsnooze: (snooze: EmailSnooze) => void;
  unsnoozingId: string | null;
  /** Fill the page's list column (company Email page) or size to content (HQ panels). */
  fill?: boolean;
}) {
  const boxClass = fill ? FILLS_OR_KEEPS_HEIGHT_CLASS : "py-6";

  if (loading) {
    return (
      <div className={cn(boxClass, "flex items-center justify-center")}>
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn(boxClass, "flex items-center justify-center px-4")}>
        <div className="text-center space-y-1">
          <AlertCircle className="h-5 w-5 text-destructive mx-auto" />
          <p className="text-xs text-muted-foreground">Could not read the snoozed emails. {error.message}</p>
        </div>
      </div>
    );
  }

  if (snoozes.length === 0) {
    return (
      <div className={cn(boxClass, "flex flex-col items-center justify-center gap-2 px-4 text-center")}>
        <AlarmClock className="h-5 w-5 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">No snoozed emails in this mailbox.</p>
      </div>
    );
  }

  const now = new Date();
  const rows = (
    <div className="divide-y divide-border">
      {snoozes.map((snooze) => {
        const status = snoozeStatusText(snooze, now);
        const busy = unsnoozingId === snooze.id;
        return (
          <div key={snooze.id} className="flex items-center gap-3 px-3 py-2.5 min-w-0">
            <AlarmClock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="flex-1 min-w-0">
              <div className="text-xs truncate">{snooze.sender || "(unknown sender)"}</div>
              <div className="text-xs text-muted-foreground truncate mt-0.5">{snooze.subject || "(no subject)"}</div>
              <div className={cn("text-[11px] mt-0.5", status.problem ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
                {status.text}
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              disabled={busy}
              onClick={() => onUnsnooze(snooze)}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />}
              Bring back now
            </Button>
          </div>
        );
      })}
    </div>
  );

  return fill ? <ScrollArea className="flex-1">{rows}</ScrollArea> : rows;
}
