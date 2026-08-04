import { useEffect, useState } from "react";

/**
 * Re-render on an interval while `active`, returning the current epoch ms.
 * Used for elapsed-time readouts and countdowns on live Clippy cards.
 */
export function useNowTick(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}
