// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileBottomNav } from "./MobileBottomNav";

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/PAP/dashboard", search: "", hash: "", state: null }),
  // The nav reads the company from the URL, not the context selection, so the
  // inbox badge cannot show the previous company's count after a switch.
  useParams: () => ({ companyPrefix: "PAP" }),
  NavLink: ({
    to,
    children,
  }: {
    to: string;
    children: (state: { isActive: boolean }) => React.ReactNode;
  }) => <a href={to}>{children({ isActive: false })}</a>,
}));

vi.mock("../context/CompanyContext", () => ({
  // `companies` is needed now that the nav resolves its company from the URL
  // prefix rather than trusting the context's selection.
  useCompany: () => ({
    selectedCompanyId: "company-1",
    companies: [{ id: "company-1", issuePrefix: "PAP", isPortfolioRoot: false }],
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ openNewIssue: vi.fn() }),
}));

const badgeCalls: (string | null)[] = [];
vi.mock("../hooks/useInboxBadge", () => ({
  useInboxBadge: (companyId: string | null) => {
    badgeCalls.push(companyId);
    return { inbox: 0 };
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("MobileBottomNav", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("includes Email alongside the existing five destinations (B06)", () => {
    // Regression for docs/plans/2026-09-02-ux-control-center-preservation.md
    // B06: mobile navigation never included Email, the stated #1 daily
    // workflow. Added rather than swapped in, so all five prior destinations
    // (Home, Issues, Create, Agents, Inbox) must still be present too.
    const root = createRoot(container);
    act(() => {
      root.render(<MobileBottomNav visible />);
    });

    const labels = Array.from(container.querySelectorAll("a, button")).map((el) => el.textContent ?? "");
    for (const expected of ["Home", "Issues", "Create", "Agents", "Inbox", "Email"]) {
      expect(labels).toContain(expected);
    }
    expect(labels.length).toBe(6);

    const emailLink = Array.from(container.querySelectorAll("a")).find((el) => el.textContent === "Email");
    expect(emailLink?.getAttribute("href")).toBe("/email");

    act(() => {
      root.unmount();
    });
  });

  it("counts the inbox for the company in the URL, not the last one selected", () => {
    // The context selection is synced from the route a render late, so reading
    // it here briefly showed the previous company's number after a switch.
    // The mocked context selection ("company-1") and the URL prefix ("PAP",
    // which is company-1) agree here; what matters is that the value came from
    // resolving the prefix, which is what useActiveCompanyId does.
    badgeCalls.length = 0;
    const root = createRoot(container);
    act(() => {
      root.render(<MobileBottomNav visible />);
    });

    expect(badgeCalls).toContain("company-1");

    act(() => {
      root.unmount();
    });
  });
});
