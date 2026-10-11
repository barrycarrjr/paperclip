// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { Activity } from "./Activity";

const listActivityMock = vi.hoisted(() => vi.fn());
const listAgentActionsMock = vi.hoisted(() => vi.fn());
const exportCsvMock = vi.hoisted(() => vi.fn());
const listAgentsMock = vi.hoisted(() => vi.fn());
const listUserDirectoryMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/activity", () => ({
  activityApi: { list: (companyId: string, filters: unknown) => listActivityMock(companyId, filters) },
}));

vi.mock("@/api/audit", () => ({
  auditApi: {
    listAgentActions: (companyId: string, filters: unknown) => listAgentActionsMock(companyId, filters),
    exportAgentActionsCsv: (companyId: string, filters: unknown) => exportCsvMock(companyId, filters),
  },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: { list: (companyId: string) => listAgentsMock(companyId) },
}));

vi.mock("@/api/access", () => ({
  accessApi: { listUserDirectory: (companyId: string) => listUserDirectoryMock(companyId) },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    companies: [{ id: "company-1", name: "Paperclip", issuePrefix: "PAP" }],
  }),
}));

vi.mock("@/lib/router", () => ({
  useParams: () => ({}),
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: pushToastMock }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    companyId: "company-1",
    actorType: "agent",
    actorId: "agent-1",
    action: "issue.comment_added",
    entityType: "issue",
    entityId: "issue-1",
    agentId: "agent-1",
    runId: "run-1",
    responsibleUserId: "user-1",
    details: { commentId: "c1" },
    createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    entity: {
      issue: { id: "issue-1", identifier: "PAP-1", title: "Ship the audit view" },
      comment: { id: "c1", excerpt: "Looks good to me" },
      document: null,
    },
    ...overrides,
  };
}

function isAccessCheck(filters: unknown) {
  return (filters as { actorScope?: string }).actorScope === "all";
}

describe("Activity agent actions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    listActivityMock.mockResolvedValue([]);
    listAgentsMock.mockResolvedValue([{ id: "agent-1", name: "Fable", icon: null }]);
    listUserDirectoryMock.mockResolvedValue({
      users: [{ principalId: "user-1", status: "active", user: { id: "user-1", name: "Dotta", email: null, image: null } }],
    });
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  // The server's answer to the one-row access check on the all-actors feed.
  function grantAccess(accessTier: "full" | "basic") {
    listAgentActionsMock.mockImplementation((_companyId: string, filters: unknown) => (
      isAccessCheck(filters)
        ? Promise.resolve({ items: [], nextCursor: null, accessTier })
        : Promise.resolve({ items: [record()], nextCursor: null, accessTier: "full" })
    ));
  }

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Activity />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  function tab(label: string) {
    return Array.from(container.querySelectorAll('[role="tab"]')).find((el) => el.textContent?.trim() === label);
  }

  // Radix tabs switch on mouse down, so send it as a real click would.
  async function openAgentActions() {
    const agentActionsTab = tab("Agent actions");
    expect(agentActionsTab, "Agent actions tab").toBeTruthy();
    await act(async () => {
      agentActionsTab!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      agentActionsTab!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    });
    await flushReact();
  }

  function feedCalls() {
    return listAgentActionsMock.mock.calls.filter(([, filters]) => !isAccessCheck(filters));
  }

  function button(text: string) {
    const found = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text));
    expect(found, `button "${text}"`).toBeTruthy();
    return found!;
  }

  it("hides Agent actions from a person without View agent audit actions", async () => {
    grantAccess("basic");
    await render();

    expect(listAgentActionsMock).toHaveBeenCalledWith("company-1", { actorScope: "all", limit: 1 });
    expect(tab("Agent actions")).toBeUndefined();
    expect(container.textContent).not.toContain("Agent actions");
    expect(feedCalls()).toHaveLength(0);
    expect(container.textContent).toContain("No activity yet.");
  });

  it("hides Agent actions when the access check is refused", async () => {
    listAgentActionsMock.mockRejectedValue(new ApiError("Activity is outside this actor's authorization boundary", 403));
    await render();

    expect(listAgentActionsMock).toHaveBeenCalledWith("company-1", { actorScope: "all", limit: 1 });
    expect(tab("Agent actions")).toBeUndefined();
    expect(feedCalls()).toHaveLength(0);
  });

  it("shows a permitted person each agent action with its task, person and run", async () => {
    grantAccess("full");
    await render();
    expect(tab("All activity")).toBeTruthy();
    expect(feedCalls()).toHaveLength(0);

    await openAgentActions();

    expect(feedCalls()[0]?.[1]).toEqual({ limit: 50, cursor: undefined });
    const list = container.querySelector('ul[aria-label="Agent actions"]');
    expect(list?.textContent).toContain("Fable");
    expect(list?.textContent).toContain("commented on");
    expect(container.querySelector('a[href="/issues/PAP-1"]')?.textContent).toContain("Ship the audit view");
    expect(list?.textContent).toContain("Looks good to me");
    expect(list?.textContent).toContain("on behalf of Dotta");
    expect(container.querySelector('a[href="/agents/agent-1/runs/run-1"]')?.textContent).toBe("View run");
    for (const label of ["Agent", "Responsible user", "Action", "Type"]) {
      expect(container.querySelector(`[aria-label="${label}"]`), label).toBeTruthy();
    }
  });

  it("filters by date and downloads the same filtered rows as CSV", async () => {
    grantAccess("full");
    exportCsvMock.mockResolvedValue(new Blob(["csv"], { type: "text/csv" }));
    const createUrl = vi.fn(() => "blob:agent-audit");
    const revokeUrl = vi.fn();
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = createUrl;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeUrl;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await render();
    await openAgentActions();

    const fromInput = Array.from(container.querySelectorAll("label"))
      .find((label) => label.textContent?.trim().startsWith("From"))
      ?.querySelector("input");
    expect(fromInput).toBeTruthy();
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(fromInput, "2026-10-01");
      fromInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    const from = new Date("2026-10-01T00:00:00").toISOString();
    expect(feedCalls().at(-1)?.[1]).toEqual(expect.objectContaining({ from }));
    expect(container.textContent).toContain("Clear filters");

    await act(async () => {
      button("Download CSV").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(exportCsvMock).toHaveBeenCalledWith("company-1", expect.objectContaining({ from }));
    expect(createUrl).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(pushToastMock).toHaveBeenCalledWith(expect.objectContaining({ tone: "success" }));
  });

  it("loads the next page when the server returns a cursor", async () => {
    listAgentActionsMock.mockImplementation((_companyId: string, filters: { actorScope?: string; cursor?: string }) => {
      if (isAccessCheck(filters)) return Promise.resolve({ items: [], nextCursor: null, accessTier: "full" });
      if (filters.cursor === "cursor-2") {
        return Promise.resolve({
          items: [record({ id: "evt-2", entity: { issue: { id: "i2", identifier: "PAP-2", title: "Second" }, comment: null, document: null } })],
          nextCursor: null,
          accessTier: "full",
        });
      }
      return Promise.resolve({ items: [record()], nextCursor: "cursor-2", accessTier: "full" });
    });
    await render();
    await openAgentActions();

    expect(container.querySelector('a[href="/issues/PAP-2"]')).toBeFalsy();
    await act(async () => {
      button("Load more").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    expect(container.querySelector('a[href="/issues/PAP-2"]')).toBeTruthy();
  });
});
