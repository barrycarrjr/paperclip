// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageSquare } from "lucide-react";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarPeekProvider } from "../context/SidebarPeekContext";

const mockNavigate = vi.hoisted(() => vi.fn());
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());
const companiesState = vi.hoisted(() => ({
  companies: [
    { id: "current-id", issuePrefix: "IND" },
    { id: "peeked-id", issuePrefix: "PER" },
  ],
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
  NavLink: () => null,
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn() }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: companiesState.companies,
    setSelectedCompanyId: mockSetSelectedCompanyId,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("SidebarNavItem peek mode", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockNavigate.mockReset();
    mockSetSelectedCompanyId.mockReset();
  });

  afterEach(() => {
    container.remove();
  });

  it("navigates to the peeked company's own prefix, not the current page's (code review, 2026-09-02)", () => {
    // Regression: setSelectedCompanyId(peekCompanyId, ...) only queues a
    // state update — it does not retroactively change what prefix the
    // navigate() call on the very next line resolves against. Before this
    // fix, clicking a hover-flyout item silently navigated within the
    // CURRENT company (here "IND") instead of switching to the peeked one
    // ("PER"). The resulting URL was a normal, valid, single-prefixed page,
    // so it didn't look broken — this bug coexisted with, and was not caught
    // by, the B01 double-prefix fix or Barry's live confirmation of it.
    const root = createRoot(container);
    act(() => {
      root.render(
        <SidebarPeekProvider peekCompanyId="peeked-id">
          <SidebarNavItem to="/clippy" label="Clippy" icon={MessageSquare} />
        </SidebarPeekProvider>,
      );
    });

    const link = container.querySelector("a");
    expect(link).not.toBeNull();

    act(() => {
      link!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(mockSetSelectedCompanyId).toHaveBeenCalledWith("peeked-id", { source: "shortcut" });
    // The critical assertion: navigate must receive the PEEKED company's
    // prefix (PER), never the current page's (IND) and never the bare,
    // unprefixed "to" (which our navigate wrapper would resolve against
    // whatever company the CURRENT page happens to be on).
    expect(mockNavigate).toHaveBeenCalledWith("/PER/clippy");

    act(() => {
      root.unmount();
    });
  });

  it("falls back to the bare path if the peeked company can't be found in the companies list", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <SidebarPeekProvider peekCompanyId="unknown-id">
          <SidebarNavItem to="/clippy" label="Clippy" icon={MessageSquare} />
        </SidebarPeekProvider>,
      );
    });

    act(() => {
      container.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(mockNavigate).toHaveBeenCalledWith("/clippy");

    act(() => {
      root.unmount();
    });
  });
});
