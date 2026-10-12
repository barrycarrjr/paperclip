// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceSidebar } from "./InstanceSidebar";

const sidebarNavItemMock = vi.hoisted(() => vi.fn());
const mockAccessApi = vi.hoisted(() => ({
  getCurrentBoardAccess: vi.fn(),
  listAccountRequests: vi.fn(),
}));
const mockHealthApi = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("../api/access", () => ({ accessApi: mockAccessApi }));
vi.mock("../api/health", () => ({ healthApi: mockHealthApi }));
vi.mock("./SidebarNavItem", () => ({
  SidebarNavItem: (props: { to: string; label: string; badge?: number }) => {
    sidebarNavItemMock(props);
    return <div>{props.label}</div>;
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const WAITING = [
  { id: "user-pat", name: "Pat", email: "pat@example.com", requestedAt: "2026-10-11T15:00:00.000Z" },
  { id: "user-sam", name: "Sam", email: "sam@example.com", requestedAt: "2026-10-11T16:00:00.000Z" },
];

/** The badge the latest drawing of the Access item was given. */
function accessBadge() {
  const calls = sidebarNavItemMock.mock.calls.filter(([props]) => props.to === "/instance/settings/access");
  return calls.at(-1)?.[0].badge;
}

describe("InstanceSidebar, new accounts waiting for approval", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockHealthApi.get.mockResolvedValue({ status: "ok", deploymentMode: "authenticated" });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({ userId: "admin", isInstanceAdmin: true, companyIds: [] });
    mockAccessApi.listAccountRequests.mockResolvedValue(WAITING);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <InstanceSidebar />
        </QueryClientProvider>,
      );
    });
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }

  it("counts them on Access for an instance admin, as company settings counts people asking to join", async () => {
    await render();

    expect(accessBadge()).toBe(2);
  });

  it("asks for nothing and counts nothing for someone who is not an instance admin", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({ userId: "member", isInstanceAdmin: false, companyIds: ["c1"] });
    await render();

    expect(accessBadge()).toBe(0);
    expect(mockAccessApi.listAccountRequests).not.toHaveBeenCalled();
  });

  it("asks for nothing on a local_trusted install, where nobody signs up", async () => {
    mockHealthApi.get.mockResolvedValue({ status: "ok", deploymentMode: "local_trusted" });
    await render();

    expect(accessBadge()).toBe(0);
    expect(mockAccessApi.getCurrentBoardAccess).not.toHaveBeenCalled();
    expect(mockAccessApi.listAccountRequests).not.toHaveBeenCalled();
  });
});
