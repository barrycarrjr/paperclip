import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Where a page's own fixed bars and buttons are drawn: a layer Layout keeps
 * beside the page area (`main`), not inside it.
 *
 * The page area is a size container (PAGE_AREA_CONTAINER_CLASS, in
 * lib/narrow-layout). Safari before 18.4 also made a size container the box
 * that `position: fixed` elements inside it are placed against (WebKit bugs
 * 277122 and 284945), so anything a page fixed to the screen was pinned to the
 * page area instead: on an older iPhone the agent Save bar sat at the end of
 * the page rather than at the bottom of the screen, and on a desktop a fixed
 * bar scrolled away with the page. Drawn in this layer, outside the page area,
 * none of it depends on how a browser treats a container.
 *
 * The layer sits inside the same `inert` wrapper as the page, so what is drawn
 * here is out of reach behind full screen Clippy just as the page is, and
 * inside the shell that sets `--app-nav-width`, which the centred bars read.
 * React keeps the page's own context for what is drawn here, so a bar still
 * reads its page's state and its clicks still reach the page's handlers.
 */

/**
 * The layer element: null until Layout has drawn it, and undefined outside
 * Layout altogether (a page drawn on its own, as in a test), where a page's
 * fixed elements are drawn in place as they always were.
 */
const PageFloatingLayerContext = createContext<HTMLElement | null | undefined>(undefined);

/** Set by Layout to the layer element it draws beside the page area. */
export const PageFloatingLayerProvider = PageFloatingLayerContext.Provider;

/** The attribute Layout marks the layer element with. */
export const PAGE_FLOATING_LAYER_ATTRIBUTE = "data-page-floating-layer";

/**
 * Draws a page's own fixed element in the layer beside the page area: a bar
 * pinned along the bottom, a short notice in a corner, the scroll buttons, a
 * hand built overlay. Anything a page fixes to the screen goes through this,
 * unless a portal of its own (a Radix dialog, sheet or menu) already draws it
 * at the end of the document.
 */
export function PageFloating({ children }: { children: ReactNode }) {
  const layer = useContext(PageFloatingLayerContext);
  // Outside Layout, drawn in place.
  if (layer === undefined) return <>{children}</>;
  // Layout is there but has not drawn the layer yet: only on its very first
  // render, which is never painted, since the layer arrives in the same commit.
  if (layer === null) return null;
  return createPortal(children, layer);
}
