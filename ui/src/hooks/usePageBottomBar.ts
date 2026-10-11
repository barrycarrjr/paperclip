import { useCallback, type MutableRefObject, type RefCallback } from "react";
import { registerPageBottomBar } from "../lib/page-bottom-bar";

/**
 * A ref for a page's own bar pinned along the bottom of the window: a fixed
 * Save bar, a selection's action bar, a bar or reply box that sticks to the
 * bottom. While the bar is pinned there, the Clippy launcher, the page's
 * scroll buttons and the toasts move up above it (lib/page-bottom-bar). A row
 * that simply ends the page needs no ref: the page area keeps room under it
 * (PAGE_END_ROOM_CLASS).
 *
 * Place the bar itself with PAGE_BOTTOM_BAR_FLUSH_CLASS or
 * PAGE_BOTTOM_BAR_FLOATING_CLASS (lib/narrow-layout), so that on a phone it
 * rests on top of the bottom bar instead of under or over it.
 *
 * Pass `forwardTo` when the element already has a ref of its own; it is kept
 * pointing at the element, and set back to null when the element goes.
 */
export function usePageBottomBarRef<T extends HTMLElement>(
  forwardTo?: MutableRefObject<T | null>,
): RefCallback<T> {
  return useCallback(
    (element: T | null) => {
      if (forwardTo) forwardTo.current = element;
      if (!element) return undefined;
      const release = registerPageBottomBar(element);
      return () => {
        release();
        if (forwardTo && forwardTo.current === element) forwardTo.current = null;
      };
    },
    [forwardTo],
  );
}
