// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../context/ToastContext";
import { ToastViewport } from "../components/ToastViewport";
import { InstanceExperimentalSettings } from "./InstanceExperimentalSettings";

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
  updateExperimental: vi.fn(),
  previewIssueGraphLivenessAutoRecovery: vi.fn(),
  runIssueGraphLivenessAutoRecovery: vi.fn(),
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
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
  enableEnvironments: false,
  enableIsolatedWorkspaces: false,
  autoRestartDevServerWhenIdle: false,
  enableIssueGraphLivenessAutoRecovery: true,
  issueGraphLivenessAutoRecoveryLookbackHours: 24,
};

function runResult(escalationsCreated: number) {
  return {
    findings: escalationsCreated,
    autoRecoveryEnabled: true,
    lookbackHours: 24,
    cutoff: "2026-10-08T00:00:00.000Z",
    escalationsCreated,
    existingEscalations: 0,
    skipped: 0,
    skippedAutoRecoveryDisabled: 0,
    skippedOutsideLookback: 0,
    escalationIssueIds: [],
  };
}

/**
 * The recovery tasks a run creates are not listed on this page, and the hours
 * field looks the same after a save, so both say what they did.
 */
describe("InstanceExperimentalSettings, saying what an action did", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue(SETTINGS);
    mockInstanceSettingsApi.updateExperimental.mockImplementation(async (patch: object) => ({ ...SETTINGS, ...patch }));
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
            <InstanceExperimentalSettings />
            <ToastViewport />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
  }

  function buttonByText(text: string) {
    return Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === text) as
      | HTMLButtonElement
      | undefined;
  }

  async function click(button: HTMLButtonElement) {
    await act(async () => {
      button.click();
    });
    await flushReact();
    await flushReact();
  }

  /** The title of each message on screen, word for word. */
  function messageTitles() {
    return Array.from(container.querySelectorAll('[data-testid="toast-stack"] > li p:first-child')).map(
      (title) => title.textContent,
    );
  }

  it.each([
    [0, "No new recovery tasks created"],
    [1, "Created 1 recovery task"],
    [3, "Created 3 recovery tasks"],
  ])("words the result of a run that created %i", async (created, message) => {
    mockInstanceSettingsApi.runIssueGraphLivenessAutoRecovery.mockResolvedValueOnce(runResult(created));
    await render();

    await click(buttonByText("Run now")!);

    expect(mockInstanceSettingsApi.runIssueGraphLivenessAutoRecovery.mock.calls[0]?.[0]).toEqual({ lookbackHours: 24 });
    expect(messageTitles()).toEqual([message]);
  });

  it("says the lookback hours were saved", async () => {
    await render();

    await act(async () => {
      setInputValue(container.querySelector('input[type="number"]') as HTMLInputElement, "48");
    });
    await click(buttonByText("Save hours")!);

    expect(mockInstanceSettingsApi.updateExperimental.mock.calls[0]?.[0]).toEqual({
      issueGraphLivenessAutoRecoveryLookbackHours: 48,
    });
    expect(messageTitles()).toEqual(["Lookback hours saved"]);
  });
});
