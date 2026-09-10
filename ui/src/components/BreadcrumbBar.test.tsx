// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BreadcrumbBar } from "./BreadcrumbBar";
import { TooltipProvider } from "./ui/tooltip";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type TestCompany = {
  id: string;
  name: string;
  issuePrefix: string;
  isPortfolioRoot: boolean;
  kind: "standard" | "personal";
  status: "active" | "archived";
};

const HQ: TestCompany = {
  id: "company-hq",
  name: "HQ",
  issuePrefix: "HQ",
  isPortfolioRoot: true,
  kind: "standard",
  status: "active",
};

const ACME: TestCompany = {
  id: "company-acme",
  name: "Acme Printing",
  issuePrefix: "ACM",
  isPortfolioRoot: false,
  kind: "standard",
  status: "active",
};

const PERSONAL: TestCompany = {
  id: "company-personal",
  name: "Alex",
  issuePrefix: "PER",
  isPortfolioRoot: false,
  kind: "personal",
  status: "active",
};

let currentPathname = "/ACM/brief";
let currentParams: { companyPrefix?: string } = { companyPrefix: "ACM" };
let currentCompanies: TestCompany[] = [HQ, ACME, PERSONAL];
let currentSelectedCompanyId: string | null = ACME.id;
let currentBreadcrumbs: { label: string; href?: string }[] = [{ label: "Brief" }];

const starterDialogRenders = vi.hoisted(() => vi.fn());
const navigateSpy = vi.hoisted(() => vi.fn());
const selectCompanySpy = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ children }: { children?: unknown }) => <a>{children as never}</a>,
  useLocation: () => ({ pathname: currentPathname, search: "", hash: "", state: null }),
  useParams: () => currentParams,
  useNavigate: () => navigateSpy,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ breadcrumbs: currentBreadcrumbs, mobileToolbar: null }),
}));

let onAPhone = false;

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    toggleSidebar: vi.fn(),
    sidebarOpen: true,
    isMobile: onAPhone,
  }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: currentCompanies,
    selectedCompanyId: currentSelectedCompanyId,
    selectedCompany: currentCompanies.find((c) => c.id === currentSelectedCompanyId) ?? null,
    setSelectedCompanyId: selectCompanySpy,
  }),
}));

vi.mock("../context/GeneralSettingsContext", () => ({
  useGeneralSettings: () => ({ keyboardShortcutsEnabled: true }),
}));

vi.mock("@/plugins/slots", () => ({
  usePluginSlots: () => ({ slots: [] }),
  PluginSlotOutlet: () => null,
}));

vi.mock("@/plugins/launchers", () => ({
  usePluginLaunchers: () => ({ launchers: [] }),
  PluginLauncherOutlet: () => null,
}));

// A stand-in so the test proves the top bar OPENS the real panel rather than
// growing a second copy of it. The point of the move is that the button is a
// new way in to StarterCatalogDialog, not a reimplementation.
vi.mock("./StarterCatalogDialog", () => ({
  StarterCatalogDialog: (props: { companyId: string; open: boolean }) => {
    starterDialogRenders(props);
    return props.open ? (
      <div data-testid="starter-dialog" data-company={props.companyId}>
        Start work panel
      </div>
    ) : null;
  },
}));

describe("BreadcrumbBar", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    onAPhone = false;
    currentPathname = "/ACM/brief";
    currentParams = { companyPrefix: "ACM" };
    currentCompanies = [HQ, ACME, PERSONAL];
    currentSelectedCompanyId = ACME.id;
    currentBreadcrumbs = [{ label: "Brief" }];
    starterDialogRenders.mockClear();
    navigateSpy.mockClear();
    selectCompanySpy.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render() {
    act(() => {
      root.render(
        <TooltipProvider>
          <BreadcrumbBar />
        </TooltipProvider>,
      );
    });
  }

  function scopeButton(): HTMLButtonElement {
    const el = container.querySelector<HTMLButtonElement>('button[aria-label^="Current scope:"]');
    expect(el, "expected a scope button in the top bar").not.toBeNull();
    return el!;
  }

  function click(el: Element) {
    act(() => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  }

  function openScopePanel(): HTMLElement {
    const already = document.querySelector<HTMLElement>('[data-slot="popover-content"]');
    if (already) return already;
    click(scopeButton());
    const panel = document.querySelector<HTMLElement>('[data-slot="popover-content"]');
    expect(panel, "expected the scope panel to open").not.toBeNull();
    return panel!;
  }

  function openScopePanelText(): string {
    return openScopePanel().textContent ?? "";
  }

  /** The rows under "Go to", in the order the panel lists them. */
  function scopeChoiceTitles(): string[] {
    return Array.from(openScopePanel().querySelectorAll("button")).map(
      (b) => b.querySelector("span > span")?.textContent ?? "",
    );
  }

  function clickScopeChoice(title: string) {
    const button = Array.from(openScopePanel().querySelectorAll("button")).find(
      (b) => b.querySelector("span > span")?.textContent === title,
    );
    expect(button, `expected a "${title}" row in the scope picker`).toBeDefined();
    click(button!);
  }

  it("puts the scope, search and start work in the top bar", () => {
    render();
    expect(scopeButton().textContent).toContain("Acme Printing");
    expect(container.querySelector('button[aria-label="Search"]')).not.toBeNull();
    const startWork = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Start work"),
    );
    expect(startWork, "expected a Start work button").toBeDefined();
    // The page title still shares the bar with them.
    expect(container.textContent).toContain("Brief");
  });

  it("reads the company from the address bar, not the selection, so a switch cannot flash the old scope", () => {
    // The selection in CompanyContext is synced from the route by an effect,
    // so for one render after a cross-company navigation it still holds the
    // PREVIOUS company. Reading it here would print the previous company's
    // name in the scope button for a frame. See hooks/useRouteCompany.ts.
    currentPathname = "/ACM/brief";
    currentParams = { companyPrefix: "ACM" };
    currentSelectedCompanyId = HQ.id;
    render();
    expect(scopeButton().textContent).toContain("Acme Printing");
    expect(scopeButton().textContent).not.toContain("HQ");
  });

  it("explains an ordinary company scope in plain words when opened", () => {
    render();
    const text = openScopePanelText();
    expect(text).toContain("One company's own working area.");
    expect(text).toContain("What it includes");
    expect(text).toContain("Its email, calendar, team, work and records.");
    expect(text).toContain("Searches, records, actions and agent choices all stay inside this company.");
  });

  it("separates HQ's own scope from the portfolio one at the same URL depth", () => {
    currentPathname = "/HQ/brief";
    currentParams = { companyPrefix: "HQ" };
    currentSelectedCompanyId = HQ.id;
    render();
    expect(scopeButton().textContent).toContain("HQ");
    const text = openScopePanelText();
    expect(text).toContain("HQ's own agents, work and records.");
    expect(text).toContain("This is not the all company total. Open Portfolio for that.");
  });

  it("names the portfolio scope and counts the companies it covers", () => {
    currentPathname = "/HQ/portfolio-brief";
    currentParams = { companyPrefix: "HQ" };
    currentSelectedCompanyId = HQ.id;
    render();
    // HQ itself and archived companies are excluded from the count, matching
    // every other portfolio count in the app.
    expect(scopeButton().textContent).toContain("Portfolio · 2 companies");
    const text = openScopePanelText();
    expect(text).toContain("All the companies you can open, added together in one view.");
    expect(text).toContain("Covers the 2 companies you can open.");
  });

  it("explains the private personal scope", () => {
    currentPathname = "/PER/todos";
    currentParams = { companyPrefix: "PER" };
    currentSelectedCompanyId = PERSONAL.id;
    render();
    const text = openScopePanelText();
    expect(text).toContain("Your own private space.");
    expect(text).toContain("Your private to-dos and notes, which follow you from company to company.");
  });

  it("explains instance settings as covering the whole install", () => {
    currentPathname = "/instance/settings/general";
    currentParams = {};
    currentSelectedCompanyId = ACME.id;
    render();
    expect(scopeButton().textContent).toContain("Instance settings");
    const text = openScopePanelText();
    expect(text).toContain("Settings for this whole Paperclip install.");
    expect(text).toContain("Every company on it, not just the one you were last in.");
  });

  it("opens the command palette through its existing keyboard shortcut rather than a second search", () => {
    render();
    const seen: KeyboardEvent[] = [];
    const listener = (e: Event) => seen.push(e as KeyboardEvent);
    document.addEventListener("keydown", listener);
    click(container.querySelector('button[aria-label="Search"]')!);
    document.removeEventListener("keydown", listener);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.key).toBe("k");
    expect(seen[0]!.metaKey).toBe(true);
  });

  it("opens the existing start work panel for the company in the address bar", () => {
    render();
    expect(container.querySelector('[data-testid="starter-dialog"]')).toBeNull();
    const startWork = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Start work"),
    )!;
    click(startWork);
    const dialog = container.querySelector('[data-testid="starter-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute("data-company")).toBe(ACME.id);
  });

  it("hides start work where the scope does not name one company", () => {
    // Portfolio pages are mounted under HQ's own prefix, so a Start work
    // button here would silently file portfolio work into HQ. The scope
    // document forbids exactly that.
    currentPathname = "/HQ/portfolio-brief";
    currentParams = { companyPrefix: "HQ" };
    currentSelectedCompanyId = HQ.id;
    render();
    const startWork = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Start work"),
    );
    expect(startWork).toBeUndefined();
    expect(starterDialogRenders).not.toHaveBeenCalled();
  });

  it("lists Portfolio first and HQ below it, so the two can be told apart and picked", () => {
    render();
    expect(scopeChoiceTitles()).toEqual(["Portfolio", "HQ", "Acme Printing", "Alex"]);
    const text = openScopePanelText();
    expect(text).toContain("Its own team and work, not the all company total.");
  });

  it("opens the all company version of the page you were on when you pick Portfolio", () => {
    // Not a fixed landing page. Portfolio pages live under HQ's own address
    // prefix, so this is a page change rather than a company change.
    currentPathname = "/ACM/costs";
    currentParams = { companyPrefix: "ACM" };
    render();
    clickScopeChoice("Portfolio");
    expect(selectCompanySpy).toHaveBeenCalledWith(HQ.id, { source: "shortcut" });
    expect(navigateSpy).toHaveBeenCalledWith("/HQ/portfolio-costs");
  });

  it("falls back to the Portfolio Overview from a page with no all company version", () => {
    currentPathname = "/ACM/memories";
    currentParams = { companyPrefix: "ACM" };
    render();
    clickScopeChoice("Portfolio");
    expect(navigateSpy).toHaveBeenCalledWith("/HQ/portfolio-brief");
  });

  it("comes back to HQ's own version of the page when you pick HQ from a portfolio page", () => {
    // HQ is already the selected company here, so an ordinary switch would do
    // nothing at all and leave you looking at the portfolio page.
    currentPathname = "/HQ/portfolio-costs";
    currentParams = { companyPrefix: "HQ" };
    currentSelectedCompanyId = HQ.id;
    render();
    clickScopeChoice("HQ");
    expect(navigateSpy).toHaveBeenCalledWith("/HQ/costs");
  });

  it("leaves an ordinary company switch exactly as it was, with no destination of its own", () => {
    render();
    clickScopeChoice("Alex");
    expect(selectCompanySpy).toHaveBeenCalledWith(PERSONAL.id);
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("offers no Portfolio row to somebody who can only reach one company", () => {
    currentCompanies = [HQ];
    currentSelectedCompanyId = HQ.id;
    currentPathname = "/HQ/brief";
    currentParams = { companyPrefix: "HQ" };
    render();
    expect(scopeChoiceTitles()).toEqual(["HQ"]);
  });

  it("still shows the sidebar toggle and the page title alongside the new controls", () => {
    currentBreadcrumbs = [{ label: "Work", href: "/ACM/issues" }, { label: "ACM-12" }];
    render();
    expect(container.querySelector('button[aria-label="Hide sidebar"]')).not.toBeNull();
    expect(container.textContent).toContain("ACM-12");
  });

  // Layout finds this button by attribute to put focus back on it when the
  // phone sidebar drawer closes, including when the drawer was opened by a
  // swipe and so had no button to remember. Without the marker, focus lands on
  // the page body and the next Tab starts again from the top of the document.
  it("marks the sidebar toggle so the phone drawer can hand focus back to it", () => {
    render();
    const toggle = container.querySelector("[data-sidebar-toggle]");
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute("aria-label")).toBe("Hide sidebar");
  });

  /**
   * The page name on a phone.
   *
   * On one line the scope button wins: it is as wide as the company's name
   * and does not give way, so the page name was squeezed to nothing and a
   * phone user could not tell which page they were on. These tests cannot
   * measure that, because jsdom does not lay anything out. What they can
   * check is the thing that causes it: whether the two share a line or are
   * stacked. The widths were checked by hand in a real browser at 375 pixels
   * across.
   */
  function scopeAndTitleShareABox(): HTMLElement {
    const title = container.querySelector("h1");
    expect(title, "expected the page name in the top bar").not.toBeNull();
    const box = title!.parentElement!;
    expect(box.contains(scopeButton()), "expected the scope beside the page name").toBe(true);
    return box;
  }

  it("stacks the page name under the scope on a phone, so both can be read", () => {
    onAPhone = true;
    render();

    const box = scopeAndTitleShareABox();
    expect(container.querySelector("h1")!.textContent).toBe("Brief");
    expect(box.className).toContain("flex-col");
    // The middot only joins them when they share a line.
    expect(box.textContent).not.toContain("·");
  });

  it("keeps the scope and the page name on one line on a wide screen", () => {
    render();

    const box = scopeAndTitleShareABox();
    expect(box.className).not.toContain("flex-col");
    expect(box.textContent).toContain("·");
  });
});
