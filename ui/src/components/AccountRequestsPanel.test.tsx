// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../context/ToastContext";
import { ToastViewport } from "./ToastViewport";
import { AccountRequestsPanel } from "./AccountRequestsPanel";

const mockAccessApi = vi.hoisted(() => ({
  listAccountRequests: vi.fn(),
  approveAccountRequest: vi.fn(),
  declineAccountRequest: vi.fn(),
}));
const mockHealthApi = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/api/access", () => ({ accessApi: mockAccessApi }));
vi.mock("@/api/health", () => ({ healthApi: mockHealthApi }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const PAT = { id: "user-pat", name: "Pat Lee", email: "pat@example.com", requestedAt: "2026-10-11T15:04:00.000Z" };
const SAM = { id: "user-sam", name: null, email: "sam@example.com", requestedAt: "2026-10-11T16:30:00.000Z" };

async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

describe("AccountRequestsPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockHealthApi.get.mockResolvedValue({ status: "ok", deploymentMode: "authenticated" });
    mockAccessApi.listAccountRequests.mockResolvedValue([PAT, SAM]);
    mockAccessApi.approveAccountRequest.mockResolvedValue({ id: PAT.id, status: "approved" });
    mockAccessApi.declineAccountRequest.mockResolvedValue({ id: PAT.id, status: "declined" });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ToastProvider>
            <AccountRequestsPanel />
            <ToastViewport />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await settle();
  }

  function rowFor(text: string) {
    return Array.from(container.querySelectorAll("li")).find((row) => row.textContent?.includes(text))!;
  }

  function buttonIn(row: Element, label: string) {
    return Array.from(row.querySelectorAll("button")).find((button) => button.textContent === label)!;
  }

  it("lists each waiting account by name, email and when it asked", async () => {
    await render();

    const text = container.textContent ?? "";
    expect(text).toContain("Waiting for approval");
    expect(text).toContain("2 waiting");
    const pat = rowFor("Pat Lee");
    expect(pat.textContent).toContain("pat@example.com");
    expect(pat.textContent).toContain("Asked Oct 11, 2026");
    // No name given: the email is the name.
    expect(rowFor("sam@example.com").textContent).toContain("Asked");
    // No en or em dash anywhere on the panel.
    const dashes = [0x2013, 0x2014].map((code) => String.fromCharCode(code));
    expect(dashes.some((dash) => text.includes(dash))).toBe(false);
  });

  it("approves the account its button is on", async () => {
    await render();

    await act(async () => buttonIn(rowFor("Pat Lee"), "Approve").click());
    await settle();

    expect(mockAccessApi.approveAccountRequest).toHaveBeenCalledWith(PAT.id);
    expect(mockAccessApi.declineAccountRequest).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Pat Lee can use Paperclip now.");
    // Asked again, so the approved account leaves the list.
    expect(mockAccessApi.listAccountRequests.mock.calls.length).toBeGreaterThan(1);
  });

  it("declines only once the admin confirms, because there is no undo", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    await render();

    await act(async () => buttonIn(rowFor("Pat Lee"), "Decline").click());
    expect(confirm).toHaveBeenCalledWith("Decline Pat Lee? They will not be able to sign in.");
    expect(mockAccessApi.declineAccountRequest).not.toHaveBeenCalled();

    await act(async () => buttonIn(rowFor("Pat Lee"), "Decline").click());
    await settle();

    expect(mockAccessApi.declineAccountRequest).toHaveBeenCalledWith(PAT.id);
    expect(document.body.textContent).toContain("Pat Lee was declined.");
  });

  it("says when a decision did not go through", async () => {
    mockAccessApi.approveAccountRequest.mockRejectedValue(new Error("This account was declined. It cannot be approved."));
    await render();

    await act(async () => buttonIn(rowFor("Pat Lee"), "Approve").click());
    await settle();

    expect(document.body.textContent).toContain("Could not approve Pat Lee");
    expect(document.body.textContent).toContain("This account was declined. It cannot be approved.");
  });

  it("says plainly when nobody is waiting", async () => {
    mockAccessApi.listAccountRequests.mockResolvedValue([]);
    await render();

    expect(container.textContent).toContain("No new accounts are waiting.");
  });

  it("shows nothing on a local_trusted install with nothing waiting, where nobody signs up", async () => {
    mockHealthApi.get.mockResolvedValue({ status: "ok", deploymentMode: "local_trusted" });
    mockAccessApi.listAccountRequests.mockResolvedValue([]);
    await render();

    expect(container.querySelector('[data-testid="account-requests"]')).toBeNull();
  });
});
