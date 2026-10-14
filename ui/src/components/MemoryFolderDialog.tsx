import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderSync } from "lucide-react";
import type {
  DocumentLinkPreview,
  KnowledgeBaseValidationResult,
  MemoryFolderRunResult,
} from "@paperclipai/shared";
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
  if (result.validation) {
    parts.push(`${result.validation.findings.length} findings`);
    if (result.validation.error) parts.push(`check failed: ${result.validation.error}`);
  }
  return parts.join(", ");
}

export function describeValidation(result: KnowledgeBaseValidationResult): string {
  if (result.error) return `Failed: ${result.error}`;
  if (result.findings.length === 0) return `${result.filesScanned} notes checked, no findings`;
  const first = result.findings.slice(0, 3).map((finding) => finding.summary).join("; ");
  const more = result.findings.length > 3 ? `; and ${result.findings.length - 3} more` : "";
  return `${result.filesScanned} notes checked, ${result.findings.length} findings. ${first}${more}`;
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
  const [driveLinkMode, setDriveLinkMode] = useState(false);
  const [linkPreview, setLinkPreview] = useState<DocumentLinkPreview | null>(null);

  useEffect(() => {
    if (settingsQuery.data) {
      setPath(settingsQuery.data.path ?? "");
      setSchedule(
        settingsQuery.data.scheduleMinutes ? String(settingsQuery.data.scheduleMinutes) : "",
      );
      setDriveLinkMode(settingsQuery.data.driveLinkMode ?? false);
      setLinkPreview(null);
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
        driveLinkMode,
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
      const failed = Boolean(result.error || result.validation?.error);
      const hasFindings = (result.validation?.findings.length ?? 0) > 0;
      pushToast({
        tone: failed ? "error" : hasFindings ? "warn" : "success",
        title: failed ? "Memory folder run failed" : "Memory folder run finished",
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

  const checkMutation = useMutation({
    mutationFn: () => memoryFoldersApi.findings(companyId),
    onSuccess: (result) =>
      pushToast({
        tone: result.error ? "error" : result.findings.length > 0 ? "warn" : "success",
        title: result.error ? "Knowledge-base check failed" : "Knowledge-base check finished",
        body: describeValidation(result),
      }),
    onError: (error) =>
      pushToast({
        tone: "error",
        title: "Knowledge-base check failed",
        body: error instanceof Error ? error.message : "Unknown error",
      }),
  });

  const indexMutation = useMutation({
    mutationFn: () => memoryFoldersApi.rebuildIndex(companyId),
    onSuccess: (result) =>
      pushToast({
        tone: "success",
        title: result.changed ? "Memory index rebuilt" : "Memory index is already current",
        body: `${result.filesIndexed} notes indexed`,
      }),
    onError: (error) =>
      pushToast({
        tone: "error",
        title: "Memory index was not rebuilt",
        body: error instanceof Error ? error.message : "Unknown error",
      }),
  });

  const previewLinksMutation = useMutation({
    mutationFn: () => memoryFoldersApi.previewLinks(companyId),
    onSuccess: (result) => {
      setLinkPreview(result);
      pushToast({
        tone: result.changes.length > 0 || result.skipped.length > 0 ? "warn" : "success",
        title: "Drive-link preview finished",
        body: `${result.changes.length} link changes and ${result.memoriesChanged} memory updates ready, ${result.skipped.length} skipped`,
      });
    },
    onError: (error) =>
      pushToast({
        tone: "error",
        title: "Drive-link preview failed",
        body: error instanceof Error ? error.message : "Unknown error",
      }),
  });

  const applyLinksMutation = useMutation({
    mutationFn: (planHash: string) => memoryFoldersApi.applyLinks(companyId, planHash),
    onSuccess: (result) => {
      setLinkPreview(null);
      pushToast({
        tone: result.status === "completed" ? "success" : "warn",
        title: result.status === "completed" ? "Drive links applied" : "Drive-link recovery pending",
        body: `${result.filesChanged} files and ${result.memoriesChanged} memories changed`,
      });
      refresh();
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Drive-link apply did not finish",
        body: error instanceof Error ? error.message : "Unknown error",
      });
      refresh();
    },
  });

  const configured = Boolean(settingsQuery.data?.path);
  const dirty =
    path.trim() !== (settingsQuery.data?.path ?? "") ||
    (schedule ? Number(schedule) : null) !== (settingsQuery.data?.scheduleMinutes ?? null) ||
    driveLinkMode !== (settingsQuery.data?.driveLinkMode ?? false);
  const migrationPending = settingsQuery.data?.linkMigration?.status === "pending";
  const busy = saveMutation.isPending || runMutation.isPending || checkMutation.isPending ||
    indexMutation.isPending || previewLinksMutation.isPending || applyLinksMutation.isPending;
  const applyPlanHash = migrationPending
    ? settingsQuery.data?.linkMigration?.planHash ?? null
    : linkPreview?.planHash ?? null;
  const previewBeforeFingerprints = new Set(
    linkPreview?.before.findings.map((finding) => finding.fingerprint) ?? [],
  );
  const previewNewFindings = linkPreview?.after.findings.filter(
    (finding) => !previewBeforeFingerprints.has(finding.fingerprint),
  ) ?? [];
  const previewBlocked = Boolean(linkPreview?.after.error || previewNewFindings.length > 0);
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
          <div className="rounded-md border p-3">
            <label className="flex items-start gap-2 text-sm" htmlFor="memory-folder-drive-links">
              <input
                id="memory-folder-drive-links"
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={driveLinkMode}
                onChange={(event) => {
                  setDriveLinkMode(event.target.checked);
                  setLinkPreview(null);
                }}
                disabled={busy || migrationPending}
              />
              <span>
                <span className="font-medium">Require Drive IDs on document links</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  Use this only for a Google Drive backed folder. Links stay readable as relative paths and add an authoritative Drive-ID.
                </span>
              </span>
            </label>
            {migrationPending && (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                A Drive-link apply was interrupted. Retry it before changing settings or running a sync.
              </p>
            )}
            {linkPreview && (
              <div className="mt-2 text-xs text-muted-foreground">
                {linkPreview.changes.length} link changes and {linkPreview.memoriesChanged} memory updates ready, {linkPreview.skipped.length} skipped.
                <p>
                  Validator: {linkPreview.before.findings.length} findings before, {linkPreview.after.findings.length} after.
                </p>
                {previewBlocked && (
                  <p className="text-amber-700 dark:text-amber-300">
                    Apply is blocked because the preview introduced {previewNewFindings.length} findings
                    {linkPreview.after.error ? ` and the final check failed: ${linkPreview.after.error}` : ""}.
                  </p>
                )}
                {linkPreview.changes.length > 0 && (
                  <details className="mt-1">
                    <summary className="cursor-pointer">Review proposed link changes</summary>
                    <ul className="mt-1 ml-4 list-disc break-all">
                      {linkPreview.changes.map((change) => (
                        <li key={`${change.path}:${change.line}:${change.target}`}>
                          {change.path}:{change.line} changes {change.target} to {change.replacement}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {linkPreview.skipped.length > 0 && (
                  <details className="mt-1">
                    <summary className="cursor-pointer">Review skipped references</summary>
                    <ul className="mt-1 ml-4 list-disc break-all">
                      {linkPreview.skipped.map((item, index) => (
                        <li key={`${item.path}:${item.line ?? "file"}:${index}`}>
                          {item.path}{item.line ? `:${item.line}` : ""}: {item.reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
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
            <p className="mt-1 text-xs text-muted-foreground">
              Each run also checks note headers and links. Active notes older than 90 days are reported.
              Checks never edit notes or the generated index.
            </p>
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
              disabled={!configured || dirty || busy || migrationPending}
              onClick={() => runMutation.mutate("export")}
            >
              Export now
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!configured || dirty || busy || migrationPending}
              onClick={() => runMutation.mutate("import")}
            >
              Import now
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!configured || dirty || busy || migrationPending}
              onClick={() => runMutation.mutate("sync")}
            >
              Import then export
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!configured || dirty || busy}
              onClick={() => checkMutation.mutate()}
            >
              Check notes
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!configured || dirty || busy || migrationPending}
              onClick={() => indexMutation.mutate()}
            >
              Rebuild index
            </Button>
            {driveLinkMode && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!configured || dirty || busy || migrationPending}
                onClick={() => previewLinksMutation.mutate()}
              >
                Preview Drive links
              </Button>
            )}
            {driveLinkMode && applyPlanHash && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!configured || dirty || busy || (!migrationPending && (((linkPreview?.changes.length ?? 0) === 0 && (linkPreview?.memoriesChanged ?? 0) === 0) || previewBlocked))}
                onClick={() => applyLinksMutation.mutate(applyPlanHash)}
              >
                {migrationPending ? "Retry Drive-link apply" : "Apply Drive links"}
              </Button>
            )}
          </div>
          <Button type="button" disabled={!dirty || busy || migrationPending} onClick={() => saveMutation.mutate()}>
            {saveMutation.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
