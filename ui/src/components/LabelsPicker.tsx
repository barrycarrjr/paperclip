import { useMemo, useState } from "react";
import { Check, Plus, Tag } from "lucide-react";
import type { IssueLabel } from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

interface LabelsPickerProps {
  /** Company that owns the label set. Falls back to the active company in context. */
  companyId?: string | null;
  labelIds: string[];
  onChange: (labelIds: string[]) => void;
  /** Optional preloaded labels (e.g. from a parent query) to skip an extra fetch. */
  availableLabels?: IssueLabel[];
  /** Optional label details for chips even when the parent labels list hasn't loaded yet. */
  selectedLabels?: IssueLabel[];
  /** Inline (mobile collapsible) vs popover (default desktop). */
  inline?: boolean;
  /** Show the trailing "+" affordance separately (default: rendered inside trigger area). */
  className?: string;
}

const DEFAULT_NEW_LABEL_COLOR = "#6366f1";

/**
 * Inline labels picker shared by IssueProperties, IssuePreviewSheet, and any other
 * surface that needs single-issue label editing. Renders the current chips + a
 * trailing "+" button that opens a popover with search, toggle, and create-label
 * affordances.
 */
export function LabelsPicker({
  companyId: companyIdProp,
  labelIds,
  onChange,
  availableLabels,
  selectedLabels: selectedLabelsProp,
  inline,
  className,
}: LabelsPickerProps) {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const companyId = companyIdProp ?? selectedCompanyId ?? null;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState(DEFAULT_NEW_LABEL_COLOR);

  // Fetch the company's labels when no preload was supplied, lazily until the
  // picker is opened (display-only chips can rely on `selectedLabels`).
  const { data: fetchedLabels } = useQuery({
    queryKey: queryKeys.issues.labels(companyId!),
    queryFn: () => issuesApi.listLabels(companyId!),
    enabled: !!companyId && open && !availableLabels,
  });

  const labels = availableLabels ?? fetchedLabels;

  const createLabel = useMutation({
    mutationFn: (data: { name: string; color: string }) => issuesApi.createLabel(companyId!, data),
    onSuccess: (created) => {
      queryClient.setQueryData<IssueLabel[] | undefined>(
        queryKeys.issues.labels(companyId!),
        (current) => {
          if (!current) return [created];
          if (current.some((label) => label.id === created.id)) return current;
          return [...current, created];
        },
      );
      onChange([...labelIds, created.id]);
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.labels(companyId!) });
      setNewLabelName("");
    },
  });

  function toggle(labelId: string) {
    const next = labelIds.includes(labelId)
      ? labelIds.filter((id) => id !== labelId)
      : [...labelIds, labelId];
    onChange(next);
  }

  // Selected chips can come from a richer parent map; fall back to the picker's
  // fetched labels by id.
  const selectedChips = useMemo(() => {
    if (labelIds.length === 0) return [] as IssueLabel[];
    const byId = new Map<string, IssueLabel>();
    for (const label of labels ?? []) byId.set(label.id, label);
    for (const label of selectedLabelsProp ?? []) byId.set(label.id, label);
    return labelIds
      .map((id) => byId.get(id))
      .filter((label): label is IssueLabel => Boolean(label));
  }, [labelIds, labels, selectedLabelsProp]);

  const chipsContent = selectedChips.length > 0 ? (
    <div className="flex items-center gap-1 flex-wrap">
      {selectedChips.slice(0, 3).map((label) => (
        <span
          key={label.id}
          className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border"
          style={{
            borderColor: label.color,
            backgroundColor: `${label.color}22`,
            color: pickTextColorForPillBg(label.color, 0.13),
          }}
        >
          {label.name}
        </span>
      ))}
      {selectedChips.length > 3 && (
        <span className="text-xs text-muted-foreground">+{selectedChips.length - 3}</span>
      )}
    </div>
  ) : (
    <>
      <Tag className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-sm text-muted-foreground">No labels</span>
    </>
  );

  const popoverContent = (
    <>
      <input
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
        placeholder="Search labels..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        autoFocus={!inline}
      />
      <div className="max-h-44 overflow-y-auto overscroll-contain space-y-0.5">
        {(labels ?? [])
          .filter((label) => {
            if (!search.trim()) return true;
            return label.name.toLowerCase().includes(search.toLowerCase());
          })
          .map((label) => {
            const selected = labelIds.includes(label.id);
            return (
              <button
                key={label.id}
                type="button"
                className={cn(
                  "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-left",
                  selected && "bg-accent",
                )}
                onClick={() => toggle(label.id)}
              >
                <span
                  className="h-2.5 w-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: label.color }}
                />
                <span className="truncate flex-1">{label.name}</span>
                {selected && <Check className="h-3.5 w-3.5 shrink-0 text-foreground" aria-hidden />}
              </button>
            );
          })}
      </div>
      <div className="mt-2 border-t border-border pt-2 space-y-1">
        <div className="flex items-center gap-1">
          <input
            className="h-7 w-7 p-0 rounded bg-transparent"
            type="color"
            value={newLabelColor}
            onChange={(e) => setNewLabelColor(e.target.value)}
          />
          <input
            className="flex-1 px-2 py-1.5 text-xs bg-transparent outline-none rounded placeholder:text-muted-foreground/50"
            placeholder="New label"
            value={newLabelName}
            onChange={(e) => setNewLabelName(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="flex items-center justify-center gap-1.5 w-full px-2 py-1.5 text-xs rounded border border-border hover:bg-accent/50 disabled:opacity-50"
          disabled={!newLabelName.trim() || createLabel.isPending || !companyId}
          onClick={() =>
            createLabel.mutate({
              name: newLabelName.trim(),
              color: newLabelColor,
            })
          }
        >
          <Plus className="h-3 w-3" />
          {createLabel.isPending ? "Creating…" : "Create label"}
        </button>
      </div>
    </>
  );

  const triggerButton = (
    <button
      type="button"
      className={cn(
        "inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors min-w-0 max-w-full text-left",
        className,
      )}
    >
      {chipsContent}
    </button>
  );

  const trailingAddButton = labelIds.length > 0 ? (
    <button
      type="button"
      className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-accent/50 transition-colors text-muted-foreground hover:text-foreground"
      onClick={(e) => {
        e.stopPropagation();
        setOpen(true);
      }}
      aria-label="Add label"
      title="Add label"
    >
      <Plus className="h-3 w-3" />
    </button>
  ) : null;

  if (inline) {
    return (
      <>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors min-w-0 max-w-full text-left",
            className,
          )}
          onClick={() => setOpen((prev) => !prev)}
        >
          {chipsContent}
        </button>
        {trailingAddButton}
        {open && (
          <div className="rounded-md border border-border bg-popover p-1 mb-2 w-full">
            {popoverContent}
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setSearch("");
        }}
      >
        <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
        <PopoverContent className="w-64 p-1" align="end" collisionPadding={16}>
          {popoverContent}
        </PopoverContent>
      </Popover>
      {trailingAddButton}
    </>
  );
}
