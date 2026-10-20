// @vitest-environment jsdom

import { act } from "react";
import * as React from "react";
import * as ReactDom from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pluginsApi, type PluginUiContribution } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import { resolvePinnedWorkspaceItems } from "@/lib/workspace-catalog";
import { usePluginSlots, _resetPluginModuleLoader, registerPluginReactComponent } from "./slots";
import { usePluginLaunchers } from "./launchers";

vi.mock("@/api/auth", () => ({ authApi: { getSession: async () => null } }));
vi.mock("@/lib/router", () => ({ useNavigate: () => vi.fn(), useLocation: () => ({ pathname: "/" }) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const contribution: PluginUiContribution = {
  pluginId: "example",
  pluginKey: "example",
  displayName: "Example",
  version: "1.0.0",
  updatedAt: "2026-10-18T00:00:00Z",
  uiEntryFile: "index.js",
  slots: [{ id: "page", type: "page", displayName: "Example page", exportName: "Page", routePath: "example" }],
  launchers: [{ id: "open", displayName: "Open example", placementZone: "sidebar", action: { type: "navigate", target: "example" } }],
};

function Discovery({ companyId }: { companyId?: string | null }) {
  const pages = usePluginSlots({ slotTypes: ["page"], companyId });
  const launchers = usePluginLaunchers({ placementZones: ["sidebar"], companyId });
  const pinned = resolvePinnedWorkspaceItems({
    pinned: ["example"],
    isPortfolioRoot: false,
    pluginSlots: pages.slots.map((slot) => ({ routePath: slot.routePath ?? null, displayName: slot.displayName })),
  });
  return <>
    <nav aria-label="pages">{pages.slots.map((slot) => <a key={slot.id} href={`/${companyId}/${slot.routePath}`}>{slot.displayName}</a>)}</nav>
    <nav aria-label="pinned">{pinned.map((item) => <span key={item.id}>{item.label}</span>)}</nav>
    <nav aria-label="launchers">{launchers.launchers.map((launcher) => <span key={launcher.id}>{launcher.displayName}</span>)}</nav>
    {pages.errorMessage && <p role="alert">{pages.errorMessage}</p>}
    {launchers.errorMessage && <p role="alert">{launchers.errorMessage}</p>}
  </>;
}

describe("company discovery client and cache", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let client: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    _resetPluginModuleLoader();
    globalThis.__paperclipPluginBridge__ = { react: React, reactDom: ReactDom, sdkUi: {} };
    class SourceBlob {
      readonly source: string;
      constructor(parts: string[]) { this.source = parts.join(""); }
    }
    vi.stubGlobal("Blob", SourceBlob);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: (blob: SourceBlob) => `data:text/javascript;base64,${Buffer.from(blob.source).toString("base64")}`,
      revokeObjectURL: () => {},
    });
    registerPluginReactComponent("example", "Page", () => null);
  });

  afterEach(() => {
    act(() => root.unmount());
    client.clear();
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    _resetPluginModuleLoader();
    delete globalThis.__paperclipPluginBridge__;
  });

  async function render(companyId?: string | null) {
    await act(async () => root.render(<QueryClientProvider client={client}><Discovery companyId={companyId} /></QueryClientProvider>));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }

  it("uses company requests and never carries pages, pins or launchers across a pending company switch", async () => {
    let answerDenied!: (value: Response) => void;
    const deniedResponse = new Promise<Response>((resolve) => { answerDenied = resolve; });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("companyId=denied")) return deniedResponse;
      if (url.startsWith("/_plugins/")) return new Response("export const Page = () => null;");
      return Response.json([contribution]);
    });
    vi.stubGlobal("fetch", fetchMock);
    // Instance-wide cached discovery cannot satisfy a company-specific query.
    client.setQueryData(queryKeys.plugins.uiContributions, [contribution]);
    await render("allowed");
    expect(container.querySelector('[aria-label="pages"]')?.textContent).toBe("Example page");
    expect(container.querySelector('[aria-label="pinned"]')?.textContent).toBe("Example page");
    expect(container.querySelector('[aria-label="launchers"]')?.textContent).toBe("Open example");
    expect(fetchMock).toHaveBeenCalledWith("/api/plugins/ui-contributions?companyId=allowed", expect.anything());

    await render("denied");
    expect(container.querySelectorAll("nav").length).toBe(3);
    for (const nav of container.querySelectorAll("nav")) expect(nav.textContent).toBe("");
    await act(async () => { answerDenied(Response.json([])); });
    await render("denied");
    for (const nav of container.querySelectorAll("nav")) expect(nav.textContent).toBe("");
    expect(client.getQueryData(queryKeys.plugins.companyUiContributions("allowed"))).toEqual([contribution]);
    expect(client.getQueryData(queryKeys.plugins.companyUiContributions("denied"))).toEqual([]);

    await render("allowed");
    expect(container.textContent).toContain("Example page");
    await render(null);
    for (const nav of container.querySelectorAll("nav")) expect(nav.textContent).toBe("");
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/plugins/ui-contributions")).toBe(false);
  });

  it("keeps an omitted company global and encodes explicit company ids", async () => {
    const fetchMock = vi.fn(async () => Response.json([]));
    vi.stubGlobal("fetch", fetchMock);
    await render();
    expect(fetchMock).toHaveBeenCalledWith("/api/plugins/ui-contributions", expect.anything());
    await pluginsApi.listUiContributions("company/id & name");
    expect(fetchMock).toHaveBeenCalledWith("/api/plugins/ui-contributions?companyId=company%2Fid%20%26%20name", expect.anything());
    await pluginsApi.listUiContributions("");
    expect(fetchMock).toHaveBeenCalledWith("/api/plugins/ui-contributions?companyId=", expect.anything());
  });

  it("keeps discovery errors visible", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Discovery unavailable" }, { status: 503 })));
    await render("allowed");
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(2);
    expect(container.textContent).toContain("Discovery unavailable");
  });
});
