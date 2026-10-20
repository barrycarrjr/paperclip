// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";

const routeParams: { value: Record<string, string | undefined> } = { value: {} };
const navigateSpy = vi.fn();

vi.mock("@/lib/router", () => ({
  useParams: () => routeParams.value,
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  Navigate: ({ to }: { to: string }) => {
    navigateSpy(to);
    return <div data-testid="navigate" data-to={to} />;
  },
}));

const companies = [
  { id: "company-1", issuePrefix: "ACME", isPortfolioRoot: false },
  { id: "hq", issuePrefix: "HQ", isPortfolioRoot: true },
];
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ companies }),
}));

const activeCompanyId: { value: string | null } = { value: "company-1" };
vi.mock("@/hooks/useRouteCompany", () => ({
  useActiveCompanyId: () => activeCompanyId.value,
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

const contributions: { value: unknown[] } = { value: [] };
const listContributions = vi.fn(async (_companyId?: string | null): Promise<unknown[]> => contributions.value);
vi.mock("@/api/plugins", () => ({
  pluginsApi: { listUiContributions: (companyId?: string | null) => listContributions(companyId) },
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotMount: () => <div data-testid="slot-mount">plugin page</div>,
}));

vi.mock("./NotFound", () => ({
  NotFoundPage: () => <div data-testid="not-found">Not found</div>,
}));

const { PluginPage } = await import("./PluginPage");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("PluginPage", () => {
  let container: HTMLDivElement;

  async function render() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PluginPage />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    return root;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    routeParams.value = { companyPrefix: "ACME", pluginId: "plugin-1" };
    activeCompanyId.value = "company-1";
    navigateSpy.mockClear();
    contributions.value = [];
    listContributions.mockClear();
    listContributions.mockImplementation(async () => contributions.value);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders the plugin's page when it has one", async () => {
    contributions.value = [
      {
        pluginId: "plugin-1",
        pluginKey: "notepad",
        displayName: "Notepad",
        version: "1.0.0",
        slots: [{ type: "page", id: "page-1" }],
      },
    ];

    await render();
    expect(container.querySelector('[data-testid="slot-mount"]')).toBeTruthy();
  });

  it("says a plugin has no page instead of quietly opening its settings", async () => {
    // Landing on settings looked like the plugin's page, rather than telling
    // you the plugin has none.
    contributions.value = [
      {
        pluginId: "plugin-1",
        pluginKey: "toolsonly",
        displayName: "Tools Only",
        version: "1.0.0",
        slots: [{ type: "toolbar", id: "tb-1" }],
      },
    ];

    await render();

    expect(navigateSpy).not.toHaveBeenCalled();
    expect(container.textContent).toContain("not available here");
    expect(container.textContent).toContain("no page available for this company");
  });

  it("still offers the plugin's settings as a choice", async () => {
    contributions.value = [
      {
        pluginId: "plugin-1",
        pluginKey: "toolsonly",
        displayName: "Tools Only",
        version: "1.0.0",
        slots: [],
      },
    ];

    await render();

    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/instance/settings/plugins/plugin-1");
  });

  it("uses the company in the URL, not a lagging selection", async () => {
    // The context's selected company updates a render late on a switch, so a
    // page reached by URL must read the URL.
    routeParams.value = { pluginId: "plugin-1" };
    activeCompanyId.value = "hq";
    contributions.value = [
      {
        pluginId: "plugin-1",
        pluginKey: "notepad",
        displayName: "Notepad",
        version: "1.0.0",
        slots: [{ type: "page", id: "page-1" }],
      },
    ];

    await render();
    expect(container.querySelector('[data-testid="slot-mount"]')).toBeTruthy();
  });

  it("shows not-found for an unknown company prefix", async () => {
    routeParams.value = { companyPrefix: "NOPE", pluginId: "plugin-1" };
    await render();
    expect(container.querySelector('[data-testid="not-found"]')).toBeTruthy();
  });

  it("does not reuse the previous company's or global page while the new company is loading or denied", async () => {
    const page = { pluginId: "plugin-1", pluginKey: "example", displayName: "Example", version: "1.0.0", slots: [{ type: "page", id: "page" }] };
    let answerHq!: (rows: unknown[]) => void;
    const pendingHq = new Promise<unknown[]>((resolve) => { answerHq = resolve; });
    listContributions.mockImplementation(async (companyId) => companyId === "hq" ? pendingHq : [page]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(queryKeys.plugins.uiContributions, [page]);
    const root = createRoot(container);
    const show = async () => {
      await act(async () => root.render(<QueryClientProvider client={client}><PluginPage /></QueryClientProvider>));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    };
    await show();
    expect(container.querySelector('[data-testid="slot-mount"]')).toBeTruthy();
    expect(listContributions).toHaveBeenCalledWith("company-1");

    routeParams.value = { companyPrefix: "HQ", pluginId: "plugin-1" };
    activeCompanyId.value = "hq";
    await show();
    expect(container.querySelector('[data-testid="slot-mount"]')).toBeNull();
    expect(container.textContent).toContain("Loading");
    await act(async () => { answerHq([]); });
    await show();
    expect(container.querySelector('[data-testid="slot-mount"]')).toBeNull();
    expect(container.textContent).toContain("not available here");
    expect(listContributions).toHaveBeenCalledWith("hq");
    act(() => root.unmount());
    client.clear();
  });

  it("shows contribution failures instead of remaining on loading", async () => {
    listContributions.mockRejectedValueOnce(new Error("Discovery failed"));
    const root = await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Discovery failed");
    act(() => root.unmount());
  });
});
