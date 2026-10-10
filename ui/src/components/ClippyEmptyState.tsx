import { MapPin, MessageCircle, MessageSquare, X } from "lucide-react";

interface ClippyEmptyStateProps {
  /** First name to greet the person by. Leave out to greet without one. */
  greetingName?: string | null;
  /** Questions that fit the page Clippy was opened on. Picking one sends it. */
  suggestions: readonly string[];
  onPickSuggestion: (text: string) => void;
  disabled?: boolean;
}

/**
 * What an empty chat shows: a greeting and a few questions to start from,
 * each of which is sent as the first message when picked.
 */
export function ClippyEmptyState({ greetingName, suggestions, onPickSuggestion, disabled = false }: ClippyEmptyStateProps) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4 py-6 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
        <MessageCircle className="size-5" />
      </span>
      <h3 className="text-lg font-semibold">How can I help{greetingName ? `, ${greetingName}` : ""}?</h3>
      {suggestions.length > 0 && (
        <ul aria-label="Suggested questions" className="flex w-full max-w-sm flex-col gap-0.5 text-left">
          {suggestions.map((suggestion) => (
            <li key={suggestion}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onPickSuggestion(suggestion)}
                className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
              >
                <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">{suggestion}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface ClippyContextChipProps {
  /** The page, e.g. "HQ | Issues". */
  label: string;
  onRemove: () => void;
}

/**
 * "Context: HQ | Issues" over a new chat's input: the page the chat will be
 * told about when it is created. Removing it creates the chat without it.
 */
export function ClippyContextChip({ label, onRemove }: ClippyContextChipProps) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <MapPin className="size-3.5 shrink-0" />
      <span className="shrink-0">Context:</span>
      <span className="flex min-w-0 items-center gap-1 rounded-full border border-border bg-muted/60 py-0.5 pl-2 pr-0.5 text-foreground">
        <span className="truncate" title={label}>
          {label}
        </span>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove page context: ${label}`}
          title="Remove page context"
          className="flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3" />
        </button>
      </span>
    </div>
  );
}
