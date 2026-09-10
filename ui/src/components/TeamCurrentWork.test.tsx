// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamCurrentWork } from "./TeamCurrentWork";
import { ToastProvider } from "../context/ToastContext";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  // The controls navigate from their menu, so the mock has to answer this
  // too or the whole view fails to mount.
  useNavigate: () => () => {},
}));

const listAgents = vi.fn();
const liveRuns = vi.fn();
const listIssues = vi.fn();
const pendingInteractions = vi.fn();

vi.mock("../api/agents", () => ({
  agentsApi: { list: (companyId: string) => listAgents(companyId) },
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: { liveRunsForCompany: (companyId: string) => liveRuns(companyId) },
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    list: (companyId: string) => listIssues(companyId),
    listPendingInteractions: (companyId: string) => pendingInteractions(companyId),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function agent(overrides: Record<string, unknown>): any {
  return {
    companyId: "company-1",
    role: "worker",
    title: null,
    status: "active",
    reportsTo: null,
    adapterType: "claude",
    pauseReason: null,
    pausedAt: null,
    lastHeartbeatAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Type into a React-controlled input. Setting `.value` alone does not reach
 * React, which listens on the native setter, so the box would show the text
 * and the component would never hear about it.
 */
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Four queries have to resolve before the list appears; a single microtask
 * turn only gets through the first of them, and a skeleton has no text, so
 * an under-flushed test reads as an empty page rather than a failure.
 */
async function settle() {
  for (let index = 0; index < 10; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("TeamCurrentWork", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    listAgents.mockReset();
    liveRuns.mockReset();
    listIssues.mockReset();
    pendingInteractions.mockReset();
    liveRuns.mockResolvedValue([]);
    listIssues.mockResolvedValue([]);
    pendingInteractions.mockResolvedValue([]);
    // The cards/table choice is remembered between visits, so it has to be
    // cleared or the test that switches to the table decides what every test
    // after it renders.
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <TeamCurrentWork companyId="company-1" />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await settle();
  }

  it("leads with a sentence about what each agent is doing", async () => {
    listAgents.mockResolvedValue([
      agent({ id: "a1", name: "Mail triage", urlKey: "mail-triage" }),
      agent({ id: "a2", name: "Operations", urlKey: "operations" }),
    ]);
    liveRuns.mockResolvedValue([
      { id: "r1", agentId: "a1", agentName: "Mail triage", status: "running", issueId: "i1", createdAt: new Date().toISOString() },
    ]);
    listIssues.mockResolvedValue([
      { id: "i1", identifier: "PAP-42", title: "Prepare the customer reply", status: "in_progress", assigneeAgentId: "a1", updatedAt: new Date().toISOString() },
    ]);

    await render();

    expect(container.textContent).toContain("Mail triage");
    expect(container.textContent).toContain("Running now.");
    expect(container.textContent).toContain("PAP-42");
    expect(container.textContent).toContain("Prepare the customer reply");
    expect(container.textContent).toContain("Working");
    expect(container.textContent).toContain("Operations");
    expect(container.textContent).toContain("Nothing running.");
  });

  it("links the agent's name to that agent's own page", async () => {
    listAgents.mockResolvedValue([agent({ id: "a1", name: "Mail triage", urlKey: "mail-triage" })]);

    await render();

    const link = Array.from(container.querySelectorAll("a")).find(
      (anchor) => anchor.textContent === "Mail triage",
    );
    expect(link?.getAttribute("href")).toBe("/agents/mail-triage");
  });

  it("puts an agent waiting on an answer above one that is simply running", async () => {
    listAgents.mockResolvedValue([
      agent({ id: "a1", name: "Aardvark", urlKey: "aardvark" }),
      agent({ id: "a2", name: "Zebra", urlKey: "zebra" }),
    ]);
    liveRuns.mockResolvedValue([
      { id: "r1", agentId: "a1", agentName: "Aardvark", status: "running", createdAt: new Date().toISOString() },
    ]);
    pendingInteractions.mockResolvedValue([
      { id: "q1", createdByAgentId: "a2", issueId: "i9", issueIdentifier: "PAP-9", issueTitle: "Choose a supplier", status: "pending" },
    ]);

    await render();

    const names = Array.from(container.querySelectorAll("a"))
      .map((anchor) => anchor.textContent)
      .filter((text) => text === "Aardvark" || text === "Zebra");
    expect(names[0]).toBe("Zebra");
    expect(container.textContent).toContain("Asked you a question and is waiting for the answer.");
    expect(container.textContent).toContain("Needs you");
  });

  it("offers a filter only for the states some agent is actually in", async () => {
    listAgents.mockResolvedValue([
      agent({ id: "a1", name: "Mail triage", urlKey: "mail-triage" }),
      agent({ id: "a2", name: "Operations", urlKey: "operations", status: "paused" }),
    ]);

    await render();

    // Scoped to the chip row on purpose: the summary tiles above it always
    // name every state, so an unscoped query would find "Working" there and
    // say nothing about the chips.
    const chipRow = container.querySelector('[data-testid="team-state-filters"]')!;
    const filters = Array.from(chipRow.querySelectorAll("button")).map((b) => b.textContent);
    expect(filters.some((label) => label?.startsWith("Everyone"))).toBe(true);
    expect(filters.some((label) => label?.startsWith("Paused"))).toBe(true);
    expect(filters.some((label) => label?.startsWith("Working"))).toBe(false);
  });

  it("narrows the list when a filter is picked", async () => {
    listAgents.mockResolvedValue([
      agent({ id: "a1", name: "Mail triage", urlKey: "mail-triage" }),
      agent({ id: "a2", name: "Operations", urlKey: "operations", status: "paused" }),
    ]);

    await render();

    const chipRow = container.querySelector('[data-testid="team-state-filters"]')!;
    const pausedFilter = Array.from(chipRow.querySelectorAll("button")).find((b) =>
      b.textContent?.startsWith("Paused"),
    )!;
    await act(async () => {
      pausedFilter.click();
    });

    expect(container.textContent).toContain("Operations");
    expect(container.textContent).not.toContain("Mail triage");
  });

  it("says so plainly when the company has no agents", async () => {
    listAgents.mockResolvedValue([]);

    await render();

    expect(container.textContent).toContain("No agents in this company yet");
  });

  it("counts the whole team across the summary, not just the visible rows", async () => {
    listAgents.mockResolvedValue([
      agent({ id: "a1", name: "Mail triage", urlKey: "mail-triage" }),
      agent({ id: "a2", name: "Operations", urlKey: "operations", status: "paused" }),
    ]);

    await render();

    const summary = container.textContent ?? "";
    expect(summary).toContain("Needs you");
    expect(summary).toContain("Working");
    expect(summary).toContain("Paused");
    expect(summary).toContain("Idle");
  });

  it("narrows the list to what was typed in the search box", async () => {
    listAgents.mockResolvedValue([
      agent({ id: "a1", name: "Mail triage", urlKey: "mail-triage" }),
      agent({ id: "a2", name: "Operations", urlKey: "operations" }),
    ]);

    await render();

    const box = container.querySelector('input[type="search"]') as HTMLInputElement;
    await act(async () => {
      setInputValue(box, "operations");
    });

    expect(container.textContent).toContain("Operations");
    expect(container.textContent).not.toContain("Mail triage");
  });

  it("says so rather than showing an empty grid when a search matches nobody", async () => {
    listAgents.mockResolvedValue([agent({ id: "a1", name: "Mail triage", urlKey: "mail-triage" })]);

    await render();

    const box = container.querySelector('input[type="search"]') as HTMLInputElement;
    await act(async () => {
      setInputValue(box, "nobody at all");
    });

    expect(container.textContent).toContain("Nobody on the team matches that search.");
  });

  it("switches to a table showing the same people, with headings", async () => {
    listAgents.mockResolvedValue([agent({ id: "a1", name: "Mail triage", urlKey: "mail-triage" })]);

    await render();

    const tableButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.getAttribute("title") === "Table view",
    )!;
    await act(async () => {
      tableButton.click();
    });

    expect(container.querySelector("table")).not.toBeNull();
    expect(container.textContent).toContain("Team member");
    expect(container.textContent).toContain("What it is doing");
    expect(container.textContent).toContain("Mail triage");
  });

  it("finds someone by the role words printed on their card", async () => {
    listAgents.mockResolvedValue([
      agent({ id: "a1", name: "Mail triage", urlKey: "mail-triage", role: "engineer" }),
      agent({ id: "a2", name: "Operations", urlKey: "operations", role: "worker" }),
    ]);

    await render();

    const box = container.querySelector('input[type="search"]') as HTMLInputElement;
    await act(async () => {
      setInputValue(box, "engineer");
    });

    expect(container.textContent).toContain("Mail triage");
    expect(container.textContent).not.toContain("Operations");
  });

  it("finds someone by the task they are on", async () => {
    listAgents.mockResolvedValue([
      agent({ id: "a1", name: "Mail triage", urlKey: "mail-triage" }),
      agent({ id: "a2", name: "Operations", urlKey: "operations" }),
    ]);
    listIssues.mockResolvedValue([
      { id: "i1", identifier: "PAP-42", title: "Prepare the customer reply", status: "todo", assigneeAgentId: "a1", updatedAt: new Date().toISOString() },
    ]);

    await render();

    const box = container.querySelector('input[type="search"]') as HTMLInputElement;
    await act(async () => {
      setInputValue(box, "PAP-42");
    });

    expect(container.textContent).toContain("Mail triage");
    expect(container.textContent).not.toContain("Operations");
  });

  it("offers the move that this person's state calls for", async () => {
    listAgents.mockResolvedValue([
      agent({ id: "a1", name: "Asker", urlKey: "asker" }),
      agent({ id: "a2", name: "Runner", urlKey: "runner" }),
      agent({ id: "a3", name: "Sleeper", urlKey: "sleeper" }),
      agent({ id: "a4", name: "Halted", urlKey: "halted", status: "paused" }),
    ]);
    liveRuns.mockResolvedValue([
      { id: "r1", agentId: "a2", agentName: "Runner", status: "running", createdAt: new Date().toISOString() },
    ]);
    pendingInteractions.mockResolvedValue([
      { id: "q1", createdByAgentId: "a1", issueId: "i9", issueIdentifier: "PAP-9", issueTitle: "Choose a supplier", status: "pending" },
    ]);

    await render();

    const labels = Array.from(container.querySelectorAll("a, button")).map((el) => el.textContent);
    expect(labels).toContain("Answer");
    expect(labels).toContain("Stop");
    expect(labels).toContain("Resume");
    expect(labels).toContain("Wake");
  });
});
