// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, HeartbeatRun } from "@paperclipai/shared";
import { AgentCurrentWork } from "./AgentCurrentWork";
import { ToastProvider } from "../context/ToastContext";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useNavigate: () => () => {},
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    list: vi.fn().mockResolvedValue([]),
    skills: vi.fn().mockResolvedValue({ supported: true, entries: [] }),
  },
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: { liveRunsForCompany: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    list: vi.fn().mockResolvedValue([]),
    listPendingInteractions: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../api/activity", () => ({
  activityApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/access", () => ({
  accessApi: { listUserDirectory: vi.fn().mockResolvedValue({ users: [] }) },
}));

// The latest run's files and notes read their own lists; not what this is about.
vi.mock("./RunWorkProductsCard", () => ({ RunWorkProductsCard: () => null }));
vi.mock("./RunDocumentsCard", () => ({ RunDocumentsCard: () => null }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const EXPIRED =
  "Claude run failed: subtype=success: Failed to authenticate: OAuth session expired and could not be refreshed";

const CHIEF_OF_STAFF = {
  id: "cos",
  companyId: "company-1",
  name: "Chief of Staff",
  urlKey: "chief-of-staff",
  role: "general",
  title: null,
  status: "error",
  reportsTo: null,
  adapterType: "claude_local",
  lastError: EXPIRED,
  pauseReason: null,
  pausedAt: null,
  lastHeartbeatAt: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-18T09:00:00.000Z",
} as unknown as Agent;

function failedRun(id: string, createdAt: string): HeartbeatRun {
  return {
    id,
    companyId: "company-1",
    agentId: "cos",
    status: "failed",
    error: EXPIRED,
    createdAt,
    startedAt: createdAt,
    finishedAt: createdAt,
    resultJson: null,
    livenessState: null,
    livenessReason: null,
    retryOfRunId: null,
  } as unknown as HeartbeatRun;
}

async function settle() {
  for (let index = 0; index < 10; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("AgentCurrentWork", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("links to the newest failed run and shows the raw error once, behind Details", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <AgentCurrentWork
              agent={CHIEF_OF_STAFF}
              companyId="company-1"
              // Older first, so taking the first one would pick the wrong run.
              runs={[
                failedRun("run-older", "2026-09-17T09:00:00.000Z"),
                failedRun("run-newer", "2026-09-18T09:00:00.000Z"),
              ]}
              agentRouteId="chief-of-staff"
            />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await settle();

    const text = container.textContent ?? "";
    expect(text).toContain("Its last run could not sign in to Claude.");
    expect(text).toContain("Try again. If it fails again, sign in again under Adapters.");

    const wentWrong = Array.from(container.querySelectorAll("a")).find(
      (link) => link.textContent === "See what went wrong",
    );
    expect(wentWrong?.getAttribute("href")).toBe("/agents/chief-of-staff/runs/run-newer");

    expect(text.split(EXPIRED).length - 1).toBe(1);
    const details = container.querySelectorAll("details");
    expect(details).toHaveLength(1);
    expect(details[0]!.textContent).toContain(EXPIRED);

    // Same action as before, named for what the person is doing.
    const labels = Array.from(container.querySelectorAll("button")).map((el) => el.textContent);
    expect(labels).toContain("Try again");
    expect(labels).not.toContain("Wake");
  });
});
