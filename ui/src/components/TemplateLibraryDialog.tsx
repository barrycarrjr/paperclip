import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Bot,
  Boxes,
  CheckCircle2,
  ClipboardList,
  Download,
  Loader2,
  RefreshCw,
  ScrollText,
  Sparkles,
} from "lucide-react";
import type { TemplateType } from "@paperclipai/shared";
import { templatesApi, type LibraryTemplate } from "@/api/templates";
import { queryKeys } from "@/lib/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToastActions } from "@/context/ToastContext";

type LibraryKind = "agent" | "routine" | "skill" | "bundle";

const KIND_META: Record<
  LibraryKind,
  { label: string; pluralLabel: string; icon: typeof Bot; tab: LibraryKind }
> = {
  bundle: { label: "Bundle", pluralLabel: "Bundles", icon: Boxes, tab: "bundle" },
  agent: { label: "Agent", pluralLabel: "Agents", icon: Bot, tab: "agent" },
  routine: { label: "Routine", pluralLabel: "Routines", icon: ClipboardList, tab: "routine" },
  skill: { label: "Skill", pluralLabel: "Skills", icon: ScrollText, tab: "skill" },
};

const TEMPLATE_TYPE_TO_KIND: Record<TemplateType, LibraryKind> = {
  routine: "routine",
  skill: "skill",
  agent: "agent",
};

const selectionKey = (t: LibraryTemplate) => `${t.kind}:${t.name}`;

/**
 * Bulk-import skips rows where nothing would happen (already installed, no
 * update available, and not a bundle — bundles can always be re-installed to
 * surface missing items). Returned `false` ⇒ checkbox should be disabled.
 */
const isImportable = (t: LibraryTemplate): boolean => {
  if (t.kind === "bundle") return true;
  if (t.updateAvailable) return true;
  return !t.installed;
};

interface BulkResult {
  ok: number;
  skipped: number;
  failed: Array<{ name: string; message: string }>;
}

export function TemplateLibraryDialog({
  open,
  onOpenChange,
  defaultTab,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTab?: TemplateType;
}) {
  const initialTab: LibraryKind = defaultTab ? TEMPLATE_TYPE_TO_KIND[defaultTab] : "bundle";
  const [tab, setTab] = useState<LibraryKind>(initialTab);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const { pushToast } = useToastActions();

  const qc = useQueryClient();
  const libraryQuery = useQuery({
    queryKey: queryKeys.templates.library(),
    queryFn: () => templatesApi.listLibrary(),
    enabled: open,
    staleTime: 60_000,
  });

  const refreshMutation = useMutation({
    mutationFn: () => templatesApi.refreshLibrary(),
    onSuccess: (data) => qc.setQueryData(queryKeys.templates.library(), data),
  });

  // Reset selection + bulk-result when the dialog is reopened so a stale
  // selection from a previous session doesn't surprise the operator.
  useEffect(() => {
    if (!open) {
      setSelected(new Set());
      setBulkResult(null);
    }
  }, [open]);

  const toggleSelected = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const invalidateAllLists = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: queryKeys.templates.list("routine") }),
      qc.invalidateQueries({ queryKey: queryKeys.templates.list("agent") }),
      qc.invalidateQueries({ queryKey: queryKeys.templates.list("skill") }),
      qc.invalidateQueries({ queryKey: queryKeys.templates.library() }),
    ]);
  };

  const bulkImport = useMutation({
    mutationFn: async (): Promise<BulkResult> => {
      const entries = libraryQuery.data?.templates ?? [];
      const targets = entries.filter((t) => selected.has(selectionKey(t)));
      const result: BulkResult = { ok: 0, skipped: 0, failed: [] };
      // Sequential to avoid hammering the local server with parallel writes;
      // mass-import of 10–20 items completes in a couple of seconds anyway.
      for (const t of targets) {
        try {
          if (t.kind === "bundle") {
            await templatesApi.installBundle(t.name);
            result.ok += 1;
          } else if (t.installed && !t.updateAvailable) {
            result.skipped += 1;
          } else if (t.updateAvailable) {
            await templatesApi.updateFromLibrary(t.kind, t.name);
            result.ok += 1;
          } else {
            await templatesApi.installFromLibrary(t.kind, t.name);
            result.ok += 1;
          }
        } catch (err) {
          result.failed.push({
            name: `${t.kind}:${t.name}`,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return result;
    },
    onSuccess: async (result) => {
      await invalidateAllLists();
      setBulkResult(result);
      setSelected(new Set());
      if (result.failed.length === 0) {
        pushToast({
          tone: "success",
          title: `Imported ${result.ok} item${result.ok === 1 ? "" : "s"}`,
          body: result.skipped > 0 ? `${result.skipped} already up to date.` : undefined,
        });
      } else {
        pushToast({
          tone: "error",
          title: `${result.failed.length} of ${result.ok + result.failed.length} imports failed`,
          body: result.failed[0]?.message,
        });
      }
    },
  });

  const grouped = useMemo(() => {
    const all = libraryQuery.data?.templates ?? [];
    const term = search.trim().toLowerCase();
    const matches = (t: LibraryTemplate) => {
      if (!term) return true;
      return (
        t.name.toLowerCase().includes(term) ||
        t.displayName.toLowerCase().includes(term) ||
        t.description.toLowerCase().includes(term)
      );
    };
    return {
      bundle: all.filter((t) => t.kind === "bundle" && matches(t)),
      agent: all.filter((t) => t.kind === "agent" && matches(t)),
      routine: all.filter((t) => t.kind === "routine" && matches(t)),
      skill: all.filter((t) => t.kind === "skill" && matches(t)),
    } as Record<LibraryKind, LibraryTemplate[]>;
  }, [libraryQuery.data, search]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-muted-foreground" />
            Import from extensions library
          </DialogTitle>
          <DialogDescription>
            Browse pre-baked templates from{" "}
            <code className="text-xs">{libraryQuery.data?.repo ?? "paperclip-extensions"}</code>.
            Bundles install everything you need for a domain (e.g. Phone Assistant) in one click;
            individual agents / routines / skills can be imported one at a time.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Input
            placeholder="Search by name or description"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1"
          />
          <Button
            variant="outline"
            size="sm"
            disabled={refreshMutation.isPending}
            onClick={() => refreshMutation.mutate()}
            title="Force-refresh the library from GitHub"
          >
            {refreshMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh
          </Button>
        </div>

        {libraryQuery.error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
            <AlertCircle className="h-4 w-4 mt-0.5 text-destructive" />
            <div>
              <div className="font-medium text-destructive">Failed to load library</div>
              <div className="text-xs text-muted-foreground">
                {(libraryQuery.error as Error).message}
              </div>
            </div>
          </div>
        )}

        <Tabs value={tab} onValueChange={(v) => setTab(v as LibraryKind)}>
          <TabsList>
            {(["bundle", "agent", "routine", "skill"] as const).map((k) => {
              const Icon = KIND_META[k].icon;
              return (
                <TabsTrigger key={k} value={k}>
                  <Icon className="h-3.5 w-3.5" /> {KIND_META[k].pluralLabel}
                  <span className="ml-1 text-xs text-muted-foreground">
                    {grouped[k]?.length ?? 0}
                  </span>
                </TabsTrigger>
              );
            })}
          </TabsList>
          {(["bundle", "agent", "routine", "skill"] as const).map((k) => (
            <TabsContent key={k} value={k} className="mt-3">
              {libraryQuery.isLoading ? (
                <div className="text-sm text-muted-foreground py-8 text-center">
                  Loading library…
                </div>
              ) : grouped[k].length === 0 ? (
                <div className="text-sm text-muted-foreground py-8 text-center">
                  No {KIND_META[k].pluralLabel.toLowerCase()} match.
                </div>
              ) : (
                <ScrollArea className="h-[440px] pr-3">
                  <BulkSelectionBar
                    visibleEntries={grouped[k]}
                    selected={selected}
                    setSelected={setSelected}
                  />
                  <div className="space-y-2">
                    {grouped[k].map((t) => {
                      const key = selectionKey(t);
                      return (
                        <LibraryRow
                          key={key}
                          entry={t}
                          selectionKey={key}
                          selected={selected.has(key)}
                          onToggleSelected={() => toggleSelected(key)}
                          invalidateAll={invalidateAllLists}
                          disabled={bulkImport.isPending}
                        />
                      );
                    })}
                  </div>
                </ScrollArea>
              )}
            </TabsContent>
          ))}
        </Tabs>

        {selected.size > 0 && (
          <div className="sticky bottom-0 -mx-6 -mb-6 flex items-center justify-between gap-3 border-t bg-background/95 px-6 py-3 backdrop-blur">
            <div className="text-sm">
              <span className="font-medium">{selected.size}</span> selected
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelected(new Set())}
                disabled={bulkImport.isPending}
              >
                Clear
              </Button>
              <Button
                size="sm"
                onClick={() => bulkImport.mutate()}
                disabled={bulkImport.isPending}
              >
                {bulkImport.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                Import selected
              </Button>
            </div>
          </div>
        )}

        {bulkResult && selected.size === 0 && (
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              <span>
                Imported <strong>{bulkResult.ok}</strong>
                {bulkResult.skipped > 0 && (
                  <> · {bulkResult.skipped} already up to date</>
                )}
                {bulkResult.failed.length > 0 && (
                  <> · <span className="text-destructive">{bulkResult.failed.length} failed</span></>
                )}
              </span>
            </div>
            {bulkResult.failed.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-destructive">
                {bulkResult.failed.map((f) => (
                  <li key={f.name}>
                    <code>{f.name}</code> — {f.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Header row above the per-tab list with a "select all importable" tri-state
 * checkbox. Skips rows that have nothing to import (installed without update,
 * non-bundle) so the all-checked state honestly reflects "everything that
 * would do work."
 */
function BulkSelectionBar({
  visibleEntries,
  selected,
  setSelected,
}: {
  visibleEntries: LibraryTemplate[];
  selected: Set<string>;
  setSelected: (next: Set<string>) => void;
}) {
  const importable = visibleEntries.filter(isImportable);
  if (importable.length === 0) return null;
  const importableKeys = importable.map(selectionKey);
  const selectedHere = importableKeys.filter((k) => selected.has(k));
  const allChecked = selectedHere.length === importableKeys.length;
  const someChecked = selectedHere.length > 0 && !allChecked;

  const toggleAll = () => {
    const next = new Set(selected);
    if (allChecked) {
      for (const k of importableKeys) next.delete(k);
    } else {
      for (const k of importableKeys) next.add(k);
    }
    setSelected(next);
  };

  return (
    <div className="mb-2 flex items-center gap-2 px-1 text-xs text-muted-foreground">
      <Checkbox
        checked={allChecked ? true : someChecked ? "indeterminate" : false}
        onCheckedChange={toggleAll}
        aria-label="Select all importable rows in this tab"
      />
      <span>
        {allChecked
          ? `All ${importableKeys.length} selected`
          : someChecked
            ? `${selectedHere.length} of ${importableKeys.length} selected`
            : `Select all ${importableKeys.length} importable`}
      </span>
    </div>
  );
}

function LibraryRow({
  entry,
  selected,
  onToggleSelected,
  invalidateAll,
  disabled,
}: {
  entry: LibraryTemplate;
  selectionKey: string;
  selected: boolean;
  onToggleSelected: () => void;
  invalidateAll: () => Promise<void>;
  /** True while a bulk import is in flight — disables single-row actions to keep state coherent. */
  disabled: boolean;
}) {
  const Icon = KIND_META[entry.kind].icon;
  const importable = isImportable(entry);

  const installSingle = useMutation({
    mutationFn: () =>
      entry.kind === "bundle"
        ? Promise.reject(new Error("Bundles use a different endpoint"))
        : templatesApi.installFromLibrary(entry.kind, entry.name),
    onSuccess: () => {
      invalidateAll();
    },
  });

  const installBundle = useMutation({
    mutationFn: () => templatesApi.installBundle(entry.name),
    onSuccess: () => {
      invalidateAll();
    },
  });

  const updateSingle = useMutation({
    mutationFn: () =>
      entry.kind === "bundle"
        ? Promise.reject(new Error("Bundles can be re-imported, not updated in-place"))
        : templatesApi.updateFromLibrary(entry.kind, entry.name),
    onSuccess: () => {
      invalidateAll();
    },
  });

  const busy =
    installSingle.isPending || installBundle.isPending || updateSingle.isPending || disabled;
  const lastError =
    installSingle.error || installBundle.error || updateSingle.error;
  const lastSuccess =
    installSingle.data || installBundle.data || updateSingle.data;

  const expandsToCount = entry.expandsTo?.length ?? 0;
  const missingFromBundle = entry.expandsTo?.filter((x) => !x.found).length ?? 0;

  return (
    <div className="rounded-md border bg-card p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <Checkbox
            checked={selected}
            onCheckedChange={onToggleSelected}
            disabled={!importable || disabled}
            className="mt-0.5"
            aria-label={`Select ${entry.displayName}`}
          />
          <Icon className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
          <div className="min-w-0">
            <div className="font-medium text-sm flex items-center gap-2 flex-wrap">
              {entry.displayName}
              <code className="text-xs text-muted-foreground font-normal">{entry.name}</code>
              {entry.installed && !entry.updateAvailable && (
                <Badge variant="outline" className="text-xs gap-1">
                  <CheckCircle2 className="h-3 w-3" /> Installed
                </Badge>
              )}
              {entry.updateAvailable && (
                <Badge variant="secondary" className="text-xs">Update available</Badge>
              )}
            </div>
            {entry.description && (
              <div className="text-xs text-muted-foreground mt-1 line-clamp-3">
                {entry.description}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          {entry.kind === "bundle" ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => installBundle.mutate()}
            >
              {installBundle.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              Install pack
            </Button>
          ) : entry.updateAvailable ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => updateSingle.mutate()}
            >
              {updateSingle.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Update
            </Button>
          ) : entry.installed ? (
            <Badge variant="outline" className="text-xs">Already imported</Badge>
          ) : (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => installSingle.mutate()}
            >
              {installSingle.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              Import
            </Button>
          )}
        </div>
      </div>

      {(entry.requiresPlugins.length > 0 || entry.kind === "bundle") && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {entry.kind === "bundle" && expandsToCount > 0 && (
            <Badge variant="outline" className="font-normal">
              expands to {expandsToCount} item{expandsToCount === 1 ? "" : "s"}
            </Badge>
          )}
          {entry.requiresPlugins.map((p) => {
            const missing = entry.missingPlugins.includes(p);
            return (
              <Badge
                key={p}
                variant={missing ? "destructive" : "outline"}
                className="font-normal"
              >
                {missing ? "Install plugin: " : "Plugin: "}
                {p}
              </Badge>
            );
          })}
          {missingFromBundle > 0 && (
            <Badge variant="destructive" className="font-normal">
              {missingFromBundle} referenced item{missingFromBundle === 1 ? "" : "s"} missing
            </Badge>
          )}
        </div>
      )}

      {lastSuccess && (
        <div className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3" />
          {"items" in lastSuccess ? (
            <span>
              Bundle installed — {lastSuccess.items.filter((i) => i.status === "created").length}{" "}
              created, {lastSuccess.items.filter((i) => i.status === "skipped").length} already
              present, {lastSuccess.items.filter((i) => i.status === "error" || i.status === "missing").length}{" "}
              failed.
            </span>
          ) : "status" in lastSuccess ? (
            <span>{lastSuccess.status === "created" ? "Imported." : lastSuccess.status === "updated" ? "Updated." : "Already present — source refreshed."}</span>
          ) : null}
        </div>
      )}

      {lastError && (
        <div className="text-xs text-destructive flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />
          {(lastError as Error).message}
        </div>
      )}

    </div>
  );
}
