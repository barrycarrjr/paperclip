// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileBottomNav } from "./MobileBottomNav";

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/PAP/dashboard", search: "", hash: "", state: null }),
  NavLink: ({
    to,
    children,
  }: {
    to: string;
    children: (state: { isActive: boolean }) => React.ReactNode;
  }) => <a href={to}>{children({ isActive: false })}</a>,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ openNewIssue: vi.fn() }),
}));

vi.mock("../hooks/useInboxBadge", () => ({
  useInboxBadge: () => ({ inbox: 0 }),
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
});
