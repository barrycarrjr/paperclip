// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Layout } from "./Layout";
import { PAGE_FLOATING_LAYER_ATTRIBUTE, PageFloating } from "./PageFloatingLayer";
import {
  ABOVE_MOBILE_BOTTOM_NAV_CLASS,
  APP_NAV_WIDTH_PROPERTY,
  PAGE_AREA_CLIPS_SIDEWAYS_CLASS,
  PAGE_AREA_CONTAINER_CLASS,
  PAGE_END_ROOM_CLASS,
} from "../lib/narrow-layout";

const mockHealthApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

const mockSystemApi = vi.hoisted(() => ({
  shutdown: vi.fn(),
  restart: vi.fn(),
  update: vi.fn(),
  rebuild: vi.fn(),
  checkUpdate: vi.fn(),
}));

const mockSidebarAccountMenu = vi.hoisted(() =>
  vi.fn(
    (props: {
      updateAvailable?: boolean;
      remoteRelation?: string | null;
      trackedBranch?: string | null;
      runningFromSource?: boolean;
    }) => (
      <div
        data-testid="account-menu"
        data-update-available={props.updateAvailable ? "yes" : "no"}
        data-remote-relation={props.remoteRelation ?? "none"}
        data-tracked-branch={props.trackedBranch ?? "none"}
        data-running-from-source={props.runningFromSource ? "yes" : "no"}
      >
        Account menu
      </div>
    ),
  ),
);

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getGeneral: vi.fn(),
}));

const mockNavigate = vi.hoisted(() => vi.fn());
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());
const mockSetSidebarOpen = vi.hoisted(() => vi.fn());
// Mutable so a test can put the shell on a phone, or close the sidebar,
// without a second copy of the whole mock list.
const sidebarState = vi.hoisted(() => ({ sidebarOpen: true, isMobile: false }));
let currentPathname = "/PAP/dashboard";
let currentCompanyPrefix = "PAP";
// The page the Outlet draws, when a test needs one of its own.
const outletState = vi.hoisted(() => ({ page: null as null | (() => ReactNode) }));

vi.mock("@/lib/router", () => ({
  Outlet: () => (outletState.page ? outletState.page() : <div data-testid="outlet-content">Outlet content</div>),
  useLocation: () => ({ pathname: currentPathname, search: "", hash: "", state: null }),
  useNavigate: () => mockNavigate,
  useNavigationType: () => "PUSH",
  useParams: () => ({ companyPrefix: currentCompanyPrefix }),
}));

vi.mock("./CompanyRail", () => ({
  CompanyRail: () => <div>Company rail</div>,
}));

vi.mock("./Sidebar", () => ({
  Sidebar: () => <div>Main company nav</div>,
}));

vi.mock("./InstanceSidebar", () => ({
  InstanceSidebar: () => <div>Instance sidebar</div>,
}));

vi.mock("./CompanySettingsSidebar", () => ({
  CompanySettingsSidebar: () => <div>Company settings sidebar</div>,
}));

vi.mock("./BreadcrumbBar", () => ({
  BreadcrumbBar: () => <div>Breadcrumbs</div>,
}));

vi.mock("./PropertiesPanel", () => ({
  PropertiesPanel: () => null,
}));

vi.mock("./CommandPalette", () => ({
  CommandPalette: () => null,
}));

vi.mock("./NewIssueDialog", () => ({
  NewIssueDialog: () => null,
}));

vi.mock("./NewProjectDialog", () => ({
  NewProjectDialog: () => null,
}));

vi.mock("./NewGoalDialog", () => ({
  NewGoalDialog: () => null,
}));

vi.mock("./NewAgentDialog", () => ({
  NewAgentDialog: () => null,
}));

vi.mock("./KeyboardShortcutsCheatsheet", () => ({
  KeyboardShortcutsCheatsheet: () => null,
}));

vi.mock("./ToastViewport", () => ({
  ToastViewport: () => null,
}));

vi.mock("./MobileBottomNav", () => ({
  MobileBottomNav: () => null,
}));

// The window has tests of its own; here only what the shell does around it.
vi.mock("./ClippyWindow", () => ({
  ClippyWindow: () => null,
}));

vi.mock("./WorktreeBanner", () => ({
  WorktreeBanner: () => null,
}));

vi.mock("./DevRestartBanner", () => ({
  DevRestartBanner: () => null,
}));

vi.mock("./SidebarAccountMenu", () => ({
  SidebarAccountMenu: mockSidebarAccountMenu,
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    openNewIssue: vi.fn(),
    openOnboarding: vi.fn(),
  }),
}));

vi.mock("../context/PanelContext", () => ({
  usePanel: () => ({
    togglePanelVisible: vi.fn(),
  }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [
      { id: "company-1", issuePrefix: "PAP", name: "Paperclip" },
      { id: "company-2", issuePrefix: "ACME", name: "Acme" },
    ],
    loading: false,
    selectedCompany: { id: "company-1", issuePrefix: "PAP", name: "Paperclip" },
    selectedCompanyId: "company-1",
    selectionSource: "manual",
    setSelectedCompanyId: mockSetSelectedCompanyId,
  }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    sidebarOpen: sidebarState.sidebarOpen,
    setSidebarOpen: mockSetSidebarOpen,
    toggleSidebar: vi.fn(),
    isMobile: sidebarState.isMobile,
  }),
}));

vi.mock("../hooks/useKeyboardShortcuts", () => ({
  useKeyboardShortcuts: () => undefined,
}));

vi.mock("../hooks/useCompanyPageMemory", () => ({
  useCompanyPageMemory: () => undefined,
}));

vi.mock("../api/health", () => ({
  healthApi: mockHealthApi,
}));

vi.mock("../api/system", () => ({
  systemApi: mockSystemApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../lib/company-selection", () => ({
  shouldSyncCompanySelectionFromRoute: () => false,
  shouldClearTransientSelectionSource: () => false,
}));

vi.mock("../lib/instance-settings", () => ({
  DEFAULT_INSTANCE_SETTINGS_PATH: "/instance/settings/general",
  normalizeRememberedInstanceSettingsPath: (value: string | null | undefined) =>
    value ?? "/instance/settings/general",
}));

vi.mock("../lib/main-content-focus", () => ({
  scheduleMainContentFocus: () => () => undefined,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("Layout", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    currentPathname = "/PAP/dashboard";
    currentCompanyPrefix = "PAP";
    sidebarState.sidebarOpen = true;
    sidebarState.isMobile = false;
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      version: "1.2.3",
    });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({
      keyboardShortcuts: false,
    });
    mockSystemApi.checkUpdate.mockResolvedValue({
      available: false,
      localCommit: null,
      remoteCommit: null,
      branch: null,
      lastChecked: new Date().toISOString(),
    });
    mockSidebarAccountMenu.mockClear();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
    outletState.page = null;
  });

  it("does not render the deployment explainer in the shared layout", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(mockHealthApi.get).toHaveBeenCalled();
    expect(container.textContent).toContain("Breadcrumbs");
    expect(container.textContent).toContain("Outlet content");
    expect(container.textContent).not.toContain("Authenticated private");
    expect(container.textContent).not.toContain(
      "Sign-in is required and this instance is intended for private-network access.",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("forwards updateAvailable to SidebarAccountMenu when /system/update-check reports an update", async () => {
    mockSystemApi.checkUpdate.mockResolvedValue({
      available: true,
      localCommit: "ab461f01bb91c06a9d4f69eef11caa3c758b0576",
      remoteCommit: "feedfaceabc1234567890",
      branch: "master",
      lastChecked: new Date().toISOString(),
    });

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(mockSystemApi.checkUpdate).toHaveBeenCalled();
    const accountMenuNode = container.querySelector('[data-testid="account-menu"]');
    expect(accountMenuNode?.getAttribute("data-update-available")).toBe("yes");

    await act(async () => {
      root.unmount();
    });
  });

  // A copy running the working tree has no build to move forward. The account
  // menu can only say so, and only leave the Rebuild pill off, if the fact
  // reaches it.
  it("forwards the running-from-source answer to SidebarAccountMenu", async () => {
    mockSystemApi.checkUpdate.mockResolvedValue({
      available: false,
      localCommit: "e1660dbe9e68191fb8d93e2d671e4ce5e4a9d55f",
      remoteCommit: "558f0096faa8fbb1caee01dede0de231568f7ee5",
      installedCommit: "558f0096faa8fbb1caee01dede0de231568f7ee5",
      runningFromSource: true,
      reason: null,
      remoteRelation: "ahead",
      branch: "master",
      lastChecked: new Date().toISOString(),
    });

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const accountMenuNode = container.querySelector('[data-testid="account-menu"]');
    expect(accountMenuNode?.getAttribute("data-running-from-source")).toBe("yes");
    expect(accountMenuNode?.getAttribute("data-update-available")).toBe("no");

    await act(async () => {
      root.unmount();
    });
  });

  // The same wiring on an instance that runs a build: the rebuild is still
  // offered, and the working-tree answer is plainly no.
  it("forwards a build-behind rebuild offer with running-from-source off", async () => {
    mockSystemApi.checkUpdate.mockResolvedValue({
      available: true,
      localCommit: "e1660dbe9e68191fb8d93e2d671e4ce5e4a9d55f",
      remoteCommit: "e1660dbe9e68191fb8d93e2d671e4ce5e4a9d55f",
      installedCommit: "558f0096faa8fbb1caee01dede0de231568f7ee5",
      runningFromSource: false,
      reason: "build_behind",
      remoteRelation: "level",
      branch: "master",
      lastChecked: new Date().toISOString(),
    });

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const accountMenuNode = container.querySelector('[data-testid="account-menu"]');
    expect(accountMenuNode?.getAttribute("data-running-from-source")).toBe("no");
    expect(accountMenuNode?.getAttribute("data-update-available")).toBe("yes");

    await act(async () => {
      root.unmount();
    });
  });

  // A copy that is ahead of GitHub has nothing to update, and the account menu
  // can only say so if the direction reaches it.
  it("forwards the remote direction and the tracked branch to SidebarAccountMenu", async () => {
    mockSystemApi.checkUpdate.mockResolvedValue({
      available: false,
      localCommit: "8655f5e926a7e0e99f0e5019716c73c4fe5e2d32",
      remoteCommit: "558f0096faa8fbb1caee01dede0de231568f7ee5",
      installedCommit: "558f0096faa8fbb1caee01dede0de231568f7ee5",
      reason: null,
      remoteRelation: "ahead",
      branch: "master",
      lastChecked: new Date().toISOString(),
    });

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const accountMenuNode = container.querySelector('[data-testid="account-menu"]');
    expect(accountMenuNode?.getAttribute("data-update-available")).toBe("no");
    expect(accountMenuNode?.getAttribute("data-remote-relation")).toBe("ahead");
    expect(accountMenuNode?.getAttribute("data-tracked-branch")).toBe("master");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders the company settings sidebar on company settings routes", async () => {
    currentPathname = "/PAP/company/settings/access";
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Company settings sidebar");
    expect(container.textContent).not.toContain("Instance sidebar");
    expect(container.textContent).not.toContain("Main company nav");

    await act(async () => {
      root.unmount();
    });
  });

  /**
   * Switching company keeps you on the same page now (lib/company-switch.ts),
   * so /PAP/routines becomes /ACME/routines: the same route with a different
   * value in it. React would keep the page mounted through that, and every
   * draft, open dialog and typed filter in it would carry the old company's
   * records into the new one. The page is keyed by the company in the address
   * to stop that, and these two check both halves of it.
   */
  it("starts the page again when the company in the address changes", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    const before = container.querySelector('[data-testid="outlet-content"]');
    expect(before).not.toBeNull();

    currentCompanyPrefix = "ACME";
    currentPathname = "/ACME/dashboard";
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const after = container.querySelector('[data-testid="outlet-content"]');
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps the page as it is when the address moves inside one company", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    const before = container.querySelector('[data-testid="outlet-content"]');

    currentPathname = "/PAP/issues";
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.querySelector('[data-testid="outlet-content"]')).toBe(before);

    await act(async () => {
      root.unmount();
    });
  });

  /**
   * The narrow-width and keyboard-only audit of 2026-09-08
   * (docs/plans/2026-09-08-narrow-and-keyboard-audit.md) found three separate
   * ways the sidebar left controls where a person could not use them:
   *
   *  - closed on a phone, sixty of the eighty-five things you could Tab to on
   *    the page were inside a drawer that had only been slid off screen;
   *  - collapsed on a desktop, twenty-five stayed in the tab order at zero
   *    width;
   *  - open on a phone, Tab walked straight out of the drawer, Escape did
   *    nothing, and focus sat on the toggle button the drawer was covering.
   */
  async function renderLayout() {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const render = async () => {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <Layout />
          </QueryClientProvider>,
        );
      });
      await flushReact();
    };
    await render();
    await flushReact();
    return { root, render };
  }

  function sheetContent(): HTMLElement | null {
    return document.querySelector('[data-slot="sheet-content"]');
  }

  it("keeps nothing from the closed phone drawer in the keyboard's path", async () => {
    sidebarState.isMobile = true;
    sidebarState.sidebarOpen = false;

    const { root } = await renderLayout();

    expect(sheetContent()).toBeNull();
    expect(document.body.textContent).not.toContain("Main company nav");
    expect(document.body.textContent).not.toContain("Company rail");
    expect(document.body.textContent).not.toContain("Account menu");

    await act(async () => {
      root.unmount();
    });
  });

  it("moves focus into the phone drawer when it opens, and closes it on Escape", async () => {
    sidebarState.isMobile = true;
    sidebarState.sidebarOpen = false;
    const { root, render } = await renderLayout();

    sidebarState.sidebarOpen = true;
    await render();

    const drawer = sheetContent();
    expect(drawer).not.toBeNull();
    expect(drawer!.textContent).toContain("Main company nav");
    expect(drawer!.textContent).toContain("Company rail");
    // Focus lands on the drawer itself rather than the first control in it: the
    // first control is a company logo, and focusing it opens that logo's
    // tooltip, which is then frontmost and swallows the first Escape.
    expect(document.activeElement).toBe(drawer);

    mockSetSidebarOpen.mockClear();
    await act(async () => {
      drawer!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flushReact();

    expect(mockSetSidebarOpen).toHaveBeenCalledWith(false);

    await act(async () => {
      root.unmount();
    });
  });

  it("puts focus back on the button that opened the phone drawer", async () => {
    sidebarState.isMobile = true;
    sidebarState.sidebarOpen = false;
    const { root, render } = await renderLayout();

    const toggle = document.createElement("button");
    toggle.setAttribute("data-sidebar-toggle", "true");
    toggle.textContent = "Show sidebar";
    document.body.appendChild(toggle);
    toggle.focus();
    expect(document.activeElement).toBe(toggle);

    sidebarState.sidebarOpen = true;
    await render();
    expect(document.activeElement).toBe(sheetContent());

    sidebarState.sidebarOpen = false;
    await render();
    await flushReact();

    expect(sheetContent()).toBeNull();
    expect(document.activeElement).toBe(toggle);

    toggle.remove();
    await act(async () => {
      root.unmount();
    });
  });

  it("falls back to the sidebar toggle when the drawer was opened by a swipe", async () => {
    // A swipe from the left edge opens the drawer with nothing focused, so
    // there is no opener to remember and focus would otherwise land on the
    // page body, sending the next Tab back to the top of the document.
    sidebarState.isMobile = true;
    sidebarState.sidebarOpen = false;
    const { root, render } = await renderLayout();

    const toggle = document.createElement("button");
    toggle.setAttribute("data-sidebar-toggle", "true");
    toggle.textContent = "Show sidebar";
    document.body.appendChild(toggle);
    (document.activeElement as HTMLElement | null)?.blur();

    sidebarState.sidebarOpen = true;
    await render();
    sidebarState.sidebarOpen = false;
    await render();
    await flushReact();

    expect(document.activeElement).toBe(toggle);

    toggle.remove();
    await act(async () => {
      root.unmount();
    });
  });

  it("marks the collapsed desktop sidebar inert, and does not while it is open", async () => {
    sidebarState.isMobile = false;
    sidebarState.sidebarOpen = false;
    const { root, render } = await renderLayout();

    const panel = container.querySelector('div[class*="transition-[width]"]');
    expect(panel).not.toBeNull();
    // `inert` is what a browser reads to take everything inside out of the tab
    // order and away from screen readers. jsdom carries the attribute but does
    // not act on it, so this checks the attribute is there and the live check
    // was done in a real browser.
    expect(panel!.hasAttribute("inert")).toBe(true);

    sidebarState.sidebarOpen = true;
    await render();
    expect(
      container.querySelector('div[class*="transition-[width]"]')!.hasAttribute("inert"),
    ).toBe(false);

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps the Clippy launcher clear of the phone bottom bar", async () => {
    // The launcher was pinned at bottom-4 on a higher layer than the bar, so it
    // covered the last button in the bar exactly and every tap on that button
    // opened Clippy instead.
    sidebarState.isMobile = true;
    sidebarState.sidebarOpen = false;
    const { root } = await renderLayout();

    const launcher = document.querySelector('button[aria-label^="Ask Clippy"]');
    expect(launcher).not.toBeNull();
    for (const part of ABOVE_MOBILE_BOTTOM_NAV_CLASS.split(" ")) {
      expect(launcher!.classList.contains(part)).toBe(true);
    }
    expect(launcher!.classList.contains("bottom-4")).toBe(false);

    await act(async () => {
      root.unmount();
    });
  });

  it("takes everything behind full screen Clippy out of the keyboard's reach, the skip link and banners included", async () => {
    // Only the page itself used to be, so Tab still walked out of Clippy to
    // the skip link and the banners at the top.
    window.localStorage.setItem("paperclip.clippy.mode", "fullscreen");
    const { root } = await renderLayout();
    const skipLink = container.querySelector('a[href="#main-content"]')!;
    expect(skipLink.hasAttribute("inert")).toBe(false);

    const launcher = document.querySelector<HTMLButtonElement>('button[aria-label^="Ask Clippy"]')!;
    await act(async () => {
      launcher.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(skipLink.hasAttribute("inert")).toBe(true);
    expect(container.querySelector("#main-content")!.closest("[inert]")).not.toBeNull();
    expect(container.querySelector("div.contents")?.hasAttribute("inert")).toBe(true);

    window.localStorage.removeItem("paperclip.clippy.mode");
    await act(async () => {
      root.unmount();
    });
  });

  it("hides the Clippy launcher on the full Clippy page, and only there", async () => {
    // There it would only open a second Clippy over the page, and the pill
    // sat against the corner of the page's own message box.
    currentPathname = "/PAP/clippy";
    const { root } = await renderLayout();
    const launcher = document.querySelector<HTMLButtonElement>('button[aria-label^="Ask Clippy"]');
    expect(launcher?.hidden).toBe(true);
    await act(async () => {
      root.unmount();
    });

    currentPathname = "/PAP/clippy-notes";
    const second = await renderLayout();
    expect(document.querySelector<HTMLButtonElement>('button[aria-label^="Ask Clippy"]')?.hidden).toBe(false);
    await act(async () => {
      second.root.unmount();
    });
  });

  it("stops a page that is too wide taking the whole phone shell sideways", async () => {
    // The Phone Wallboard plugin page asks for panels of at least 360 pixels,
    // which is more than a 375 pixel phone has, and the whole app including
    // the top bar could then be dragged off the side of the screen. Where the
    // page area stops is the app's business, not the plugin's.
    sidebarState.isMobile = true;
    sidebarState.sidebarOpen = false;
    const { root } = await renderLayout();

    const pageArea = container.querySelector("#main-content");
    expect(pageArea).not.toBeNull();
    for (const part of PAGE_AREA_CLIPS_SIDEWAYS_CLASS.split(" ")) {
      expect(pageArea!.classList.contains(part)).toBe(true);
    }
    // jsdom has no layout engine, so this checks the rule is applied to the
    // right element. What it looks like was measured in a real browser at 375
    // wide: the document went from 392 pixels against a 367 pixel page, which
    // could be dragged 25 pixels sideways, to 367 pixels and nothing to drag.
    expect(pageArea!.classList.contains("overflow-visible")).toBe(false);

    await act(async () => {
      root.unmount();
    });
  });

  it("makes the page area a size container, on a desktop and on a phone", async () => {
    // Pages measured their columns against the window, so docked Clippy,
    // which takes 420 pixels from the page without the window narrowing,
    // squeezed four stat cards into columns of about 150 pixels. A container
    // query measures the page area instead.
    for (const isMobile of [false, true]) {
      sidebarState.isMobile = isMobile;
      const { root } = await renderLayout();
      const pageArea = container.querySelector("#main-content");
      expect(pageArea).not.toBeNull();
      expect(pageArea!.classList.contains(PAGE_AREA_CONTAINER_CLASS)).toBe(true);
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("keeps room at the end of a desktop page that scrolls, under the Clippy launcher, and not on a phone", async () => {
    // Scrolled to its end, the Pipelines "add items" page put its Submit
    // button on the launcher. jsdom has no layout, so the page area is given
    // a page taller than itself by hand, and a stand-in ResizeObserver reports
    // the change, as it does when a page grows while its data loads.
    const reportResize: Array<(entries: unknown[]) => void> = [];
    class FakeResizeObserver {
      constructor(callback: (entries: unknown[]) => void) {
        reportResize.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    try {
      for (const isMobile of [false, true]) {
        sidebarState.isMobile = isMobile;
        reportResize.length = 0;
        const { root } = await renderLayout();

        const pageArea = container.querySelector<HTMLElement>("#main-content")!;
        for (const part of PAGE_END_ROOM_CLASS.split(" ")) {
          expect(pageArea.classList.contains(part)).toBe(true);
        }
        expect(pageArea.dataset.pageEndRoom, "no room while the page fits").toBeUndefined();

        // The page grows past the bottom of the page area.
        Object.defineProperty(pageArea, "scrollHeight", { configurable: true, value: 1400 });
        Object.defineProperty(pageArea, "clientHeight", { configurable: true, value: 800 });
        await act(async () => {
          for (const report of reportResize) report([]);
        });

        // A phone keeps room for its bottom bar and the launcher already.
        expect(pageArea.dataset.pageEndRoom, isMobile ? "on a phone" : "on a desktop").toBe(
          isMobile ? undefined : "true",
        );

        await act(async () => {
          root.unmount();
        });
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes the width of the rail and the navigation for the toasts to sit beside", async () => {
    // At the left edge of the window a message covered the account button.
    sidebarState.isMobile = false;
    sidebarState.sidebarOpen = true;
    const { root, render } = await renderLayout();
    const shell = () => container.firstElementChild as HTMLElement;
    expect(shell().style.getPropertyValue(APP_NAV_WIDTH_PROPERTY)).toBe("312px");

    sidebarState.sidebarOpen = false;
    await render();
    expect(shell().style.getPropertyValue(APP_NAV_WIDTH_PROPERTY)).toBe("72px");

    await act(async () => {
      root.unmount();
    });
  });

  it("publishes no navigation width on a phone, where the navigation is a drawer", async () => {
    sidebarState.isMobile = true;
    sidebarState.sidebarOpen = false;
    const { root } = await renderLayout();
    const shell = container.firstElementChild as HTMLElement;
    expect(shell.style.getPropertyValue(APP_NAV_WIDTH_PROPERTY)).toBe("");
    await act(async () => {
      root.unmount();
    });
  });

  /**
   * Safari before 18.4 made a size container, which the page area is, the box
   * that `position: fixed` elements inside it are placed against, so on an
   * older iPhone the agent Save bar sat at the end of the page instead of at
   * the bottom of the screen. A page's own fixed bars and buttons are drawn in
   * a layer beside the page area (PageFloating) instead.
   */
  function pageWithSaveBar() {
    return (
      <>
        <div data-testid="outlet-content">Outlet content</div>
        <PageFloating>
          <div data-testid="page-save-bar" className="fixed bottom-6">
            Save
          </div>
        </PageFloating>
      </>
    );
  }

  it("draws a page's own fixed bar beside the page area, not inside it, on a desktop and on a phone", async () => {
    outletState.page = pageWithSaveBar;
    for (const isMobile of [false, true]) {
      sidebarState.isMobile = isMobile;
      const { root } = await renderLayout();

      const pageArea = container.querySelector("#main-content")!;
      const layer = container.querySelector(`[${PAGE_FLOATING_LAYER_ATTRIBUTE}]`);
      const bar = container.querySelector('[data-testid="page-save-bar"]');
      expect(layer, "Layout draws the layer").not.toBeNull();
      expect(bar, "the page's bar is drawn").not.toBeNull();
      expect(layer!.contains(bar)).toBe(true);
      expect(pageArea.contains(bar)).toBe(false);
      // Beside the page area, and taking no room of its own there.
      expect(layer!.parentElement).toBe(pageArea.parentElement);
      expect(layer!.classList.contains("contents")).toBe(true);
      // The page itself stays in the page area.
      expect(pageArea.querySelector('[data-testid="outlet-content"]')).not.toBeNull();

      await act(async () => {
        root.unmount();
      });
    }
  });

  it("keeps a page's fixed bar with the page: out of reach behind full screen Clippy, and given the navigation's width", async () => {
    outletState.page = pageWithSaveBar;
    sidebarState.isMobile = false;
    window.localStorage.setItem("paperclip.clippy.mode", "fullscreen");
    const { root } = await renderLayout();
    const bar = container.querySelector('[data-testid="page-save-bar"]')!;

    // Inside the shell that publishes the navigation's width, which the bars
    // centred along the bottom read (PAGE_BOTTOM_BAR_CENTER_CLASS).
    const shell = container.firstElementChild as HTMLElement;
    expect(shell.style.getPropertyValue(APP_NAV_WIDTH_PROPERTY)).not.toBe("");
    expect(shell.contains(bar)).toBe(true);
    expect(bar.closest("[inert]")).toBeNull();

    const launcher = document.querySelector<HTMLButtonElement>('button[aria-label^="Ask Clippy"]')!;
    await act(async () => {
      launcher.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    // Out of the keyboard's path together with the page, not left in front.
    expect(container.querySelector("#main-content")!.closest("[inert]")).not.toBeNull();
    expect(bar.closest("[inert]")).not.toBeNull();

    window.localStorage.removeItem("paperclip.clippy.mode");
    await act(async () => {
      root.unmount();
    });
  });

  it("lets a desktop page area scroll itself rather than clipping it", async () => {
    // The two halves of the same rule: on a desktop the page area is already a
    // scrolling box, so a page that is too wide gets its own scrollbar and the
    // shell around it still does not move. Clipping there would hide content a
    // desktop user can reach today.
    sidebarState.isMobile = false;
    const { root } = await renderLayout();

    const pageArea = container.querySelector("#main-content");
    expect(pageArea).not.toBeNull();
    expect(pageArea!.classList.contains("overflow-auto")).toBe(true);
    expect(pageArea!.classList.contains("overflow-x-clip")).toBe(false);

    await act(async () => {
      root.unmount();
    });
  });
});
