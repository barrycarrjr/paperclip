import { cn } from "../lib/utils";

/**
 * A pill that holds text a person wrote: a label's name, an agent's or a
 * company's name, a document key, an issue's title.
 *
 * A pill keeps its text on one line (index.css), which is right for a count
 * or a status and wrong for text that can be any length: a long label name ran
 * past the edge of the properties panel and into the next column of the
 * board, and the labels in an issue's header made the whole page scroll
 * sideways. Such a pill takes PILL_HOLDING_TEXT_CLASS, so it is never wider
 * than the room it is given and may shrink in a row, and shows its text
 * through PillText, which cuts it short with "…" and keeps the whole of it as
 * the tooltip. src/pills.test.ts checks pills that show a name, a title, an
 * email or a key do it this way.
 *
 * The rest of the pill's row keeps its size (`shrink-0`), so the pill is what
 * gives way: a document's "updated" time, cut short beside a long key as
 * well, read "u…" on a phone.
 */
export const PILL_HOLDING_TEXT_CLASS = "inline-flex min-w-0 max-w-full items-center";

export function PillText({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cn("min-w-0 truncate", className)} title={text}>
      {text}
    </span>
  );
}
