import { useLayoutEffect, type RefObject } from "react";
import { PAGE_END_ROOM_EXTRA_PX, pageNeedsEndRoom } from "../lib/narrow-layout";
import { PAGE_BOTTOM_BAR_END_ROOM_PROPERTY } from "../lib/page-bottom-bar";

/**
 * The room PAGE_END_ROOM_CLASS keeps after the page now, in pixels: 3rem, and
 * as far again as the bars fixed over the page reach, which lib/page-bottom-bar
 * writes on the document element.
 */
function roomAfterPage(): number {
  const barsReach = Number.parseFloat(document.documentElement.style.getPropertyValue(PAGE_BOTTOM_BAR_END_ROOM_PROPERTY));
  return PAGE_END_ROOM_EXTRA_PX + (Number.isFinite(barsReach) ? barsReach : 0);
}

/**
 * Keeps `data-page-end-room` on the page area while its page scrolls, which
 * PAGE_END_ROOM_CLASS turns into room under the page's last row for the
 * Clippy launcher (lib/narrow-layout).
 *
 * Watched with a ResizeObserver on the page area and on each page inside it,
 * since a page grows as its data loads, and a MutationObserver for the page
 * changing when the address does, which also stops watching the page that
 * left. The attribute is set on the element directly rather than through
 * React state, so the layout around every page does not render again each
 * time a page grows. Where ResizeObserver does not exist it does nothing, and
 * the page keeps its ordinary padding.
 */
export function usePageEndRoom(pageAreaRef: RefObject<HTMLElement | null>, enabled: boolean) {
  useLayoutEffect(() => {
    const pageArea = pageAreaRef.current;
    if (!pageArea) return;
    if (!enabled || typeof ResizeObserver === "undefined") {
      delete pageArea.dataset.pageEndRoom;
      return;
    }

    let frame = 0;
    const update = () => {
      frame = 0;
      const roomIsOn = pageArea.dataset.pageEndRoom === "true";
      const needed = pageNeedsEndRoom(pageArea, roomIsOn ? roomAfterPage() : 0);
      if (needed === roomIsOn) return;
      if (needed) pageArea.dataset.pageEndRoom = "true";
      else delete pageArea.dataset.pageEndRoom;
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(update);
    };

    const resizeObserver = new ResizeObserver(schedule);
    const watchPages = () => {
      for (const page of Array.from(pageArea.children)) resizeObserver.observe(page);
    };
    resizeObserver.observe(pageArea);
    watchPages();
    const mutationObserver = new MutationObserver((records) => {
      // A page that has left is not watched any more. The observer used to
      // keep hold of every page shown since the app was opened, and of
      // everything each one held, as the address changed.
      for (const record of records) {
        for (const node of Array.from(record.removedNodes)) {
          if (node instanceof Element) resizeObserver.unobserve(node);
        }
      }
      // After the removals, so a page that was moved rather than removed is
      // watched again.
      watchPages();
      schedule();
    });
    mutationObserver.observe(pageArea, { childList: true });
    update();

    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      delete pageArea.dataset.pageEndRoom;
    };
  }, [pageAreaRef, enabled]);
}
