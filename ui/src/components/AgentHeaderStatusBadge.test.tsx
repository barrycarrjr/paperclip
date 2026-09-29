// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { AgentHeaderStatusBadge, agentHeaderReadsWorkState } from "./AgentHeaderStatusBadge";

const liveRuns = vi.fn();
const listIssues = vi.fn();
const pendingInteractions = vi.fn();

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

const COO = {
  id: "coo",
  companyId: "company-1",
  name: "Chief Operating Officer",
  urlKey: "chief-operating-officer",
  role: "coo",
  status: "idle",
  adapterType: "claude_local",
  pauseReason: null,
  pausedAt: null,
  lastHeartbeatAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
} as unknown as Agent;

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("AgentHeaderStatusBadge", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    liveRuns.mockReset().mockResolvedValue([]);
    listIssues.mockReset().mockResolvedValue([]);
    // The COO asked a question and is waiting for the answer, as seen live.
    pendingInteractions.mockReset().mockResolvedValue([
      { id: "q1", createdByAgentId: "coo", issueId: "i1", issueIdentifier: "IND-7", issueTitle: "Pick a supplier", status: "pending" },
    ]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(view: string, isPluginTab: boolean) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AgentHeaderStatusBadge agent={COO} companyId="company-1" view={view} isPluginTab={isPluginTab} />
        </QueryClientProvider>,
      );
    });
    await settle();
    return container.textContent;
  }

  it("says Needs you on the dashboard tab for an agent waiting on an answer", async () => {
    expect(await render("dashboard", false)).toBe("Needs you");
  });

  it("keeps the stored status on another tab and asks the server for nothing", async () => {
    expect(await render("runs", false)).toBe("idle");
    expect(pendingInteractions).not.toHaveBeenCalled();
    expect(listIssues).not.toHaveBeenCalled();
    expect(liveRuns).not.toHaveBeenCalled();
  });

  it("keeps the stored status on a plugin's tab, which has no current-work panel to share with", async () => {
    // A plugin's tab parses as the dashboard, so this is the case that matters.
    expect(await render("dashboard", true)).toBe("idle");
    expect(pendingInteractions).not.toHaveBeenCalled();
    expect(listIssues).not.toHaveBeenCalled();
    expect(liveRuns).not.toHaveBeenCalled();
  });
});

describe("agentHeaderReadsWorkState", () => {
  it.each<[string, boolean, boolean]>([
    ["dashboard", false, true],
    ["dashboard", true, false],
    ["runs", false, false],
    ["configuration", false, false],
    ["budget", false, false],
  ])("view %s, plugin tab %s: %s", (view, isPluginTab, expected) => {
    expect(agentHeaderReadsWorkState(view, isPluginTab)).toBe(expected);
  });
});
