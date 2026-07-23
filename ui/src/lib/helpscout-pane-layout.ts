// Persisted pane sizes for the Help Scout mail view: the width of the
// conversation list column (everything to its right is the message preview)
// and the height of the reply / note composer. Kept out of the component so
// the clamping is unit-testable and the storage keys have one home.

export const LIST_WIDTH_STORAGE_KEY = "helpscout-listWidth";
export const COMPOSER_HEIGHT_STORAGE_KEY = "helpscout-composerHeight";

export const DEFAULT_LIST_WIDTH = 360;
export const MIN_LIST_WIDTH = 220;
export const MAX_LIST_WIDTH = 640;

export const DEFAULT_COMPOSER_HEIGHT = 160;
export const MIN_COMPOSER_HEIGHT = 96;
export const MAX_COMPOSER_HEIGHT = 600;

export function clampListWidth(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_LIST_WIDTH;
  return Math.max(MIN_LIST_WIDTH, Math.min(MAX_LIST_WIDTH, Math.round(px)));
}

export function clampComposerHeight(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_COMPOSER_HEIGHT;
  return Math.max(MIN_COMPOSER_HEIGHT, Math.min(MAX_COMPOSER_HEIGHT, Math.round(px)));
}

/** Read a persisted pane size, falling back to the default when the stored
 *  value is missing, unparseable, or from an older build with wider bounds. */
export function loadPaneSize(
  key: string,
  fallback: number,
  clamp: (px: number) => number,
): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) return fallback;
    return clamp(parsed);
  } catch {
    return fallback;
  }
}

export function savePaneSize(key: string, px: number): void {
  try {
    localStorage.setItem(key, String(Math.round(px)));
  } catch {}
}
