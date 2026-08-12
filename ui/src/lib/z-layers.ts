/**
 * The stacking order for floating UI.
 *
 * These are Tailwind class strings rather than numbers because Tailwind needs
 * to see the literal in the source to generate the rule. Import the constant
 * instead of typing `z-[70]` inline, so the ordering below stays the single
 * place this is decided.
 *
 * The ordering that matters, lowest first:
 *
 *   BASE_OVERLAY (50)  dialogs, sheets, dropdown menus, selects
 *   PANEL        (60)  popovers, hover cards
 *   TOOLTIP      (70)  tooltips
 *   TOAST       (120)  toast notifications
 *   SKIP_LINK   (200)  the keyboard skip-to-content link
 *
 * **Tooltips sit above panels on purpose.** A tooltip labels something the
 * person is already pointing at, so whatever it describes is by definition the
 * frontmost thing on screen. When tooltips shared the 50 layer with dialogs,
 * any popover covered them: the account menu is a popover *containing*
 * tooltips, so the icon-row labels inside it rendered behind the very menu they
 * belonged to and could not be read at all. Keep TOOLTIP above PANEL.
 *
 * Not everything floating uses these yet. Known stragglers, left alone because
 * they are self-contained and changing them buys nothing today: the markdown
 * editor's mention list (`z-[9999]`) and the new-issue dialog's inline property
 * menu (`z-[200]`). If you touch either, move it onto this scale.
 */

/** Dialogs, sheets, dropdown menus, selects. */
export const Z_BASE_OVERLAY = "z-50";

/** Popovers and hover cards, which open on top of dialogs and dropdowns. */
export const Z_PANEL = "z-[60]";

/** Tooltips. Above panels so a tooltip is never hidden by what it describes. */
export const Z_TOOLTIP = "z-[70]";

/** Toast notifications. */
export const Z_TOAST = "z-[120]";

/** The keyboard skip-to-content link, which must beat everything when focused. */
export const Z_SKIP_LINK = "z-[200]";

/**
 * Numeric value behind a layer constant, for tests that assert the ordering.
 * Returns NaN for anything that is not one of the constants above.
 */
export function zLayerValue(layer: string): number {
  const bracketed = /^z-\[(\d+)\]$/.exec(layer);
  if (bracketed) return Number(bracketed[1]);
  const plain = /^z-(\d+)$/.exec(layer);
  if (plain) return Number(plain[1]);
  return Number.NaN;
}
