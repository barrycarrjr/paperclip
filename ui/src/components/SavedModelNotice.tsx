import { AlertTriangle, Info } from "lucide-react";
import { describeSavedModel, type ModelListEntry } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import { savedModelNotice, type SavedModelNoticeTone } from "../lib/model-display";

interface SavedModelNoticeProps {
  /** The models the provider offers, as the picker above shows them. */
  models: readonly ModelListEntry[];
  /** The saved model id. Empty means the default applies, which needs no notice. */
  value: string | null | undefined;
  /** Moves the choice to the suggested model. Leave out to show the words only. */
  onSwitch?: (id: string) => void;
  disabled?: boolean;
  className?: string;
}

const TONE_CLASS: Record<SavedModelNoticeTone, string> = {
  info: "text-muted-foreground",
  warning: "text-amber-700 dark:text-amber-300",
  danger: "text-destructive",
};

/**
 * One line under a model picker when the saved model needs attention: a newer
 * model has replaced it, it is retiring, or the provider no longer offers it.
 * Offers a button to switch when there is a model to switch to. Says nothing
 * while the list is loading, for the default, or for a model that is fine.
 */
export function SavedModelNotice({ models, value, onSwitch, disabled, className }: SavedModelNoticeProps) {
  const notice = savedModelNotice(describeSavedModel(models, value), value ?? "");
  if (!notice) return null;
  const Icon = notice.tone === "info" ? Info : AlertTriangle;
  // A list that says nothing about releases or defaults (OpenCode, Ollama)
  // has no real suggestion to make: the model offered would just be whichever
  // came first. Say what is wrong and leave the choice to the picker.
  const listKnowsLifecycle = models.some((m) => m.status !== undefined || m.isDefault);
  const replacement = listKnowsLifecycle ? notice.replacement : null;
  return (
    <div
      data-saved-model-notice={notice.tone}
      className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-xs", TONE_CLASS[notice.tone], className)}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{notice.message}</span>
      {replacement && onSwitch && (
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="text-foreground"
          disabled={disabled}
          onClick={() => onSwitch(replacement.id)}
        >
          Switch to {replacement.label}
        </Button>
      )}
    </div>
  );
}
