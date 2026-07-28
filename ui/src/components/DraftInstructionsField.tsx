import { Sparkles } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface DraftInstructionsFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Run the draft. Fired when the operator presses Enter in the field. */
  onSubmit: () => void;
  /** True when there is already reply text, so the copy switches to revising. */
  refining?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * Steering box for the AI Draft button, sat directly above the reply composer.
 *
 * The composer already accepted instructions — it just did it invisibly, by
 * reading whatever was in the reply box — so operators had no way of knowing
 * they could steer a draft at all. This gives the instructions somewhere of
 * their own to live, and keeps them there after drafting so the next click
 * refines the reply instead of starting from scratch.
 */
export function DraftInstructionsField({
  value,
  onChange,
  onSubmit,
  refining = false,
  disabled = false,
  className,
}: DraftInstructionsFieldProps) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Sparkles className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (!disabled) onSubmit();
          }
        }}
        disabled={disabled}
        aria-label="Instructions for the AI draft"
        placeholder={
          refining
            ? "Tell the AI what to change, then press Enter"
            : "Tell the AI what to say — e.g. Q3 for guest checkout, keep it short"
        }
        className="h-8 text-xs"
      />
    </div>
  );
}
