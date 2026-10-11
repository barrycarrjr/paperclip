import { useSyncExternalStore } from "react";

/**
 * A device whose main pointer can rest over things: a mouse or a trackpad,
 * not a finger. The same test Tailwind's `hover:` makes.
 */
export const CAN_HOVER_QUERY = "(hover: hover)";

function canAskTheDevice(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function";
}

function subscribe(onChange: () => void): () => void {
  if (!canAskTheDevice()) return () => {};
  const query = window.matchMedia(CAN_HOVER_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function canHoverNow(): boolean {
  // Where the device cannot be asked, things that open on hover keep doing so.
  return !canAskTheDevice() || window.matchMedia(CAN_HOVER_QUERY).matches;
}

/**
 * Whether the device's main pointer can hover, and so whether something that
 * opens on hover can be opened as meant. Changes when the answer does, as when
 * a tablet gets a mouse.
 */
export function useCanHover(): boolean {
  return useSyncExternalStore(subscribe, canHoverNow, () => true);
}
