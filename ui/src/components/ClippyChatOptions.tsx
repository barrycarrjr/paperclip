import { useState, type KeyboardEvent } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { AvailableModel, EffortLevel, PermissionMode } from "../api/chat";
import { isAdapterModel } from "../lib/clippy-new-chat";
import {
  chatModelDisplayName,
  describeChatModelId,
  type ModelPickerGroup,
} from "../lib/model-display";
import { cn } from "../lib/utils";
import { ModelPicker } from "./ModelPicker";

export type ClippyChatOptionsPatch = {
  model?: string;
  permissionMode?: PermissionMode;
  effort?: EffortLevel;
};

const PERMISSION_OPTIONS: ReadonlyArray<{ value: PermissionMode; label: string }> = [
  { value: "ask", label: "Ask permission" },
  { value: "bypass", label: "Bypass permissions" },
];

const EFFORT_OPTIONS: ReadonlyArray<{ value: EffortLevel; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const DEFAULT_MODEL_LABEL = "Default model";

interface ClippyChatOptionsProps {
  /** The chat's model. An empty string is "let the server pick", offered only to a new chat. */
  model: string;
  permissionMode: PermissionMode;
  effort: EffortLevel;
  /** Every model on offer, for its readable name. */
  models: readonly AvailableModel[];
  /** The same models under one heading per provider, for the picker. */
  modelGroups: readonly ModelPickerGroup[];
  modelsLoading?: boolean;
  /** A new chat may leave the model to the server, which picks the best available one. */
  allowDefaultModel?: boolean;
  disabled?: boolean;
  onChange: (patch: ClippyChatOptionsPatch) => void;
}

/**
 * The one small control beside Send that holds a chat's model, permission
 * mode and effort. They used to be three pickers across the input row; the
 * closed control shows only the model, by its readable name.
 */
export function ClippyChatOptions({
  model,
  permissionMode,
  effort,
  models,
  modelGroups,
  modelsLoading = false,
  allowDefaultModel = false,
  disabled = false,
  onChange,
}: ClippyChatOptionsProps) {
  const [open, setOpen] = useState(false);
  const adapterModel = isAdapterModel(model);
  // CLI models run unattended; the server stores bypass for them whatever
  // is asked, so the control says so rather than offering a choice it ignores.
  const shownPermission: PermissionMode = adapterModel ? "bypass" : permissionMode;
  // An existing chat with no model yet is one whose record is still loading.
  const modelName = model ? chatModelDisplayName(model, models) : allowDefaultModel ? DEFAULT_MODEL_LABEL : "Model";
  const permissionLabel = PERMISSION_OPTIONS.find((o) => o.value === shownPermission)?.label ?? shownPermission;
  const effortLabel = EFFORT_OPTIONS.find((o) => o.value === effort)?.label ?? effort;

  const permissionNote = adapterModel
    ? "CLI models run unattended and bypass permission prompts."
    : shownPermission === "ask"
      ? "Anything that makes a real change waits for your OK."
      : "Clippy makes changes without asking first.";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={disabled}
          className="h-7 min-w-0 max-w-[11rem] gap-1 px-2 font-normal text-muted-foreground"
          aria-label={`Chat options: ${modelName}, ${permissionLabel}, effort ${effortLabel}`}
          title="Model, permissions and effort"
        >
          <SlidersHorizontal className="size-3.5 shrink-0" />
          <span className="truncate">{modelName}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" collisionPadding={12} className="w-72 space-y-3 p-3">
        <div className="space-y-1.5">
          <div className="text-xs text-muted-foreground">Model</div>
          {/* A model that is no longer in the list (an adapter was disabled,
              a model retired, or a stale id from before the adapter:*
              encoding) still shows, marked Not available, so the person sees
              what is selected. */}
          <ModelPicker
            groups={modelGroups}
            value={model}
            onChange={(next) => {
              // Picking a CLI model while "Ask permission" is on switches to
              // bypass in the same change, since the server would anyway.
              if (isAdapterModel(next) && permissionMode === "ask") {
                onChange({ model: next, permissionMode: "bypass" });
              } else {
                onChange({ model: next });
              }
            }}
            emptyOption={allowDefaultModel ? { label: "Default", triggerLabel: DEFAULT_MODEL_LABEL } : undefined}
            disabled={disabled || (modelGroups.length === 0 && !model && !allowDefaultModel)}
            loading={modelsLoading}
            placeholder="Pick a model"
            emptyMessage="No models available"
            describeValue={describeChatModelId}
            appearance="select"
            triggerClassName="h-8 text-xs"
            aria-label="Model"
          />
        </div>
        <div className="space-y-1.5">
          <div className="text-xs text-muted-foreground">Permissions</div>
          <OptionGroup
            label="Permissions"
            value={shownPermission}
            options={PERMISSION_OPTIONS}
            disabled={disabled || adapterModel}
            onChange={(next) => onChange({ permissionMode: next })}
          />
          <p className="text-xs text-muted-foreground">{permissionNote}</p>
        </div>
        <div className="space-y-1.5">
          <div className="text-xs text-muted-foreground">Effort</div>
          <OptionGroup
            label="Effort"
            value={effort}
            options={EFFORT_OPTIONS}
            disabled={disabled}
            onChange={(next) => onChange({ effort: next })}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * A row of mutually exclusive choices, read out as a radio group. Arrow keys
 * move the choice, as they do in any radio group, and Tab leaves it.
 */
function OptionGroup<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0 || disabled) return;
    event.preventDefault();
    const index = options.findIndex((o) => o.value === value);
    const next = options[(index + step + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    buttons[options.indexOf(next)]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn("grid auto-cols-fr grid-flow-col gap-0.5 rounded-md border border-border p-0.5", disabled && "opacity-60")}
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-sm px-1.5 py-1 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed",
              checked ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-accent/50",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
