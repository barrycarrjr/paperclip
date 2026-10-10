// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../context/ToastContext";
import { ToastViewport } from "../components/ToastViewport";
import { Companies } from "./Companies";

const mockCompaniesApi = vi.hoisted(() => ({
  stats: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

// Switching company reloads the page in the app.
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());

vi.mock("../api/companies", () => ({
  companiesApi: mockCompaniesApi,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [
      {
        id: "company-1",
        name: "Paperclip",
        status: "active",
        description: null,
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ],
    selectedCompanyId: "company-1",
    setSelectedCompanyId: mockSetSelectedCompanyId,
    loading: false,
    error: null,
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ openOnboarding: vi.fn() }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

// The card's menu, opened: each item is a plain button.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => null,
  DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

/**
 * A rename or a delete that works shows itself: the new name, or the company
 * gone from the list. One that fails has to say so, where it used to leave the
 * editor or the confirmation open with nothing said.
 */
describe("Companies, renaming and deleting", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockCompaniesApi.stats.mockResolvedValue({});
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <Companies />
            <ToastViewport />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  /** The message viewport's live region, taken before the change. */
  function liveRegion() {
    const region = container.querySelector('aside[aria-live="polite"]');
    expect(region, "the live region is on the page before the change").not.toBeNull();
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

  /** Opens the rename box and types a new name into it. */
  async function typeNewName(name: string) {
    await clickButton("Rename");
    const input = container.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, name);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return input;
  }

  /** Presses a key on the element, and says whether anything stopped what the key does. */
  async function pressKey(element: Element, key: string) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    await act(async () => {
      element.dispatchEvent(event);
    });
    return { prevented: event.defaultPrevented };
  }

  it("says why a rename failed, and leaves the new name in the editor", async () => {
    mockCompaniesApi.update.mockRejectedValueOnce(new Error("Another company already has that name."));
    await render();
    const region = liveRegion();

    const input = await typeNewName("Paperclip Labs");
    await pressKey(input, "Enter");
    await flushReact();

    expect(mockCompaniesApi.update).toHaveBeenCalledWith("company-1", { name: "Paperclip Labs" });
    await vi.waitFor(() => expect(region.textContent).toContain("Could not rename the company"));
    expect(region.textContent).toContain("Another company already has that name.");
    expect(container.querySelector<HTMLInputElement>("input")?.value).toBe("Paperclip Labs");
  });

  it("only renames on Enter in the rename box, without switching into the company", async () => {
    mockCompaniesApi.update.mockRejectedValueOnce(new Error("Another company already has that name."));
    await render();

    const input = await typeNewName("Paperclip Labs");
    // A space is typed into the name, not taken by the card behind it.
    expect((await pressKey(input, " ")).prevented).toBe(false);
    await pressKey(input, "Enter");
    await flushReact();

    expect(mockCompaniesApi.update).toHaveBeenCalledTimes(1);
    // Switching would reload the page and lose the name typed, which matters
    // most when the rename fails.
    expect(mockSetSelectedCompanyId).not.toHaveBeenCalled();
  });

  it("still switches into the company when Enter is pressed on the card itself", async () => {
    await render();
    const card = container.querySelector('[role="button"]')!;

    await pressKey(card, "Enter");

    expect(mockSetSelectedCompanyId).toHaveBeenCalledWith("company-1");
  });

  it("says why a delete failed", async () => {
    mockCompaniesApi.remove.mockRejectedValueOnce(new Error("Stop the running agents first."));
    await render();
    const region = liveRegion();

    await clickButton("Delete Company");
    await clickButton("Delete");

    expect(mockCompaniesApi.remove).toHaveBeenCalledWith("company-1");
    await vi.waitFor(() => expect(region.textContent).toContain("Could not delete the company"));
    expect(region.textContent).toContain("Stop the running agents first.");
    // Nothing was deleted, so the company and its confirmation are still there.
    expect(container.textContent).toContain("Delete this company and all its data?");
  });
});
