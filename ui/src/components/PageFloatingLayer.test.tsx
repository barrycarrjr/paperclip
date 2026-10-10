// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PanelProvider } from "../context/PanelContext";
import { PageFloating, PageFloatingLayerProvider } from "./PageFloatingLayer";
import { ScrollToBottom } from "./ScrollToBottom";
import { ScrollToTop } from "./ScrollToTop";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Safari before 18.4 made a size container, which the page area is, the box
 * that `position: fixed` elements inside it are placed against. A page's own
 * fixed bars and buttons are therefore drawn in a layer beside the page area,
 * not inside it. These stand in for Layout with a page area and a layer of
 * their own; Layout's own tests check it draws the layer in the right place.
 */
describe("PageFloating", () => {
  let container: HTMLDivElement;
  let root: Root;
  let pageArea: HTMLElement;
  let layer: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    // The page area and the layer beside it, as Layout draws them.
    pageArea = document.createElement("main");
    pageArea.id = "main-content";
    layer = document.createElement("div");
    document.body.append(pageArea, layer);
    root = createRoot(pageArea);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    document.body.innerHTML = "";
  });

  /** Draws a page in the page area, with the layer Layout would give it, or none, or outside Layout. */
  async function drawPage(page: ReactNode, layerElement: HTMLElement | null | "outside Layout" = layer) {
    await act(async () => {
      root.render(
        layerElement === "outside Layout" ? (
          page
        ) : (
          <PageFloatingLayerProvider value={layerElement}>{page}</PageFloatingLayerProvider>
        ),
      );
    });
  }

  it("draws what a page fixes to the screen in the layer, not in the page area", async () => {
    await drawPage(
      <div>
        <p>Page</p>
        <PageFloating>
          <div data-testid="save-bar" className="fixed bottom-6">Save</div>
        </PageFloating>
      </div>,
    );
    const bar = document.querySelector('[data-testid="save-bar"]');
    expect(bar).not.toBeNull();
    expect(layer.contains(bar)).toBe(true);
    expect(pageArea.contains(bar)).toBe(false);
    expect(pageArea.textContent).toContain("Page");
  });

  it("draws it in place when there is no layer, as for a page drawn on its own", async () => {
    await drawPage(
      <PageFloating>
        <div data-testid="save-bar">Save</div>
      </PageFloating>,
      "outside Layout",
    );
    expect(pageArea.querySelector('[data-testid="save-bar"]')).not.toBeNull();
  });

  it("draws nothing while Layout has not drawn the layer yet", async () => {
    await drawPage(
      <PageFloating>
        <div data-testid="save-bar">Save</div>
      </PageFloating>,
      null,
    );
    expect(document.querySelector('[data-testid="save-bar"]')).toBeNull();
  });

  it("draws the scroll buttons in the layer, not in the page area", async () => {
    // A long page, scrolled part of the way down, so both buttons show.
    pageArea.style.overflowY = "auto";
    Object.defineProperty(pageArea, "scrollHeight", { configurable: true, value: 4000 });
    Object.defineProperty(pageArea, "clientHeight", { configurable: true, value: 800 });
    Object.defineProperty(pageArea, "scrollTop", { configurable: true, value: 1200 });

    await drawPage(
      <PanelProvider>
        <ScrollToTop />
        <ScrollToBottom />
      </PanelProvider>,
    );

    for (const label of ["Scroll to top", "Scroll to bottom"]) {
      const button = document.querySelector(`button[aria-label="${label}"]`);
      expect(button, `${label} shows`).not.toBeNull();
      expect(layer.contains(button), `${label} is in the layer`).toBe(true);
      expect(pageArea.contains(button), `${label} is not in the page area`).toBe(false);
    }
  });
});
