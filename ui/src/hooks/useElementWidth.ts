import { useCallback, useState, type RefCallback } from "react";

/**
 * An element's width in CSS pixels, followed as it changes: the JavaScript
 * side of a container query, for a choice CSS cannot make on its own, such as
 * whether to draw side by side panes or tabs. It measures the room the element
 * actually has, so docked Clippy, the navigation and the properties panel all
 * count, which the window's width does not see.
 *
 * Null until the element has been measured, when it has no width at all (not
 * laid out), and where ResizeObserver does not exist, so a caller can keep its
 * old behaviour in those cases.
 */
export function useElementWidth<T extends HTMLElement>(): [RefCallback<T>, number | null] {
  const [width, setWidth] = useState<number | null>(null);
  const ref = useCallback((element: T | null) => {
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const read = (value: number) => setWidth(value > 0 ? Math.round(value) : null);
    // Measured straight away as well, so the first paint already has the
    // right layout rather than flashing the wide one.
    read(element.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) read(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}
