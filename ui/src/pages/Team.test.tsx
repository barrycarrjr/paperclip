// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamLayout } from "./Team";

const locationState = { pathname: "/team" };
const navigate = vi.fn();

vi.mock("@/lib/router", () => ({
  useLocation: () => locationState,
  useNavigate: () => navigate,
  Outlet: () => <div data-testid="tab-content">the page for this tab</div>,
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ companies: [{ id: "company-1", name: "Acme Robotics" }] }),
}));

vi.mock("@/hooks/useRouteCompany", () => ({
  useActiveCompanyId: () => "company-1",
}));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function tabButtons(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('[role="tab"]'));
}

describe("TeamLayout", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    navigate.mockClear();
    locationState.pathname = "/team";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render() {
    act(() => {
      root.render(<TeamLayout />);
    });
  }

  it("names the company and offers the four tabs, current work first", () => {
    render();

    expect(container.textContent).toContain("Team in Acme Robotics");
    expect(tabButtons(container).map((tab) => tab.textContent)).toEqual([
      "Right now",
      "Agents",
      "Org chart",
      "Assistants",
    ]);
  });

  it("hands the page for the current address straight through", () => {
    render();

    expect(container.querySelector('[data-testid="tab-content"]')).not.toBeNull();
  });

  it("marks the tab that matches the address, on an old address too", () => {
    locationState.pathname = "/org";
    render();

    const selected = tabButtons(container).find(
      (tab) => tab.getAttribute("data-state") === "active",
    );
    expect(selected?.textContent).toBe("Org chart");
  });

  it("marks the right tab when the address carries a company prefix", () => {
    locationState.pathname = "/ACME/assistants";
    render();

    const selected = tabButtons(container).find(
      (tab) => tab.getAttribute("data-state") === "active",
    );
    expect(selected?.textContent).toBe("Assistants");
  });

  /**
   * A click on a tab, in the order a browser really does it.
   *
   * The focus step in the middle is the point. A browser focuses the button
   * it is about to click, between the mouse going down and the click landing,
   * and the tab strip listens to both. Leaving focus out is what let a real
   * defect through: one click asked to go to the page twice, put two entries
   * in the browser's history, and made the back button need two presses.
   */
  function clickTab(label: string) {
    const target = tabButtons(container).find((tab) => tab.textContent === label)!;
    act(() => {
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      target.focus();
      target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      target.click();
    });
  }

  it("sends a tab click to the address that page already had", () => {
    render();

    clickTab("Org chart");

    expect(navigate).toHaveBeenCalledWith("/org");
  });

  it("asks to move once per tab click, so the back button needs one press", () => {
    render();

    clickTab("Org chart");

    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
