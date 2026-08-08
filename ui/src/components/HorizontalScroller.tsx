import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface HorizontalScrollerProps {
  children: ReactNode;
  /** Accessible name for the scrollable region. */
  label?: string;
  className?: string;
  contentClassName?: string;
}

/** Ignore sub-pixel rounding when deciding whether an edge still has content. */
const EDGE_EPSILON_PX = 2;
/** How far a nudge button scrolls, as a share of the visible width. */
const NUDGE_RATIO = 0.8;

/**
 * A horizontally scrolling strip that says so.
 *
 * A bare `overflow-x-auto` hides its own overflow: the scrollbar is thin, sits
 * below the content, and on a wide screen a cut-off column looks like the end
 * of the list rather than the middle of it. Content reachable only by a
 * scrollbar nobody notices is, in practice, content that does not exist. This
 * adds the two affordances that make the overflow legible - a nudge button on
 * whichever edge still has content, and a scrollbar that stays visible instead
 * of appearing on hover.
 *
 * The affordances are drawn as overlays with their own background rather than
 * as a gradient fading into the page, so the strip can sit on any surface
 * without being told what colour that surface is.
 */
export function HorizontalScroller({
  children,
  label,
  className,
  contentClassName,
}: HorizontalScrollerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    setEdges({
      left: el.scrollLeft > EDGE_EPSILON_PX,
      right: maxScroll > EDGE_EPSILON_PX && el.scrollLeft < maxScroll - EDGE_EPSILON_PX,
    });
  }, []);

  useLayoutEffect(() => {
    measure();
  }, [measure, children]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    el.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);

    // The strip also has to re-measure when the columns themselves change size
    // (a card grows, a filter drops a column), not only when the window does.
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(measure);
      observer.observe(el);
      for (const child of Array.from(el.children)) observer.observe(child);
    }

    return () => {
      el.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [measure]);

  const nudge = useCallback((direction: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * el.clientWidth * NUDGE_RATIO, behavior: "smooth" });
  }, []);

  return (
    <div className={cn("relative", className)}>
      <div
        ref={scrollRef}
        // Focusable so the strip can be scrolled from the keyboard, which is
        // otherwise the one way to reach the far columns without a pointer.
        tabIndex={0}
        role="group"
        aria-label={label}
        className={cn(
          "scrollbar-visible overflow-x-auto overscroll-x-contain",
          "rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          contentClassName,
        )}
      >
        {children}
      </div>

      {edges.left && <NudgeButton side="left" onClick={() => nudge(-1)} />}
      {edges.right && <NudgeButton side="right" onClick={() => nudge(1)} />}

      {/* Screen readers get the same cue the buttons give sighted users. */}
      <span className="sr-only" aria-live="polite">
        {edges.left || edges.right ? "This list scrolls sideways for more columns." : ""}
      </span>
    </div>
  );
}

function NudgeButton({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const isLeft = side === "left";
  const Icon = isLeft ? ChevronLeft : ChevronRight;

  return (
    <button
      type="button"
      // Already reachable by scrolling the focused strip with arrow keys, so
      // these do not need their own tab stop.
      tabIndex={-1}
      onClick={onClick}
      aria-label={isLeft ? "Scroll left" : "Scroll right"}
      className={cn(
        // Pinned near the top rather than vertically centred: a strip whose
        // columns run to thousands of pixels would put a centred button far
        // below the fold, which is the same invisibility this is meant to fix.
        // The top edge is where the column headers are, and where someone
        // looks first to work out how many columns there are.
        "absolute top-2 z-10 flex h-8 w-8 items-center justify-center",
        "rounded-full border border-border bg-background text-muted-foreground shadow-md",
        "transition-colors hover:bg-accent hover:text-foreground",
        isLeft ? "left-1" : "right-1",
      )}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
