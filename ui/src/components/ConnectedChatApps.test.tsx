// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectedChatApps } from "./ConnectedChatApps";

const mockChannelLinksApi = vi.hoisted(() => ({
  list: vi.fn(),
  preview: vi.fn(),
  claim: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/api/channelLinks", () => ({
  channelLinksApi: mockChannelLinksApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

const LINK = {
  id: "11111111-1111-4111-8111-111111111111",
  pluginKey: "slack-tools",
  pluginName: "Slack",
  externalWorkspace: "T0001",
  externalUserId: "U0TESTUSR01",
  externalLabel: "Pat",
  createdAt: "2026-10-09T10:00:00.000Z",
  lastUsedAt: null,
};

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonByText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes(text)) as
    | HTMLButtonElement
    | undefined;
}

describe("ConnectedChatApps", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ConnectedChatApps />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("shows what a code would connect before connecting it, then lists the account", async () => {
    mockChannelLinksApi.list.mockResolvedValueOnce([]).mockResolvedValue([LINK]);
    mockChannelLinksApi.preview.mockResolvedValue({
      pluginKey: "slack-tools",
      pluginName: "Slack",
      externalWorkspace: "T0001",
      externalUserId: "U0TESTUSR01",
      externalLabel: "Pat",
      expiresAt: "2026-10-09T10:10:00.000Z",
    });
    mockChannelLinksApi.claim.mockResolvedValue(LINK);
    await render();
    expect(container.textContent).toContain("No chat app accounts connected.");

    const input = container.querySelector("#chat-app-code") as HTMLInputElement;
    await act(async () => {
      setInputValue(input, "abcd-2345");
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flushReact();

    expect(mockChannelLinksApi.preview).toHaveBeenCalledWith("abcd-2345");
    // Nothing is connected until the user confirms what they are connecting.
    expect(mockChannelLinksApi.claim).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Pat (U0TESTUSR01) in workspace T0001");
    expect(container.textContent).toContain("will act as you");

    await act(async () => {
      buttonByText(container, "Connect")!.click();
    });
    await flushReact();
    await flushReact();

    expect(mockChannelLinksApi.claim).toHaveBeenCalledWith("abcd-2345");
    expect(container.textContent).toContain("Slack: Pat (U0TESTUSR01) in workspace T0001");
    // Said where the user is looking, with what to do next.
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Connected Pat (U0TESTUSR01) in workspace T0001. Message the bot again and Clippy will answer as you.",
    );
  });

  it("says why a code was refused", async () => {
    mockChannelLinksApi.list.mockResolvedValue([]);
    mockChannelLinksApi.preview.mockRejectedValue(new Error("That code is not valid or has expired."));
    await render();

    const input = container.querySelector("#chat-app-code") as HTMLInputElement;
    await act(async () => {
      setInputValue(input, "WRNG-CODE");
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("That code is not valid or has expired.");
    expect(mockChannelLinksApi.claim).not.toHaveBeenCalled();
  });

  it("disconnects an account", async () => {
    mockChannelLinksApi.list.mockResolvedValueOnce([LINK]).mockResolvedValue([]);
    mockChannelLinksApi.remove.mockResolvedValue(undefined);
    await render();
    expect(container.textContent).toContain("Slack: Pat");

    await act(async () => {
      buttonByText(container, "Disconnect")!.click();
    });
    await flushReact();
    await flushReact();

    expect(mockChannelLinksApi.remove).toHaveBeenCalledWith(LINK.id);
    expect(container.textContent).toContain("No chat app accounts connected.");
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Disconnected Pat (U0TESTUSR01) in workspace T0001.",
    );
  });
});
