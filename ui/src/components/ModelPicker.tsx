import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { findModelInList } from "@paperclipai/shared";
import { ChevronDown, ChevronRight, RefreshCw, RotateCcw, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "../lib/utils";
import {
  buildModelPickerSections,
  type ModelPickerEntry,
  type ModelPickerGroup,
  type ModelPickerSection,
} from "../lib/model-display";
import { ModelLifecycleBadge } from "./ModelLifecycleBadge";

export interface ModelPickerEmptyOption {
  /** Words on the row, such as "Default". */
  label: string;
  /** Muted words on the right of the row, such as what the default runs. */
  hint?: string;
  /** Words on the closed picker while this is chosen. Defaults to `label`. */
  triggerLabel?: string;
}

export interface ModelPickerProps<T extends ModelPickerEntry = ModelPickerEntry> {
  /** A plain list, in the order the server gave. Ignored when `groups` is set. */
  models?: readonly T[];
  /** The list split under headings, one per provider. */
  groups?: readonly ModelPickerGroup<T>[];
  value: string;
  onChange: (id: string) => void;
  /** Controlled open state. Leave out and the picker keeps its own. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** A first row that clears the choice ("Default", "Auto"). */
  emptyOption?: ModelPickerEmptyOption;
  /** Words on the closed picker when nothing is chosen and there is no empty option. */
  placeholder?: string;
  /** Lets a person type a model id the list does not have. */
  creatable?: boolean;
  /** The list is still loading, so a saved model cannot be called missing yet. */
  loading?: boolean;
  /** Shown when there are no models to list. */
  emptyMessage?: string;
  onRefreshModels?: () => void | Promise<void>;
  refreshingModels?: boolean;
  onDetectModel?: () => Promise<string | null>;
  detectedModel?: string | null;
  /** Models the adapter's own config names, shown above the list. */
  detectedModelCandidates?: readonly string[];
  detectModelLabel?: string;
  /** Name and hint for a saved id the list does not have. Defaults to the id itself. */
  describeValue?: (id: string) => { label: string; hint?: string };
  /** Adds the number of models to each group heading. */
  showGroupCounts?: boolean;
  disabled?: boolean;
  /**
   * "field" (the default) for a form field; "select" to match the Select
   * controls it sits beside in a toolbar, such as the Clippy composer's.
   */
  appearance?: "field" | "select";
  align?: "start" | "center" | "end";
  triggerClassName?: string;
  /** Hover text for the closed picker. Defaults to the saved id. */
  triggerTitle?: string;
  /** What the picker chooses, for screen readers ("Model"). The current choice is added after it. */
  "aria-label"?: string;
}

const TRIGGER_CLASS =
  "inline-flex w-full min-w-0 items-center justify-between gap-1.5 rounded-md border px-2.5 py-1.5 text-sm outline-none transition-[color,background-color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const TRIGGER_APPEARANCE_CLASS: Record<"field" | "select", string> = {
  field: "border-border hover:bg-accent/50",
  select: "border-input shadow-xs dark:bg-input/30 dark:hover:bg-input/50",
};

const ROW_CLASS =
  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm outline-none hover:bg-accent/50 focus-visible:bg-accent/50";

const SOURCE_PILL_CLASS =
  "inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300";

function prefersTouch(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(pointer: coarse)").matches
    : false;
}

/**
 * The model picker every model choice in Paperclip uses: agent config, new
 * agents, onboarding, instance defaults, the issue override, Clippy and email
 * drafts. It lists models in the server's order with their tags (New, Default,
 * Retires), folds models a newer release has replaced under "Older models",
 * and marks a saved model the provider no longer offers as "Not available".
 *
 * Modal like a native select, so the list scrolls even inside a dialog, and
 * arrow keys move between rows.
 */
export function ModelPicker<T extends ModelPickerEntry = ModelPickerEntry>(props: ModelPickerProps<T>) {
  const {
    models,
    groups,
    value,
    onChange,
    open,
    onOpenChange,
    emptyOption,
    placeholder = "Select model",
    disabled,
    appearance = "field",
    align = "start",
    triggerClassName,
    triggerTitle,
    describeValue,
  } = props;
  const [ownOpen, setOwnOpen] = useState(false);
  const isOpen = open ?? ownOpen;
  const pickerGroups = useMemo<readonly ModelPickerGroup<T>[]>(
    () => groups ?? [{ key: "models", models: models ?? [] }],
    [groups, models],
  );
  const allModels = useMemo(() => pickerGroups.flatMap((group) => group.models), [pickerGroups]);
  const selected = useMemo(() => findModelInList(allModels, value), [allModels, value]);
  const valueDescription = value ? (describeValue?.(value) ?? { label: value }) : null;

  function setOpen(next: boolean) {
    if (open === undefined) setOwnOpen(next);
    onOpenChange?.(next);
  }

  const triggerText = selected
    ? selected.label
    : valueDescription
      ? valueDescription.label
      : emptyOption
        ? (emptyOption.triggerLabel ?? emptyOption.label)
        : placeholder;
  const triggerHint = selected ? selected.hint : valueDescription?.hint;

  return (
    <Popover open={isOpen} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          title={triggerTitle ?? (value || undefined)}
          aria-label={props["aria-label"] ? `${props["aria-label"]}: ${triggerText}` : undefined}
          className={cn(TRIGGER_CLASS, TRIGGER_APPEARANCE_CLASS[appearance], triggerClassName)}
        >
          <span className={cn("min-w-0 truncate", !value && "text-muted-foreground")}>
            {triggerText}
            {triggerHint && <span className="ml-1.5 text-[10px] text-muted-foreground">{triggerHint}</span>}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        collisionPadding={16}
        className="w-[max(var(--radix-popover-trigger-width),18rem)] max-w-[calc(100vw-2rem)] p-1"
        // The search box focuses itself, except on touch screens, where that
        // would open the keyboard and push the list off screen.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <ModelPickerList
          {...props}
          groups={pickerGroups}
          allModels={allModels}
          selected={selected}
          valueDescription={valueDescription}
          onPick={(id) => {
            onChange(id);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

interface ModelPickerListProps<T extends ModelPickerEntry> extends ModelPickerProps<T> {
  groups: readonly ModelPickerGroup<T>[];
  allModels: readonly T[];
  selected: T | null;
  valueDescription: { label: string; hint?: string } | null;
  onPick: (id: string) => void;
}

/**
 * The open list. It mounts each time the picker opens, so the search and the
 * folded sections start fresh every time.
 */
function ModelPickerList<T extends ModelPickerEntry>({
  groups,
  allModels,
  selected,
  valueDescription,
  onPick,
  value,
  emptyOption,
  creatable,
  loading,
  emptyMessage = "No models found.",
  onRefreshModels,
  refreshingModels,
  onDetectModel,
  detectedModel,
  detectedModelCandidates,
  detectModelLabel,
  showGroupCounts,
}: ModelPickerListProps<T>) {
  const [search, setSearch] = useState("");
  const [detecting, setDetecting] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const searching = search.trim().length > 0;

  // Models already shown above the list, as detected or named in config.
  const promoted = useMemo(() => {
    const ids = new Set<string>();
    if (detectedModel && detectedModel !== value) ids.add(detectedModel);
    for (const candidate of detectedModelCandidates ?? []) {
      if (candidate && candidate !== value) ids.add(candidate);
    }
    return ids;
  }, [detectedModel, detectedModelCandidates, value]);

  const listGroups = useMemo(
    () =>
      promoted.size === 0
        ? groups
        : groups.map((group) => ({ ...group, models: group.models.filter((m) => !promoted.has(m.id)) })),
    [groups, promoted],
  );
  const sections = useMemo(() => buildModelPickerSections(listGroups, search), [listGroups, search]);

  // Older models start folded, except where the saved model is one of them.
  const [olderOpen, setOlderOpen] = useState<ReadonlySet<string>>(() => {
    const keys = new Set<string>();
    if (!selected) return keys;
    for (const section of buildModelPickerSections(listGroups)) {
      if (section.older.some((m) => m.id === selected.id)) keys.add(section.key);
    }
    return keys;
  });

  const manualModel = search.trim();
  const canCreate = Boolean(
    creatable && manualModel && !allModels.some((m) => m.id.toLowerCase() === manualModel.toLowerCase()),
  );
  const labelFor = (id: string) => findModelInList(allModels, id)?.label ?? id;

  async function handleDetect() {
    if (!onDetectModel) return;
    setDetecting(true);
    try {
      const next = await onDetectModel();
      if (next) onPick(next);
    } finally {
      setDetecting(false);
    }
  }

  function toggleOlder(key: string) {
    setOlderOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const input = searchRef.current;
    const active = document.activeElement as HTMLElement | null;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      const items = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>("[data-picker-item]:not(:disabled)"),
      );
      const index = active ? items.indexOf(active) : -1;
      const target =
        event.key === "ArrowDown"
          ? (items[index + 1] ?? items[index] ?? input)
          : index > 0
            ? items[index - 1]
            : input;
      target?.focus();
      return;
    }
    if (event.key === "Enter" && active === input) {
      event.preventDefault();
      event.stopPropagation();
      if (!searching) return;
      const first = event.currentTarget.querySelector<HTMLButtonElement>("[data-picker-model]");
      if (first) first.click();
      else if (canCreate) onPick(manualModel);
      return;
    }
    // Typing while a row has focus goes to the search box, the way a native
    // select jumps as you type, and never reaches the page's own shortcuts.
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && input && active !== input) {
      event.stopPropagation();
      input.focus();
    }
  }

  function renderModel(model: T, section: ModelPickerSection<T>) {
    const isSelected = selected?.id === model.id;
    return (
      <button
        key={model.id}
        type="button"
        data-picker-item=""
        data-picker-model=""
        aria-current={isSelected ? "true" : undefined}
        className={cn(ROW_CLASS, isSelected && "bg-accent")}
        title={model.id}
        onClick={() => onPick(model.id)}
      >
        <span className="min-w-0 flex-1 truncate">
          {section.label && model.shortLabel ? model.shortLabel : model.label}
        </span>
        {model.hint && <span className="shrink-0 text-[10px] text-muted-foreground">{model.hint}</span>}
        <ModelLifecycleBadge model={model} />
      </button>
    );
  }

  function renderOlder(section: ModelPickerSection<T>) {
    if (section.older.length === 0) return null;
    if (searching) {
      return (
        <>
          <div className="px-2 pb-0.5 pt-1.5 text-[10px] text-muted-foreground">Older models</div>
          {section.older.map((model) => renderModel(model, section))}
        </>
      );
    }
    const expanded = olderOpen.has(section.key);
    return (
      <>
        <button
          type="button"
          data-picker-item=""
          aria-expanded={expanded}
          className={cn(ROW_CLASS, "gap-1.5 text-xs text-muted-foreground")}
          onClick={() => toggleOlder(section.key)}
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          Older models ({section.older.length})
        </button>
        {expanded && section.older.map((model) => renderModel(model, section))}
      </>
    );
  }

  const nothingListed = sections.length === 0 && !canCreate && promoted.size === 0;

  return (
    <div onKeyDown={handleKeyDown}>
      <div className="relative mb-1">
        <input
          ref={searchRef}
          autoFocus={!prefersTouch()}
          aria-label="Search models"
          className="w-full border-b border-border bg-transparent px-2 py-1.5 pr-6 text-xs outline-none placeholder:text-muted-foreground/50"
          placeholder={creatable ? "Search models... (type to create)" : "Search models..."}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {search && (
          <button
            type="button"
            aria-label="Clear search"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            onClick={() => {
              setSearch("");
              searchRef.current?.focus();
            }}
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      {onDetectModel && !searching && (
        <button
          type="button"
          data-picker-item=""
          className={cn(ROW_CLASS, "gap-1.5 text-xs text-muted-foreground")}
          disabled={detecting}
          onClick={() => void handleDetect()}
        >
          <RotateCcw className="h-3 w-3" />
          {detecting
            ? "Detecting..."
            : detectedModel
              ? (detectModelLabel?.replace(/^Detect\b/, "Re-detect") ?? "Re-detect from config")
              : (detectModelLabel ?? "Detect from config")}
        </button>
      )}
      {onRefreshModels && !searching && (
        <button
          type="button"
          data-picker-item=""
          className={cn(ROW_CLASS, "gap-1.5 text-xs text-muted-foreground")}
          disabled={refreshingModels}
          onClick={() => void onRefreshModels()}
        >
          <RefreshCw className={cn("h-3 w-3", refreshingModels && "animate-spin")} />
          {refreshingModels ? "Refreshing..." : "Refresh models"}
        </button>
      )}
      {value && !selected && valueDescription && (
        <div
          data-picker-saved-value=""
          className="flex items-center gap-2 rounded bg-accent/50 px-2 py-1.5 text-sm"
          title={value}
        >
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{valueDescription.label}</span>
          {valueDescription.hint && (
            <span className="shrink-0 text-[10px] text-muted-foreground">{valueDescription.hint}</span>
          )}
          {!loading && allModels.length > 0 && <ModelLifecycleBadge unavailable />}
        </div>
      )}
      {detectedModel && detectedModel !== value && (
        <button
          type="button"
          data-picker-item=""
          className={ROW_CLASS}
          title={detectedModel}
          onClick={() => onPick(detectedModel)}
        >
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{labelFor(detectedModel)}</span>
          <span className={SOURCE_PILL_CLASS}>detected</span>
        </button>
      )}
      {(detectedModelCandidates ?? [])
        .filter((candidate) => candidate && candidate !== detectedModel && candidate !== value)
        .map((candidate) => (
          <button
            key={`detected-${candidate}`}
            type="button"
            data-picker-item=""
            className={ROW_CLASS}
            title={candidate}
            onClick={() => onPick(candidate)}
          >
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{labelFor(candidate)}</span>
            <span className={SOURCE_PILL_CLASS}>config</span>
          </button>
        ))}
      <div className="max-h-[240px] overflow-y-auto overscroll-contain">
        {emptyOption && (
          <button
            type="button"
            data-picker-item=""
            className={cn(ROW_CLASS, "justify-between", !value && "bg-accent")}
            onClick={() => onPick("")}
          >
            <span className="shrink-0">{emptyOption.label}</span>
            {emptyOption.hint && (
              <span className="min-w-0 truncate text-xs text-muted-foreground">{emptyOption.hint}</span>
            )}
          </button>
        )}
        {canCreate && (
          <button
            type="button"
            data-picker-item=""
            className={cn(ROW_CLASS, "justify-between")}
            onClick={() => onPick(manualModel)}
          >
            <span className="shrink-0">Use manual model</span>
            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{manualModel}</span>
          </button>
        )}
        {sections.map((section) => (
          <div key={section.key} className="mb-1 last:mb-0">
            {section.label && (
              <div className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {section.label}
                {showGroupCounts ? ` (${section.primary.length + section.older.length})` : ""}
              </div>
            )}
            {section.description && (
              <div className="px-2 pb-1 text-[10px] leading-snug text-muted-foreground">{section.description}</div>
            )}
            {section.primary.map((model) => renderModel(model, section))}
            {renderOlder(section)}
          </div>
        ))}
        {nothingListed && (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            {searching ? "No models match." : loading ? "Loading models…" : emptyMessage}
          </p>
        )}
      </div>
    </div>
  );
}
