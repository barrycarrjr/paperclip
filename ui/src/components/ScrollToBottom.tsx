import { useCallback, useEffect, useState } from "react";
import { ArrowDown } from "lucide-react";
import { usePanel } from "../context/PanelContext";
import {
  PAGE_SCROLL_BUTTON_RIGHT_BESIDE_PANEL_CLASS,
  PAGE_SCROLL_BUTTON_RIGHT_CLASS,
  PAGE_SCROLL_BUTTON_SIZE_CLASS,
  SCROLL_TO_BOTTOM_OFFSET_CLASS,
} from "../lib/narrow-layout";
import { cn } from "../lib/utils";
import { Z_PAGE_FLOATING } from "../lib/z-layers";
import { PageFloating } from "./PageFloatingLayer";

function resolveScrollTarget() {
  const mainContent = document.getElementById("main-content");

  if (mainContent instanceof HTMLElement) {
    const overflowY = window.getComputedStyle(mainContent).overflowY;
    const usesOwnScroll =
      (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay")
      && mainContent.scrollHeight > mainContent.clientHeight + 1;

    if (usesOwnScroll) {
      return { type: "element" as const, element: mainContent };
    }
  }

  return { type: "window" as const };
}

function distanceFromBottom(target: ReturnType<typeof resolveScrollTarget>) {
  if (target.type === "element") {
    return target.element.scrollHeight - target.element.scrollTop - target.element.clientHeight;
  }

  const scroller = document.scrollingElement ?? document.documentElement;
  return scroller.scrollHeight - window.scrollY - window.innerHeight;
}

/**
 * Floating scroll-to-bottom button that follows the active page scroller.
 * On desktop that is `#main-content`; on mobile it falls back to window/page scroll.
 */
export function ScrollToBottom() {
  const [visible, setVisible] = useState(false);
  const { panelVisible, panelContent } = usePanel();

  useEffect(() => {
    const check = () => {
      setVisible(distanceFromBottom(resolveScrollTarget()) > 300);
    };

    const mainContent = document.getElementById("main-content");

    check();
    mainContent?.addEventListener("scroll", check, { passive: true });
    window.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);

    return () => {
      mainContent?.removeEventListener("scroll", check);
      window.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    };
  }, []);

  const scroll = useCallback(() => {
    const target = resolveScrollTarget();

    if (target.type === "element") {
      target.element.scrollTo({ top: target.element.scrollHeight, behavior: "smooth" });
      return;
    }

    const scroller = document.scrollingElement ?? document.documentElement;
    window.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  }, []);

  if (!visible) return null;

  return (
    // Beside the page area, not inside it (see PageFloating).
    <PageFloating>
      <button
        onClick={scroll}
        // Stacked above the Clippy launcher (see lib/narrow-layout), which used
        // to leave room for these to its left before it became a wider pill.
        className={cn(
          "fixed flex items-center justify-center rounded-full border border-border bg-background shadow-md hover:bg-accent transition-[background-color,right] duration-200",
          Z_PAGE_FLOATING,
          PAGE_SCROLL_BUTTON_SIZE_CLASS,
          SCROLL_TO_BOTTOM_OFFSET_CLASS,
          PAGE_SCROLL_BUTTON_RIGHT_CLASS,
          panelVisible && panelContent && PAGE_SCROLL_BUTTON_RIGHT_BESIDE_PANEL_CLASS,
        )}
        aria-label="Scroll to bottom"
      >
        <ArrowDown className="h-4 w-4" />
      </button>
    </PageFloating>
  );
}
