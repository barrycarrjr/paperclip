import type React from "react";
import { Loader2, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface MailSearchBarProps {
  value: string;
  onChange: (value: string) => void;
  /** Fired on Enter or the magnifier. Not fired while typing. */
  onSubmit: () => void;
  /** Fired on Escape or the clear button. Should drop the caller out of search mode. */
  onClear: () => void;
  placeholder?: string;
  /** Right-aligned summary once a search has run, e.g. "12 results". */
  summary?: string | null;
  busy?: boolean;
  /** Caveats or errors, rendered under the input. */
  note?: React.ReactNode;
  className?: string;
  "aria-label"?: string;
}

/**
 * Search input for the mail panes (IMAP and Help Scout).
 *
 * Submit-driven rather than search-as-you-type: behind this box is a
 * server-side query across folders and accounts, so firing per keystroke would
 * queue slow requests the operator never asked for and, on IMAP, block other
 * actions on the same mailbox connection.
 */
export function MailSearchBar({
  value,
  onChange,
  onSubmit,
  onClear,
  placeholder = "Search mail, then press Enter",
  summary,
  busy = false,
  note,
  className,
  "aria-label": ariaLabel = "Search mail",
}: MailSearchBarProps) {
  return (
    <div className={cn("px-3 py-2 border-b border-border shrink-0", className)}>
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        className="flex items-center gap-2"
      >
        <div className="relative flex-1 min-w-0">
          {busy ? (
            <Loader2 className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-muted-foreground" />
          ) : (
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          )}
          <input
            type="text"
            value={value}
            aria-label={ariaLabel}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClear();
              }
            }}
            className={cn(
              "w-full rounded-md border border-input bg-transparent py-1 pl-7 text-xs outline-none transition-[color,box-shadow]",
              "placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
              value ? "pr-7" : "pr-2",
            )}
          />
          {value && (
            <button
              type="button"
              onClick={onClear}
              aria-label="Clear search"
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        {summary && (
          <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">{summary}</span>
        )}
      </form>
      {note && <div className="mt-1 text-[10px] text-muted-foreground">{note}</div>}
    </div>
  );
}
