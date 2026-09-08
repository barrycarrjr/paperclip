// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workTabRoutes } from "./Work";
import { WORK_TABS } from "../lib/work-tabs";

const company = { id: "company-1", issuePrefix: "PAP", name: "Paperclip", isPortfolioRoot: false };

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [company],
    selectedCompany: company,
    selectedCompanyId: company.id,
    selectionSource: "manual",
    loading: false,
    error: null,
    setSelectedCompanyId: vi.fn(),
    reloadCompanies: vi.fn(),
    createCompany: vi.fn(),
  }),
}));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
    sidebarOpen: true,
    setSidebarOpen: vi.fn(),
    toggleSidebar: vi.fn(),
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function WhereAmI() {
  const location = useLocation();
  return <span data-testid="where">{location.pathname}</span>;
}

/**
 * The Work page mounted the way App.tsx mounts it: the real route builder, the
 * real shell, under a real :companyPrefix parent. Only the five pages
 * themselves are stood in for, because what is under test here is which
 * address opens which page, not what those pages draw.
 */
function workApp() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path=":companyPrefix">
          {workTabRoutes((tabId) => <div data-testid="page">{tabId} page</div>)}
        </Route>
      </Routes>
      <WhereAmI />
    </BrowserRouter>
  );
}

describe("the Work page", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function flush() {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }

  /**
   * Arrive at an address cold, the way a saved link or a reload does: set the
   * address first, then mount. A fresh root each time, because a router that
   * is already mounted keeps its own idea of where it is and would not re-read
   * the address bar.
   */
  async function openAt(pathname: string) {
    await act(async () => {
      root.unmount();
    });
    container.innerHTML = "";
    window.history.pushState({}, "", pathname);
    root = createRoot(container);
    await act(async () => {
      root.render(workApp());
    });
    await flush();
  }

  /** The browser's back button. */
  async function pressBack() {
    await act(async () => {
      const popped = new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
      });
      window.history.back();
      // jsdom runs a history traversal on a later task, so waiting for the
      // event itself is the only honest way to know it happened. Capped so a
      // regression fails the test instead of hanging the suite.
      await Promise.race([
        popped,
        new Promise((resolve) => window.setTimeout(resolve, 2000)),
      ]);
    });
    await flush();
  }

  function where(): string {
    return container.querySelector('[data-testid="where"]')?.textContent ?? "";
  }

  function pageShown(): string {
    return container.querySelector('[data-testid="page"]')?.textContent ?? "";
  }

  function tab(label: string): HTMLElement {
    const found = [...container.querySelectorAll('[data-slot="tabs-trigger"]')].find(
      (element) => element.textContent?.trim() === label,
    );
    if (!found) throw new Error(`No tab labelled ${label}`);
    return found as HTMLElement;
  }

  function selectedTab(): string {
    const active = [...container.querySelectorAll('[data-slot="tabs-trigger"]')].find(
      (element) => element.getAttribute("data-state") === "active",
    );
    return active?.textContent?.trim() ?? "";
  }

  async function clickTab(label: string) {
    const trigger = tab(label);
    await act(async () => {
      trigger.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
      );
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });
    await flush();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = "";
  });

  it("keeps every old address working, opening its own page on its own tab", async () => {
    // The point of the whole design: nothing was merged and nothing was
    // redirected, so a link somebody saved before the tabs existed still opens
    // exactly the page it always did, and simply arrives with the right tab
    // marked. Checked for all five, one at a time.
    for (const workTab of WORK_TABS) {
      await openAt(`/PAP/${workTab.id}`);

      expect(where(), workTab.id).toBe(`/PAP/${workTab.id}`);
      expect(pageShown(), workTab.id).toBe(`${workTab.id} page`);
      expect(selectedTab(), workTab.id).toBe(workTab.label);
    }
  });

  it("shows all five tabs, in the agreed order, on every one of them", async () => {
    await openAt("/PAP/goals");

    const labels = [...container.querySelectorAll('[data-slot="tabs-trigger"]')].map(
      (element) => element.textContent?.trim() ?? "",
    );
    expect(labels).toEqual(["Tasks", "Projects", "Goals", "Automations", "Intake queues"]);
  });

  it("says which company the work belongs to", async () => {
    await openAt("/PAP/issues");

    expect(container.textContent).toContain("Work in Paperclip");
  });

  it("changes the address when you change tab, so the tab can be linked to", async () => {
    await openAt("/PAP/issues");

    await clickTab("Automations");

    expect(where()).toBe("/PAP/routines");
    expect(pageShown()).toBe("routines page");
    expect(selectedTab()).toBe("Automations");
  });

  it("goes back through the tabs when you press the browser's back button", async () => {
    await openAt("/PAP/issues");
    await clickTab("Projects");
    await clickTab("Goals");
    expect(where()).toBe("/PAP/goals");

    await pressBack();

    expect(where()).toBe("/PAP/projects");
    expect(pageShown()).toBe("projects page");
    expect(selectedTab()).toBe("Projects");

    await pressBack();

    expect(where()).toBe("/PAP/issues");
    expect(pageShown()).toBe("issues page");
    expect(selectedTab()).toBe("Tasks");
  });
});
