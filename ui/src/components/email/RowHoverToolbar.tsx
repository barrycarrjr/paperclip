import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * Classes a list row needs for RowHoverToolbar: a positioning context for the
 * toolbar, and the named hover group that reveals it. The name matters. A
 * plain `group` reveals on any hovered ancestor that is also a `group`, and the
 * Email page's list column was one, so pointing anywhere at the list lit up
 * the buttons on every row at once.
 */
export const ROW_WITH_HOVER_TOOLBAR = "relative group/row";

interface RowHoverToolbarProps {
  children: ReactNode;
  /** Keep it showing, e.g. while a menu opened from it is still open. */
  forceVisible?: boolean;
  className?: string;
}

/**
 * The quick actions for one email list row, floating over the row's right end
 * while the pointer is on that row or keyboard focus is inside it. Keyboard
 * focus only (`:focus-visible`): a clicked button keeps ordinary focus in
 * Chrome, and revealing on that left the toolbar stuck over the row's time
 * after the pointer had moved on.
 *
 * They used to sit inside the row as a hidden strip that still took its full
 * width. Eight buttons of 36 pixels is 288 pixels, exactly the width of the
 * company Email page's list while a message is open, so the sender and subject
 * had no room at all and each row showed a timestamp under a pile of icons.
 * Floating the buttons leaves the text the whole row; they cover its right end
 * only while you are pointing at it.
 *
 * Keep it short in a narrow column. It appears under the pointer, so wherever
 * it covers the row a click presses a button instead of opening the row: at
 * 288 pixels, all eight buttons covered almost the whole row, and clicking a
 * subject fired Delete or Hand off. Two or three buttons and a "More actions"
 * menu is the shape the Email page uses beside an open message.
 */
export function RowHoverToolbar({ children, forceVisible = false, className }: RowHoverToolbarProps) {
  return (
    <div
      className={cn(
        "absolute right-2 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 rounded-md border border-border bg-popover p-0.5 shadow-sm",
        "[&_button]:size-7 [&_svg]:size-3.5",
        "transition-opacity",
        forceVisible
          ? "opacity-100"
          : "pointer-events-none opacity-0 group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-has-[:focus-visible]/row:pointer-events-auto group-has-[:focus-visible]/row:opacity-100",
        className,
      )}
      // A click on a button must not also open the row underneath it.
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}
