// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyRail } from "./CompanyRail";
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
  logoUrl: string | null;
  brandColor: string | null;
};

const HQ: TestCompany = {
  id: "company-hq",
  name: "HQ",
  issuePrefix: "HQ",
  isPortfolioRoot: true,
  kind: "standard",
  status: "active",
  logoUrl: null,
  brandColor: null,
};

const ACME: TestCompany = {
  id: "company-acme",
  name: "Acme Printing",
  issuePrefix: "ACM",
  isPortfolioRoot: false,
  kind: "standard",
  status: "active",
  logoUrl: null,
  brandColor: null,
};

const navigateSpy = vi.hoisted(() => vi.fn());
const selectCompanySpy = vi.hoisted(() => vi.fn());
const railState = vi.hoisted(() => ({
  pathname: "/ACM/costs",
  companies: [] as unknown[],
  selectedCompanyId: null as string | null,
  /** The wide menu. While it is open the rail offers no shortcut panel. */
  sidebarOpen: true,
  isMobile: false,
  hasMailbox: true,
  hasPhoneAccount: true,
  pluginPageRoutePaths: [] as string[],
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: railState.pathname, search: "", hash: "" }),
  useNavigate: () => navigateSpy,
  // SidebarNavItem imports NavLink even though the shortcut rows never render
  // it; the flyout's rows are plain links so they can switch company first.
  NavLink: () => null,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: railState.companies,
    selectedCompanyId: railState.selectedCompanyId,
    setSelectedCompanyId: selectCompanySpy,
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ openOnboarding: vi.fn() }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: railState.isMobile,
    sidebarOpen: railState.sidebarOpen,
    setSidebarOpen: vi.fn(),
  }),
}));

// Which destinations the flyout offers depends on two add-ons. Both are asked
// the same question here that the real hooks ask the server.
vi.mock("../hooks/useEmailToolsPlugin", () => ({
  useEmailToolsPlugin: () => ({
    pluginId: "email-plugin",
    hasMailboxForCompany: railState.hasMailbox,
    isLoading: false,
  }),
}));

vi.mock("../hooks/usePhoneToolsPlugin", () => ({
  usePhoneToolsPlugin: () => ({
    pluginId: "phone-plugin",
    hasAccountForCompany: railState.hasPhoneAccount,
    isLoading: false,
  }),
}));

vi.mock("../plugins/slots", () => ({
  usePluginSlots: () => ({
    slots: railState.pluginPageRoutePaths.map((routePath) => ({
      routePath,
      displayName: routePath,
    })),
    isLoading: false,
    errorMessage: null,
  }),
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: { liveRunsForCompany: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/sidebarBadges", () => ({
  sidebarBadgesApi: { get: vi.fn().mockResolvedValue({ inbox: 0 }) },
}));

vi.mock("../api/auth", () => ({
  authApi: { getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) },
}));

// Ordering companies is its own hook with its own storage; the rail only
// needs the list back in some order for these tests.
vi.mock("../hooks/useCompanyOrder", () => ({
  useCompanyOrder: ({ companies }: { companies: unknown[] }) => ({
    orderedCompanies: companies,
    persistOrder: vi.fn(),
  }),
}));

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("CompanyRail", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    railState.pathname = "/ACM/costs";
    railState.companies = [HQ, ACME];
    railState.selectedCompanyId = ACME.id;
    railState.sidebarOpen = true;
    railState.isMobile = false;
    railState.hasMailbox = true;
    railState.hasPhoneAccount = true;
    railState.pluginPageRoutePaths = ["phone-active-calls", "notepad"];
    localStorage.clear();
    navigateSpy.mockClear();
    selectCompanySpy.mockClear();
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container.remove();
    document.body.innerHTML = "";
  });

  async function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <CompanyRail />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  function portfolioButton(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>('button[aria-label="Portfolio"]');
  }

  /** The company avatars are links; HQ's is the one pointing at HQ. */
  function hqAvatar(): HTMLAnchorElement | null {
    return container.querySelector<HTMLAnchorElement>('a[href="/HQ/dashboard"]');
  }

  function click(el: Element) {
    act(() => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  }

  it("puts a Portfolio button on the rail above HQ", async () => {
    await render();
    const portfolio = portfolioButton();
    expect(portfolio, "expected a Portfolio button on the rail").not.toBeNull();
    expect(hqAvatar(), "expected HQ on the rail").not.toBeNull();
    // Node.DOCUMENT_POSITION_FOLLOWING: HQ comes after Portfolio.
    expect(portfolio!.compareDocumentPosition(hqAvatar()!) & 4).toBe(4);
  });

  it("opens the all company version of the page you were on", async () => {
    railState.pathname = "/ACM/costs";
    await render();
    click(portfolioButton()!);
    expect(selectCompanySpy).toHaveBeenCalledWith(HQ.id, { source: "shortcut" });
    expect(navigateSpy).toHaveBeenCalledWith("/HQ/portfolio-costs");
  });

  it("falls back to the Portfolio Overview from a page with no all company version", async () => {
    railState.pathname = "/ACM/memories";
    await render();
    click(portfolioButton()!);
    expect(navigateSpy).toHaveBeenCalledWith("/HQ/portfolio-brief");
  });

  it("shows Portfolio as the one you are in, and does not also light HQ", async () => {
    // The two share an address prefix, so HQ is the selected company while a
    // portfolio page is open. Lighting both would say you are in two places.
    railState.pathname = "/HQ/portfolio-costs";
    railState.selectedCompanyId = HQ.id;
    await render();
    expect(portfolioButton()!.getAttribute("aria-pressed")).toBe("true");
    const hqPill = container.querySelector('a[href="/HQ/dashboard"] div');
    expect(hqPill?.className).toContain("h-0");
  });

  it("comes back to HQ's own version of the page when you click HQ from a portfolio page", async () => {
    railState.pathname = "/HQ/portfolio-costs";
    railState.selectedCompanyId = HQ.id;
    await render();
    click(container.querySelector('a[href="/HQ/dashboard"]')!);
    expect(navigateSpy).toHaveBeenCalledWith("/HQ/costs");
  });

  it("hides the Portfolio button from somebody who can only reach one company", async () => {
    railState.companies = [HQ];
    railState.selectedCompanyId = HQ.id;
    railState.pathname = "/HQ/brief";
    await render();
    expect(portfolioButton()).toBeNull();
    // HQ itself is still there; only the Portfolio button is withheld.
    expect(hqAvatar()).not.toBeNull();
  });

  it("hides the Portfolio button when there is no HQ to hang it under", async () => {
    railState.companies = [ACME];
    railState.selectedCompanyId = ACME.id;
    await render();
    expect(portfolioButton()).toBeNull();
  });

  describe("the shortcut panel beside a company logo", () => {
    /** Acme's logo on the rail. */
    function acmeAvatar(): HTMLAnchorElement {
      const avatar = container.querySelector<HTMLAnchorElement>('a[href="/ACM/dashboard"]');
      if (!avatar) throw new Error("expected Acme Printing on the rail");
      return avatar;
    }

    /** The panel is drawn into a portal, so it is not inside the rail. */
    function panel(): HTMLElement | null {
      return document.body.querySelector<HTMLElement>('[data-slot="popover-content"]');
    }

    function panelLinks(): HTMLAnchorElement[] {
      return Array.from(panel()?.querySelectorAll("a") ?? []);
    }

    function shortcutLabels(): string[] {
      const shortcuts = panel()?.querySelector("nav");
      return Array.from(shortcuts?.querySelectorAll("a") ?? []).map(
        (link) => link.textContent?.trim() ?? "",
      );
    }

    function press(el: Element | Document, key: string) {
      act(() => {
        el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });
    }

    /** The keyboard way in: focus the logo, press the right arrow key. */
    async function openWithKeyboard() {
      press(acmeAvatar(), "ArrowRight");
      await flushReact();
    }

    beforeEach(() => {
      // The panel is only offered when the wide menu is not already on screen.
      railState.sidebarOpen = false;
    });

    it("opens from the keyboard and shows the five the mockup asks for", async () => {
      await render();
      expect(panel(), "no panel before the right arrow key").toBeNull();
      await openWithKeyboard();
      expect(panel(), "expected the shortcut panel").not.toBeNull();
      expect(shortcutLabels()).toEqual(["Email", "Calendar", "Team", "Work", "Phone"]);
    });

    it("closes again on Escape", async () => {
      await render();
      await openWithKeyboard();
      press(document, "Escape");
      await flushReact();
      expect(panel()).toBeNull();
    });

    it("shows the company's full name and one line saying what it is", async () => {
      await render();
      await openWithKeyboard();
      const text = panel()?.textContent ?? "";
      expect(text).toContain("Acme Printing");
      expect(text).toContain("Its email, calendar, team, work and records.");
    });

    it("leaves Email out of a company with no mailbox", async () => {
      railState.hasMailbox = false;
      await render();
      await openWithKeyboard();
      expect(shortcutLabels()).toEqual(["Calendar", "Team", "Work", "Phone"]);
    });

    it("leaves Phone out where the add-on covers no account for this company", async () => {
      railState.hasPhoneAccount = false;
      await render();
      await openWithKeyboard();
      expect(shortcutLabels()).toEqual(["Email", "Calendar", "Team", "Work"]);
    });

    it("leaves Phone out where the add-on is not installed at all", async () => {
      railState.pluginPageRoutePaths = ["notepad"];
      await render();
      await openWithKeyboard();
      expect(shortcutLabels()).toEqual(["Email", "Calendar", "Team", "Work"]);
    });

    it("keeps the row back to the page you left off on", async () => {
      localStorage.setItem(
        "paperclip.companyPaths",
        JSON.stringify({ [ACME.id]: "/ACM/goals" }),
      );
      await render();
      await openWithKeyboard();
      expect(panel()?.textContent).toContain("Where you left off");
      const remembered = panelLinks().find((link) => link.getAttribute("href") === "/goals");
      expect(remembered, "expected a link back to the remembered page").toBeDefined();
      expect(remembered?.textContent).toContain("Goals");
    });

    it("takes a clicked shortcut over the page that company remembers", async () => {
      // The "shortcut" source is what stops the remembered page overriding
      // where the person asked to go.
      localStorage.setItem(
        "paperclip.companyPaths",
        JSON.stringify({ [ACME.id]: "/ACM/goals" }),
      );
      await render();
      await openWithKeyboard();
      const work = panelLinks().find((link) => link.getAttribute("href") === "/work");
      expect(work, "expected a Work shortcut").toBeDefined();
      click(work!);
      expect(selectCompanySpy).toHaveBeenCalledWith(ACME.id, { source: "shortcut" });
      expect(navigateSpy).toHaveBeenCalledWith("/ACM/work");
    });

    it("opens on a press and hold, and that hold does not also switch company", async () => {
      await render();
      act(() => {
        acmeAvatar().dispatchEvent(new Event("touchstart", { bubbles: true }));
      });
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 700));
      });
      expect(panel(), "expected the shortcut panel after a press and hold").not.toBeNull();
      // The tap that ends the hold must not carry on and open the company.
      click(acmeAvatar());
      expect(selectCompanySpy).not.toHaveBeenCalled();

      // An ordinary tap afterwards still works. A hold whose finger lifted
      // somewhere else would otherwise leave the next tap dead.
      act(() => {
        acmeAvatar().dispatchEvent(new Event("touchstart", { bubbles: true }));
        acmeAvatar().dispatchEvent(new Event("touchend", { bubbles: true }));
      });
      click(acmeAvatar());
      expect(selectCompanySpy).toHaveBeenCalledWith(ACME.id);
    });

    it("offers no panel while the wide menu is already on screen", async () => {
      railState.sidebarOpen = true;
      await render();
      await openWithKeyboard();
      expect(panel()).toBeNull();
    });
  });
});
