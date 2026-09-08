import { useEffect, useRef } from "react";
import { usePinnedWorkspaces } from "./usePinnedWorkspaces";
import {
  hasSeededHqDefaultPins,
  markHqDefaultPinsSeeded,
  planHqDefaultPinSeeding,
} from "../lib/hq-default-pins";

/**
 * Put HQ's starting pins in place, once, the first time a person opens HQ.
 *
 * All of the reasoning about what gets pinned, and about the one time promise
 * and what it costs, is in lib/hq-default-pins.ts. This hook is only the part
 * that has to live in React: notice the moment we can act, act once, and never
 * act again.
 *
 * Runs on HQ only. In every other company it does nothing at all.
 */
export function useHqDefaultPins(isPortfolioRoot: boolean): void {
  const { pinned, canPin, pinsLoaded, ownerId, replaceAll } = usePinnedWorkspaces();

  // Held across renders so a re-render while the write is still travelling
  // cannot start a second one. The effect re-runs whenever the pin list
  // changes, and the optimistic update changes it immediately, so without
  // this guard the first write would trigger the next.
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;

    const plan = planHqDefaultPinSeeding({
      isPortfolioRoot,
      canPin,
      pinsLoaded,
      ownerId,
      pinned,
      hasSeeded: hasSeededHqDefaultPins(ownerId),
    });

    if (plan.action === "none") return;

    startedRef.current = true;

    if (plan.action === "mark-only") {
      markHqDefaultPinsSeeded(ownerId);
      return;
    }

    void replaceAll(plan.orderedIds)
      .then(() => {
        // Marked only after the server has taken it. Marking first would mean
        // a failed write costs the person their starting pins for good.
        markHqDefaultPinsSeeded(ownerId);
      })
      .catch(() => {
        // Left unmarked so the next page load can try again. The guard stays
        // set for this mount so a failure does not turn into a retry loop.
      });
  }, [isPortfolioRoot, canPin, pinsLoaded, ownerId, pinned, replaceAll]);
}
