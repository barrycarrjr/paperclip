/**
 * Size and place of the Clippy window, kept on screen whatever the browser
 * window does. The floating window is anchored to the bottom right corner, so
 * its place is stored as the gap to the right and bottom edges: resizing from
 * the top or left edge then changes only its size, and a narrower browser
 * window keeps it in the same corner.
 */

export type ClippyMode = "floating" | "sidebar" | "fullscreen";

export const CLIPPY_MODES: readonly ClippyMode[] = ["floating", "sidebar", "fullscreen"];

export function isClippyMode(value: unknown): value is ClippyMode {
  return typeof value === "string" && (CLIPPY_MODES as readonly string[]).includes(value);
}

export interface ClippyFloatingRect {
  width: number;
  height: number;
  /** Gap between the window and the right edge of the browser window. */
  right: number;
  /** Gap between the window and the bottom edge of the browser window. */
  bottom: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export const FLOATING_MIN_WIDTH = 320;
export const FLOATING_MIN_HEIGHT = 360;
/** The least space kept between the floating window and any edge. */
export const FLOATING_EDGE_MARGIN = 8;

export const DEFAULT_FLOATING_RECT: ClippyFloatingRect = { width: 420, height: 620, right: 16, bottom: 16 };

export const SIDEBAR_MIN_WIDTH = 320;
export const DEFAULT_SIDEBAR_WIDTH = 420;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * The floating window as it can actually be drawn in this viewport: no
 * smaller than the minimum (unless the viewport itself is smaller), no
 * bigger than the viewport, and never past an edge.
 */
export function clampFloatingRect(rect: ClippyFloatingRect, viewport: ViewportSize): ClippyFloatingRect {
  const room = {
    width: Math.max(0, viewport.width - 2 * FLOATING_EDGE_MARGIN),
    height: Math.max(0, viewport.height - 2 * FLOATING_EDGE_MARGIN),
  };
  const width = Math.round(Math.min(Math.max(rect.width, FLOATING_MIN_WIDTH), room.width));
  const height = Math.round(Math.min(Math.max(rect.height, FLOATING_MIN_HEIGHT), room.height));
  const right = Math.round(clamp(rect.right, FLOATING_EDGE_MARGIN, viewport.width - FLOATING_EDGE_MARGIN - width));
  const bottom = Math.round(clamp(rect.bottom, FLOATING_EDGE_MARGIN, viewport.height - FLOATING_EDGE_MARGIN - height));
  return { width, height, right, bottom };
}

export type FloatingResizeEdge = "left" | "top" | "top-left";

/**
 * The window after dragging its left edge, top edge or top left corner to a
 * pointer position. The right and bottom gaps stay put, which is what keeps
 * the window anchored to its corner while it grows.
 */
export function resizeFloatingRect(
  rect: ClippyFloatingRect,
  edge: FloatingResizeEdge,
  pointer: { x: number; y: number },
  viewport: ViewportSize,
): ClippyFloatingRect {
  const next = { ...rect };
  if (edge === "left" || edge === "top-left") {
    const width = viewport.width - rect.right - pointer.x;
    next.width = clamp(width, FLOATING_MIN_WIDTH, viewport.width - rect.right - FLOATING_EDGE_MARGIN);
  }
  if (edge === "top" || edge === "top-left") {
    const height = viewport.height - rect.bottom - pointer.y;
    next.height = clamp(height, FLOATING_MIN_HEIGHT, viewport.height - rect.bottom - FLOATING_EDGE_MARGIN);
  }
  return clampFloatingRect(next, viewport);
}

/** The window after its header was dragged by `dx`, `dy` pixels. */
export function moveFloatingRect(
  rect: ClippyFloatingRect,
  delta: { dx: number; dy: number },
  viewport: ViewportSize,
): ClippyFloatingRect {
  return clampFloatingRect({ ...rect, right: rect.right - delta.dx, bottom: rect.bottom - delta.dy }, viewport);
}

/**
 * The window made wider or taller by `width`, `height` pixels (negative to
 * shrink), keeping its bottom right corner where it is: the keyboard's
 * version of dragging the top left corner.
 */
export function growFloatingRect(
  rect: ClippyFloatingRect,
  delta: { width: number; height: number },
  viewport: ViewportSize,
): ClippyFloatingRect {
  const left = viewport.width - rect.right - rect.width;
  const top = viewport.height - rect.bottom - rect.height;
  return resizeFloatingRect(rect, "top-left", { x: left - delta.width, y: top - delta.height }, viewport);
}

/**
 * The narrowest the page may be squeezed by the docked panel. Below this a
 * table or a form on the page stops being usable.
 */
export const MIN_PAGE_WIDTH = 480;

/**
 * The docked panel's width: at least its own minimum, and never so wide that
 * the page keeps less than MIN_PAGE_WIDTH beside the app's own columns
 * (`reservedWidth`: the navigation and, when it is showing, the properties
 * panel). On a window too small for both, the panel keeps its minimum and
 * the page has what is left.
 */
export function clampSidebarWidth(width: number, viewportWidth: number, reservedWidth = 0): number {
  const max = Math.max(SIDEBAR_MIN_WIDTH, viewportWidth - reservedWidth - MIN_PAGE_WIDTH);
  return Math.round(clamp(width, SIDEBAR_MIN_WIDTH, max));
}
