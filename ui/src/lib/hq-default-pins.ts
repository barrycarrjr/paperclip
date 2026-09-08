/**
 * The pages HQ starts with, and the one time we put them there.
 *
 * HQ used to carry an eleven entry "Portfolio" block in the sidebar. That
 * block was removed on 2026-09-07 when the menu was cut down (see
 * SidebarMenu.tsx). The pages themselves are all still live: they keep their
 * catalog entries, so they are still on the Everything page and in search.
 *
 * Without them HQ's "Your workspaces" section would be empty, because HQ no
 * longer gets Email or Calendar automatically either. So the first time a
 * person opens HQ we pin those eleven pages for them. They are ordinary pins
 * from that moment on: the person can unpin any of them, reorder them, or pin
 * something else, and we never touch the list again.
 *
 * WHERE THE "we already did this" MARK LIVES, AND WHAT IT COSTS
 * ------------------------------------------------------------
 * Pins are stored on the server as a plain list of ids with nowhere to record
 * that the seeding has happened, and an empty list has to stay tellable apart
 * from a list nobody has seeded yet. Otherwise unpinning all eleven would look
 * like a fresh account and they would all come back. Recording it properly
 * would mean a new database column, and there is already one migration waiting
 * for approval on this instance, so we use the browser's own storage instead.
 *
 * The honest consequence: the mark is per browser. If someone seeds HQ in
 * Chrome, unpins Portfolio Costs there, and then opens HQ in Firefox for the
 * first time, Firefox seeds the full set again and Portfolio Costs comes back
 * in both places. Within one browser the promise holds exactly: unpinned stays
 * unpinned, including after a reload. That is the accepted trade for not
 * changing the database.
 */

/**
 * The eleven pages the old Portfolio block listed, in the order it listed
 * them. Ids are core catalog ids from lib/workspace-catalog.ts, so the sidebar
 * resolves them the same way as any other pin. Portfolio Email is included:
 * the old block only showed it when the email add-on was installed, but a pin
 * for a page a company cannot open is simply not rendered, so pinning it
 * unconditionally costs nothing and saves HQ losing its mail link on an
 * instance that later installs the add-on.
 */
export const HQ_DEFAULT_PINNED_WORKSPACE_IDS: readonly string[] = [
  "portfolio-brief",
  "portfolio-approvals",
  "portfolio-issues",
  "portfolio-directives",
  "portfolio-agents",
  "portfolio-activity",
  "portfolio-receipts",
  "portfolio-routines",
  "portfolio-calendar",
  "portfolio-email",
  "portfolio-costs",
];

const SEEDED_STORAGE_KEY_PREFIX = "paperclip:hq-default-pins-seeded:";

/** Per person, so two people sharing a browser profile do not affect each other. */
export function hqDefaultPinsSeededStorageKey(ownerId: string): string {
  return `${SEEDED_STORAGE_KEY_PREFIX}${ownerId}`;
}

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

/** True once this browser has seeded HQ's defaults for this person. */
export function hasSeededHqDefaultPins(ownerId: string | null | undefined): boolean {
  if (!ownerId || !canUseStorage()) return false;
  try {
    return window.localStorage.getItem(hqDefaultPinsSeededStorageKey(ownerId)) !== null;
  } catch {
    // A browser with storage blocked cannot remember this. Reporting "not
    // seeded" would re-add the defaults on every load and keep undoing the
    // person's own unpinning, so say "seeded" and leave their list alone.
    return true;
  }
}

/** Record that the seeding happened, so it never happens again in this browser. */
export function markHqDefaultPinsSeeded(ownerId: string | null | undefined): void {
  if (!ownerId || !canUseStorage()) return;
  try {
    window.localStorage.setItem(hqDefaultPinsSeededStorageKey(ownerId), new Date().toISOString());
  } catch {
    // Ignore storage failures; hasSeededHqDefaultPins treats a broken store as
    // already seeded, so a failure here does not cause repeated re-seeding.
  }
}

/**
 * The person's list with any missing defaults added on the end.
 *
 * Merges, never replaces: whatever they already pinned keeps its place and its
 * order, and anything already there is not added twice.
 */
export function mergeHqDefaultPins(pinned: readonly string[]): string[] {
  const merged = [...pinned];
  const seen = new Set(pinned);
  for (const id of HQ_DEFAULT_PINNED_WORKSPACE_IDS) {
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(id);
  }
  return merged;
}

export interface HqDefaultPinSeedingInput {
  /** Only HQ, the portfolio root, gets these defaults. */
  isPortfolioRoot: boolean;
  /** False for a signed out or local session that has nowhere to store pins. */
  canPin: boolean;
  /** False until the person's saved pins have actually come back from the server. */
  pinsLoaded: boolean;
  /** The person the pins belong to, or null when there is nobody to store against. */
  ownerId: string | null;
  pinned: readonly string[];
  /** Whether this browser has already seeded for this person. */
  hasSeeded: boolean;
}

export type HqDefaultPinSeedingPlan =
  | { action: "none" }
  /** Nothing to write, but the mark still has to be set so we stop asking. */
  | { action: "mark-only" }
  | { action: "write"; orderedIds: string[] };

/**
 * Decide whether to seed, kept apart from React so it can be reasoned about
 * and tested on its own.
 *
 * Deliberately does nothing when the pins have not loaded yet. Treating a
 * still loading list as empty would write the defaults over pins the person
 * already has.
 */
export function planHqDefaultPinSeeding(input: HqDefaultPinSeedingInput): HqDefaultPinSeedingPlan {
  if (!input.isPortfolioRoot) return { action: "none" };
  // Somebody who cannot store pins must not get a mark either, or they would
  // never receive the defaults once they can store them.
  if (!input.canPin || !input.ownerId) return { action: "none" };
  if (!input.pinsLoaded) return { action: "none" };
  if (input.hasSeeded) return { action: "none" };

  const merged = mergeHqDefaultPins(input.pinned);
  if (merged.length === input.pinned.length) return { action: "mark-only" };
  return { action: "write", orderedIds: merged };
}
