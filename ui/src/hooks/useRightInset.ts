import { useCallback } from "react";
import { RIGHT_INSET_PROPERTY } from "../lib/narrow-layout";

/**
 * A ref that writes on its element how far the element's right end is in from
 * the right edge of the window, as RIGHT_INSET_PROPERTY in pixels, for a class
 * that keeps room beside something fixed to that edge
 * (CLEAR_OF_PHONE_LAUNCHER_CLASS in lib/narrow-layout).
 *
 * Measured again when the window or the element changes size, which is when
 * that distance changes on a phone. Written on the element directly, so
 * nothing renders again. The room is padding, so it does not move the edge
 * measured here, and writing it cannot set off another measurement that
 * differs. A callback ref rather than an effect, so an element that only
 * appears later, as the reply box does once it may be used, is still measured.
 */
export function useRightInsetRef(): (element: HTMLElement | null) => (() => void) | undefined {
  return useCallback((element: HTMLElement | null) => {
    if (!element || typeof window === "undefined") return undefined;
    const measure = () => {
      const inset = document.documentElement.clientWidth - element.getBoundingClientRect().right;
      element.style.setProperty(RIGHT_INSET_PROPERTY, `${Math.max(0, Math.round(inset))}px`);
    };
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
      element.style.removeProperty(RIGHT_INSET_PROPERTY);
    };
  }, []);
}
