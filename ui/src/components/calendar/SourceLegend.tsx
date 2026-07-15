import { cn } from "@/lib/utils";
import { sourceMeta } from "./calendar-utils";

interface SourceLegendProps {
  /** All sources currently in play (defaults to just "paperclip"). */
  sources: string[];
  hiddenSources: Set<string>;
  onToggle: (source: string) => void;
}

/**
 * Per-source legend with a show/hide toggle. The mechanism is generic — a
 * `Set<string>` of hidden sources filters the calendar pills — so future
 * sources (Google, Outlook) slot in without new UI wiring.
 */
export function SourceLegend({ sources, hiddenSources, onToggle }: SourceLegendProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {sources.map((source) => {
        const meta = sourceMeta(source);
        const hidden = hiddenSources.has(source);
        return (
          <button
            key={source}
            type="button"
            onClick={() => onToggle(source)}
            aria-pressed={!hidden}
            className={cn(
              "flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs transition-colors hover:bg-accent/50",
              hidden && "opacity-40",
            )}
            title={hidden ? `Show ${meta.label} events` : `Hide ${meta.label} events`}
          >
            <span className={cn("h-2 w-2 shrink-0 rounded-full", meta.dot)} />
            <span className={cn(hidden && "line-through")}>{meta.label}</span>
          </button>
        );
      })}
    </div>
  );
}
