// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PluginConnectorStatus } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarConnectorStatus } from "./CalendarConnectorStatus";

const navigate = vi.fn();

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigate,
}));

vi.mock("@/api/plugins", () => ({
  pluginsApi: {
    listConnectors: vi.fn(async () => connectorsFixture),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let connectorsFixture: PluginConnectorStatus[];

function createConnector(overrides: Partial<PluginConnectorStatus> = {}): PluginConnectorStatus {
  return {
    pluginId: "plugin-1",
    pluginKey: "paperclip.google-workspace",
    pluginDisplayName: "Google Workspace",
    connectorId: "google-calendar",
    displayName: "Google Calendar",
    surface: "calendar",
    pluginEnabled: true,
    unfinishedAccounts: [],
    companies: [
      {
        companyId: "company-a",
        companyName: "Industry Bureau LLC",
        connected: true,
        accountLabel: "books@ib.com",
        viaPortfolioWide: false,
      },
      {
        companyId: "company-b",
        companyName: "Print Shop",
        connected: false,
        accountLabel: null,
        viaPortfolioWide: false,
      },
    ],
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(companyId?: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <CalendarConnectorStatus companyId={companyId} />
      </QueryClientProvider>,
    );
  });

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (document.querySelector("button")) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function clickChip() {
  const chip = document.querySelector("button");
  act(() => {
    chip?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("CalendarConnectorStatus", () => {
  beforeEach(() => {
    navigate.mockClear();
    connectorsFixture = [createConnector()];
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // An instance with no calendar connector plugin should not be told about a
  // feature it does not have.
  it("renders nothing when no plugin offers a calendar connector", async () => {
    connectorsFixture = [];
    await render();

    expect(container.querySelector("button")).toBeNull();
  });

  it("counts connected companies on the portfolio calendar", async () => {
    await render();

    expect(document.body.textContent).toContain("Google Calendar: 1 of 2 connected");
  });

  it("judges only the company being looked at on a company calendar", async () => {
    await render("company-a");
    expect(document.body.textContent).toContain("Google Calendar connected");

    await act(async () => root.unmount());
    root = createRoot(container);
    await render("company-b");
    expect(document.body.textContent).toContain("Google Calendar not connected");
  });

  it("lists every company with its standing when opened", async () => {
    await render();
    clickChip();

    const text = document.body.textContent ?? "";
    expect(text).toContain("Industry Bureau LLC");
    expect(text).toContain("books@ib.com");
    expect(text).toContain("Print Shop");
    expect(text).toContain("Not connected");
  });

  it("sends the operator to the plugin that owns the connector", async () => {
    await render();
    clickChip();

    const connectButton = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Manage"),
    );
    act(() => {
      connectButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(navigate).toHaveBeenCalledWith("/instance/settings/plugins/plugin-1");
  });

  it("says so when the plugin is installed but switched off", async () => {
    connectorsFixture = [createConnector({ pluginEnabled: false })];
    await render();
    clickChip();

    expect(document.body.textContent).toContain("switched off");
  });

  it("calls out accounts that are missing their credentials", async () => {
    connectorsFixture = [createConnector({ unfinishedAccounts: ["books@ib.com"] })];
    await render();
    clickChip();

    expect(document.body.textContent).toContain("Half-finished account");
  });
});
