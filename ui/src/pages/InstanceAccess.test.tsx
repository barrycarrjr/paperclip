// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../context/ToastContext";
import { ToastViewport } from "../components/ToastViewport";
import { InstanceAccess } from "./InstanceAccess";

const mockAccessApi = vi.hoisted(() => ({
  searchAdminUsers: vi.fn(),
  getUserCompanyAccess: vi.fn(),
  setUserCompanyAccess: vi.fn(),
  promoteInstanceAdmin: vi.fn(),
  demoteInstanceAdmin: vi.fn(),
}));

vi.mock("@/api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", name: "Paperclip", issuePrefix: "PAP" }],
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

const USER = {
  id: "user-1",
  name: "Sam",
  email: "sam@example.com",
  isInstanceAdmin: false,
  activeCompanyMembershipCount: 1,
};

const KIM = {
  id: "user-2",
  name: "Kim",
  email: "kim@example.com",
  isInstanceAdmin: false,
  activeCompanyMembershipCount: 1,
};

/**
 * Both saves on this page said when they worked and nothing at all when they
 * failed, so a refused change looked like a click that did nothing.
 */
describe("InstanceAccess, saving access", () => {
  let container: HTMLDivElement;
  let root: Root;
  // Kept while the page is left and come back to, as the app's is.
  let queryClient: QueryClient | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = null;
    mockAccessApi.searchAdminUsers.mockResolvedValue([USER]);
    mockAccessApi.getUserCompanyAccess.mockResolvedValue({
      companyAccess: [
        {
          id: "membership-1",
          companyId: "company-1",
          companyName: "Paperclip",
          membershipRole: "operator",
          status: "active",
          updatedAt: "2026-10-01T00:00:00Z",
        },
      ],
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  /** Draws the page, or with onPage false everything but it, as leaving the page does. */
  async function draw(onPage: boolean) {
    const client = (queryClient ??= new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    }));
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ToastProvider>
            {onPage ? <InstanceAccess /> : null}
            <ToastViewport />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
  }

  async function render() {
    await draw(true);
    await flushReact();
    await flushReact();
    await vi.waitFor(() => expect(container.textContent).toContain("Save company access"));
  }

  /** The message viewport's live region, taken before the save. */
  function liveRegion() {
    const region = container.querySelector('aside[aria-live="polite"]');
    expect(region, "the live region is on the page before the save").not.toBeNull();
    return region as HTMLElement;
  }

  async function clickButton(text: string) {
    const button = Array.from(container.querySelectorAll("button"))
      .find((candidate) => candidate.textContent?.trim() === text);
    expect(button, `no button reading "${text}"`).not.toBeUndefined();
    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
  }

  it("says why company access could not be saved", async () => {
    mockAccessApi.setUserCompanyAccess.mockRejectedValueOnce(new Error("Sam must keep access to one company."));
    await render();
    const region = liveRegion();

    await clickButton("Save company access");

    expect(mockAccessApi.setUserCompanyAccess).toHaveBeenCalledWith("user-1", ["company-1"]);
    await vi.waitFor(() => expect(region.textContent).toContain("Could not save company access"));
    expect(region.textContent).toContain("Sam must keep access to one company.");
    expect(region.textContent).not.toContain("Company access updated");
  });

  it("keeps one user's failure, naming them, when another user's access then saves", async () => {
    mockAccessApi.searchAdminUsers.mockResolvedValue([USER, KIM]);
    mockAccessApi.setUserCompanyAccess
      .mockRejectedValueOnce(new Error("Sam must keep access to one company."))
      .mockResolvedValueOnce({});
    await render();
    const region = liveRegion();

    await clickButton("Save company access");
    await vi.waitFor(() => expect(region.textContent).toContain("Could not save company access for Sam"));

    // Kim is picked and saved, and that works.
    const kimRow = Array.from(container.querySelectorAll("button"))
      .find((candidate) => candidate.textContent?.includes("kim@example.com"));
    await act(async () => {
      kimRow!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Save company access"));
    await clickButton("Save company access");
    await vi.waitFor(() => expect(region.textContent).toContain("Company access updated"));

    expect(mockAccessApi.setUserCompanyAccess).toHaveBeenLastCalledWith("user-2", ["company-1"]);
    // Saving Kim used to take back Sam's failure, so Sam looked saved.
    expect(region.textContent).toContain("Could not save company access for Sam");
    expect(region.textContent).toContain("Sam must keep access to one company.");
  });

  it("says why the instance role could not be changed", async () => {
    mockAccessApi.promoteInstanceAdmin.mockRejectedValueOnce(new Error("Only an instance admin can do that."));
    await render();
    const region = liveRegion();

    await clickButton("Promote to instance admin");

    expect(mockAccessApi.promoteInstanceAdmin).toHaveBeenCalledWith("user-1");
    await vi.waitFor(() => expect(region.textContent).toContain("Could not change the instance role for Sam"));
    expect(region.textContent).toContain("Only an instance admin can do that.");
    expect(region.textContent).not.toContain("Instance role updated");
  });

  it("keeps one user's role failure when another user's role then changes", async () => {
    mockAccessApi.searchAdminUsers.mockResolvedValue([USER, KIM]);
    mockAccessApi.promoteInstanceAdmin
      .mockRejectedValueOnce(new Error("Only an instance admin can do that."))
      .mockResolvedValueOnce({});
    await render();
    const region = liveRegion();

    await clickButton("Promote to instance admin");
    await vi.waitFor(() => expect(region.textContent).toContain("Could not change the instance role for Sam"));

    const kimRow = Array.from(container.querySelectorAll("button"))
      .find((candidate) => candidate.textContent?.includes("kim@example.com"));
    await act(async () => {
      kimRow!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Promote to instance admin"));
    await clickButton("Promote to instance admin");
    await vi.waitFor(() => expect(region.textContent).toContain("Instance role updated"));

    expect(mockAccessApi.promoteInstanceAdmin).toHaveBeenLastCalledWith("user-2");
    expect(region.textContent).toContain("Could not change the instance role for Sam");
  });

  it("takes back a user's failure said before the page was left once that user's access saves", async () => {
    mockAccessApi.setUserCompanyAccess
      .mockRejectedValueOnce(new Error("Sam must keep access to one company."))
      .mockResolvedValueOnce({});
    await render();
    const region = liveRegion();

    await clickButton("Save company access");
    await vi.waitFor(() => expect(region.textContent).toContain("Could not save company access for Sam"));

    // Off to another page and back, and Sam's access is saved again.
    await draw(false);
    await render();
    await clickButton("Save company access");
    await vi.waitFor(() => expect(region.textContent).toContain("Company access updated"));

    expect(mockAccessApi.setUserCompanyAccess).toHaveBeenLastCalledWith("user-1", ["company-1"]);
    // It used to stay up beside "Company access updated", as if Sam's access
    // had not saved.
    expect(region.textContent).not.toContain("Could not save company access for Sam");
  });
});
