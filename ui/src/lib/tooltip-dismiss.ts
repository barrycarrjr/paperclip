/**
 * Closing tooltips that are already showing when something bigger opens.
 *
 * A tooltip is a label for the thing you are pointing at or have focused, so
 * it sits above popovers and hover cards on purpose (see z-layers.ts). That
 * ordering is right, but it left a hole: a tooltip opened by keyboard focus
 * stays put when a dialog or a drawer opens over the page, so it floats above
 * the dimmed backdrop, still labelling a control you can no longer use. It
 * also holds on to the first Escape press, because an open tooltip is a layer
 * of its own and Escape goes to the topmost layer first, so the dialog under
 * it only closes on the second press.
 *
 * Height cannot fix this, because a dialog can hold tooltips of its own and
 * those must stay above it. The tooltip has to actually close.
 *
 * Radix already has a channel for exactly this. Every open tooltip listens on
 * the document for a `tooltip.open` event and closes itself when one arrives:
 * that is how opening a second tooltip closes the first, so only one is ever
 * on screen. Firing the same event closes whatever is open, including a
 * tooltip whose open state the app owns, because it goes through the tooltip's
 * own onOpenChange. Nothing inside the dialog can be showing a tooltip at the
 * moment it opens, so nothing that belongs to it is lost.
 *
 * The event name is Radix's, not ours, so tooltip-dismiss.test.tsx opens a
 * real tooltip and a real dialog together and checks the tooltip goes. If a
 * future version of Radix renames it, that test says so.
 */

import { useEffect } from "react";

/** Radix's own "a tooltip opened, everyone else close" event. */
const RADIX_TOOLTIP_OPEN_EVENT = "tooltip.open";

/** Close every tooltip that is on screen right now. */
export function closeOpenTooltips(): void {
  if (typeof document === "undefined") return;
  document.dispatchEvent(new CustomEvent(RADIX_TOOLTIP_OPEN_EVENT));
}

/**
 * Draws nothing; closes any open tooltip when it appears.
 *
 * It has to be a component rather than an effect in the dialog's own body,
 * because a dialog panel's component is rendered whether the dialog is open or
 * not: only what is inside its portal mounts on open. Put this inside the
 * portal and mounting really does mean "this just opened".
 */
export function CloseOpenTooltipsOnMount(): null {
  useEffect(() => {
    closeOpenTooltips();
  }, []);
  return null;
}
