import { useState, type ReactElement, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCanHover } from "../hooks/useCanHover";
import { cn } from "../lib/utils";

/**
 * How wide a hover preview may be: its own width where there is room, and
 * never more than the room on screen, which Radix works out as it places the
 * preview.
 */
export const HOVER_PREVIEW_WIDTH_CLASS = {
  md: "max-w-[min(28rem,var(--radix-tooltip-content-available-width))]",
  lg: "max-w-[min(32rem,var(--radix-tooltip-content-available-width))]",
} as const;

/** How far a preview stays in from the edges of the window, in pixels. */
const HOVER_PREVIEW_EDGE_PX = 8;

/**
 * A card of detail shown under a row while the pointer rests on it: an
 * issue's description, the opening lines of an email. A click or a tap on the
 * row opens the whole thing. Written the way a tooltip is:
 *
 *   <HoverPreview>
 *     <HoverPreviewTrigger><div role="button">...</div></HoverPreviewTrigger>
 *     <HoverPreviewContent>...</HoverPreviewContent>
 *   </HoverPreview>
 *
 * It only opens where the pointer can hover (useCanHover). On a phone it
 * opened whenever the row took focus, as a tap can give it, and lay over the
 * list from the left edge of a 390 pixel screen to 115 pixels past the right
 * one, while the row itself was a tap away from the whole thing. And it is
 * never wider than the screen, for a narrow window with a mouse
 * (HOVER_PREVIEW_WIDTH_CLASS).
 */
export function HoverPreview({ children }: { children: ReactNode }) {
  const canHover = useCanHover();
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={canHover && open} onOpenChange={(next) => setOpen(canHover && next)}>
      {children}
    </Tooltip>
  );
}

/** The row a hover preview belongs to. */
export function HoverPreviewTrigger({ children }: { children: ReactElement }) {
  return <TooltipTrigger asChild>{children}</TooltipTrigger>;
}

/** The preview itself, under its row and lined up with the row's start. */
export function HoverPreviewContent({
  width = "lg",
  className,
  children,
}: {
  width?: keyof typeof HOVER_PREVIEW_WIDTH_CLASS;
  className?: string;
  children: ReactNode;
}) {
  return (
    <TooltipContent
      side="bottom"
      align="start"
      collisionPadding={HOVER_PREVIEW_EDGE_PX}
      className={cn(HOVER_PREVIEW_WIDTH_CLASS[width], className)}
    >
      {children}
    </TooltipContent>
  );
}
