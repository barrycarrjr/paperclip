// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../context/ToastContext";
import { ToastViewport } from "../components/ToastViewport";
import { InstanceGeneralSettings } from "./InstanceGeneralSettings";

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getGeneral: vi.fn(),
  updateGeneral: vi.fn(),
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("@/api/health", () => ({
  healthApi: { get: vi.fn().mockResolvedValue({ deploymentMode: "local_trusted" }) },
}));

vi.mock("@/api/auth", () => ({
  authApi: { signOut: vi.fn() },
}));

vi.mock("@/api/system", () => ({
  systemApi: { restart: vi.fn(), shutdown: vi.fn() },
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const SETTINGS = {
  censorUsernameInLogs: false,
  keyboardShortcuts: true,
  backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
  outboundToolDraftMode: true,
  emailHandoffReplyApproval: "inherit",
  selfNotify: { skipApproval: true, slackUserIds: [], emails: [], phoneNumbers: [] },
};

/**
 * The address form keeps showing what was typed after a save, so it has to
 * say the save worked. The toggles on the same page show their own new state
 * and save through the same request, so they must not add a message.
 */
describe("InstanceGeneralSettings, saying a save worked", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockInstanceSettingsApi.getGeneral.mockResolvedValue(SETTINGS);
    mockInstanceSettingsApi.updateGeneral.mockImplementation(async (patch: object) => ({ ...SETTINGS, ...patch }));
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <InstanceGeneralSettings />
            <ToastViewport />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
  }

  /**
   * The live region, taken before the save. It has to be on the page already:
   * a screen reader often misses a region that appears together with its
   * first message.
   */
  function liveRegion() {
    const region = container.querySelector('aside[aria-live="polite"]');
    expect(region, "the live region is on the page before the save").not.toBeNull();
    return region as HTMLElement;
  }

  function messages() {
    return container.querySelectorAll('[data-testid="toast-stack"] > li');
  }

  async function saveEmail(value: string) {
    await act(async () => {
      setInputValue(container.querySelector("#self-emails") as HTMLInputElement, value);
    });
    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Save my addresses",
    );
    await act(async () => {
      saveButton!.click();
    });
    await flushReact();
    await flushReact();
  }

  it("says the addresses were saved once they are", async () => {
    await render();
    const region = liveRegion();

    await saveEmail("pat@example.com");

    expect(mockInstanceSettingsApi.updateGeneral.mock.calls[0]?.[0]).toEqual({
      selfNotify: { skipApproval: true, slackUserIds: [], emails: ["pat@example.com"], phoneNumbers: [] },
    });
    expect(region.textContent).toContain("Your addresses saved");
  });

  it("does not say they were saved when the save fails, and shows why", async () => {
    mockInstanceSettingsApi.updateGeneral.mockRejectedValueOnce(new Error("Not a valid email address."));
    await render();
    const region = liveRegion();

    await saveEmail("pat@");

    expect(container.textContent).toContain("Not a valid email address.");
    expect(region.textContent).not.toContain("Your addresses saved");
  });

  it("takes back the saved message when the next try fails", async () => {
    await render();
    const region = liveRegion();

    await saveEmail("pat@example.com");
    expect(region.textContent).toContain("Your addresses saved");

    mockInstanceSettingsApi.updateGeneral.mockRejectedValueOnce(new Error("Not a valid email address."));
    await saveEmail("pat@");

    expect(container.textContent).toContain("Not a valid email address.");
    expect(region.textContent).not.toContain("Your addresses saved");
  });

  it("adds no message to a toggle, which shows its own new state", async () => {
    await render();

    await act(async () => {
      (container.querySelector('[aria-label="Toggle username log censoring"]') as HTMLButtonElement).click();
    });
    await flushReact();
    await flushReact();

    expect(mockInstanceSettingsApi.updateGeneral.mock.calls[0]?.[0]).toEqual({ censorUsernameInLogs: true });
    expect(messages()).toHaveLength(0);
  });
});
