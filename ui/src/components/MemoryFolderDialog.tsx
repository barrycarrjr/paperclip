import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderSync } from "lucide-react";
import type { MemoryFolderRunResult } from "@paperclipai/shared";
import { MEMORY_FOLDER_SCHEDULES } from "@paperclipai/shared";
import { memoryFoldersApi } from "@/api/memoryFolders";
import { Button } from "@/components/ui/button";
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
import { useToast } from "@/context/ToastContext";

export const memoryFolderQueryKey = (companyId: string) => ["memory-folder", companyId] as const;

const SCHEDULE_LABELS: Record<number, string> = {
  15: "Every 15 minutes",
  60: "Every hour",
  360: "Every 6 hours",
  1440: "Once a day",
};

const selectClass =
  "border-input h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50";

export function describeRun(result: MemoryFolderRunResult): string {
  if (result.error) return `Failed: ${result.error}`;
  const parts: string[] = [];
  if (result.mode !== "export") {
    parts.push(`${result.created} added`, `${result.updated} updated`);
  }
  if (result.mode !== "import") {
    parts.push(`${result.exported} exported`);
    if (result.removed > 0) parts.push(`${result.removed} removed`);
  }
  if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
  return parts.join(", ");
}

function formatWhen(value: string | Date | null | undefined): string {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

interface Props {
  companyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MemoryFolderDialog({ companyId, open, onOpenChange }: Props) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: memoryFolderQueryKey(companyId),
    queryFn: () => memoryFoldersApi.get(companyId),
    enabled: open,
  });

  const [path, setPath] = useState("");
  const [schedule, setSchedule] = useState<string>("");

  useEffect(() => {
    if (settingsQuery.data) {
      setPath(settingsQuery.data.path ?? "");
      setSchedule(
        settingsQuery.data.scheduleMinutes ? String(settingsQuery.data.scheduleMinutes) : "",
      );
    }
  }, [settingsQuery.data]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: memoryFolderQueryKey(companyId) });
    queryClient.invalidateQueries({ queryKey: ["memories", companyId] });
  };

  const saveMutation = useMutation({
    mutationFn: () =>
      memoryFoldersApi.update(companyId, {
        path: path.trim(),
        scheduleMinutes: schedule ? Number(schedule) : null,
      }),
    onSuccess: (settings) => {
      pushToast({
        tone: "success",
        title: settings.path ? "Memory folder saved" : "Memory folder disconnected",
      });
      refresh();
    },
    onError: (error) =>
      pushToast({
        tone: "error",
        title: "Could not save memory folder",
        body: error instanceof Error ? error.message : "Unknown error",
      }),
  });

  const runMutation = useMutation({
    mutationFn: (mode: "export" | "import" | "sync") => memoryFoldersApi[mode](companyId),
    onSuccess: (result) => {
      pushToast({
        tone: result.error ? "error" : "success",
        title: result.error ? "Memory folder run failed" : "Memory folder run finished",
        body: describeRun(result),
      });
      refresh();
    },
    onError: (error) =>
      pushToast({
        tone: "error",
        title: "Memory folder run failed",
        body: error instanceof Error ? error.message : "Unknown error",
      }),
  });

  const configured = Boolean(settingsQuery.data?.path);
  const dirty =
    path.trim() !== (settingsQuery.data?.path ?? "") ||
    (schedule ? Number(schedule) : null) !== (settingsQuery.data?.scheduleMinutes ?? null);
  const busy = saveMutation.isPending || runMutation.isPending;
  const last = settingsQuery.data?.lastResult ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderSync className="h-4 w-4" /> Memory folder
          </DialogTitle>
          <DialogDescription>
            Mirror this company's memories to a folder of plain Markdown files, one file per memory.
            Point it at a synced folder (Google Drive, Dropbox) and any AI tool or person can read
            them. Files you add or edit there are imported back on the next sync. Every save in
            Paperclip exports automatically once a folder is set.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label htmlFor="memory-folder-path">Folder path on the server</Label>
            <Input
              id="memory-folder-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="~/Google Drive/memory/acme"
              disabled={busy}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Absolute path, or start with ~/ for your home folder. Leave empty and save to disconnect.
              Only an instance admin can change this.
            </p>
          </div>
          <div>
            <Label htmlFor="memory-folder-schedule">Automatic sync</Label>
            <select
              id="memory-folder-schedule"
              className={selectClass}
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              disabled={busy}
            >
              <option value="">Manual only</option>
              {MEMORY_FOLDER_SCHEDULES.map((minutes) => (
                <option key={minutes} value={String(minutes)}>
                  {SCHEDULE_LABELS[minutes] ?? `Every ${minutes} minutes`}
                </option>
              ))}
            </select>
          </div>

          {configured && (
            <div className="rounded-md border bg-muted/40 p-3 text-xs">
              <div>
                <span className="font-medium">Last run:</span> {formatWhen(settingsQuery.data?.lastSyncAt)}
                {last ? ` (${last.mode}, ${last.trigger})` : ""}
              </div>
              {last && <div className="mt-1">{describeRun(last)}</div>}
              {last && last.warnings.length > 0 && (
                <ul className="mt-2 ml-4 list-disc space-y-0.5 text-muted-foreground">
                  {last.warnings.slice(0, 8).map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                  {last.warnings.length > 8 && <li>and {last.warnings.length - 8} more</li>}
                </ul>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!configured || dirty || busy}
              onClick={() => runMutation.mutate("export")}
            >
              Export now
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!configured || dirty || busy}
              onClick={() => runMutation.mutate("import")}
            >
              Import now
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!configured || dirty || busy}
              onClick={() => runMutation.mutate("sync")}
            >
              Import then export
            </Button>
          </div>
          <Button type="button" disabled={!dirty || busy} onClick={() => saveMutation.mutate()}>
            {saveMutation.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
