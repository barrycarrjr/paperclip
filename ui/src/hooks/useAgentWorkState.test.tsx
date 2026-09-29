// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { useAgentWorkState, useTeamWorkSources } from "./useAgentWorkState";

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

let seen: Array<string | null> = [];

function Header({ enabled }: { enabled: boolean }) {
  seen.push(useAgentWorkState(COO, "company-1", enabled));
  return null;
}

/** Stands in for the current-work panel under the header on the same page. */
function Panel() {
  useTeamWorkSources("company-1");
  return null;
}

describe("useAgentWorkState", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    seen = [];
    liveRuns.mockReset().mockResolvedValue([]);
    listIssues.mockReset().mockResolvedValue([]);
    pendingInteractions.mockReset().mockResolvedValue([]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(node: React.ReactNode) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
    });
    await settle();
  }

  it("reads Needs you for an agent whose question is waiting, as the Team page does", async () => {
    pendingInteractions.mockResolvedValue([
      { id: "q1", createdByAgentId: "coo", issueId: "i1", issueIdentifier: "IND-7", issueTitle: "Pick a supplier", status: "pending" },
    ]);

    await render(<Header enabled />);

    expect(seen.at(-1)).toBe("needs_you");
  });

  it("reads Ready for review for an agent that handed work back", async () => {
    listIssues.mockResolvedValue([
      { id: "i2", identifier: "IND-8", title: "Draft the plan", status: "in_review", assigneeAgentId: "coo", updatedAt: new Date().toISOString() },
    ]);

    await render(<Header enabled />);

    expect(seen.at(-1)).toBe("needs_review");
  });

  it("asks the server once when the header and the panel both read the lists", async () => {
    await render(
      <>
        <Header enabled />
        <Panel />
      </>,
    );

    expect(liveRuns).toHaveBeenCalledTimes(1);
    expect(listIssues).toHaveBeenCalledTimes(1);
    expect(pendingInteractions).toHaveBeenCalledTimes(1);
  });

  it("reads nothing and says nothing when switched off", async () => {
    await render(<Header enabled={false} />);

    expect(seen.every((state) => state === null)).toBe(true);
    expect(liveRuns).not.toHaveBeenCalled();
    expect(listIssues).not.toHaveBeenCalled();
    expect(pendingInteractions).not.toHaveBeenCalled();
  });
});
