// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval } from "@paperclipai/shared";
import { ApprovalDetail } from "./ApprovalDetail";

const getApprovalMock = vi.hoisted(() => vi.fn());
const requestRevisionMock = vi.hoisted(() => vi.fn());
const resubmitMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => navigateMock,
  useParams: () => ({ approvalId: "approval-1" }),
  useSearchParams: () => [new URLSearchParams()],
}));

vi.mock("../api/approvals", () => ({
  approvalsApi: {
    get: (...args: unknown[]) => getApprovalMock(...args),
    listComments: vi.fn().mockResolvedValue([]),
    listIssues: vi.fn().mockResolvedValue([]),
    approve: vi.fn(),
    reject: vi.fn(),
    requestRevision: (...args: unknown[]) => requestRevisionMock(...args),
    resubmit: (...args: unknown[]) => resubmitMock(...args),
    addComment: vi.fn(),
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    list: vi.fn().mockResolvedValue([]),
    remove: vi.fn(),
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    setSelectedCompanyId: vi.fn(),
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeInstructionApproval(status: Approval["status"]): Approval {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "instruction_change",
    requestedByAgentId: "agent-1",
    requestedByUserId: null,
    status,
    payload: {
      targetAgentId: "agent-1",
      scope: "agent",
      rule: "Always cite the filing source.",
      rationale: "A correction from the board.",
    },
    decisionNote: status === "revision_requested" ? "Name the source requirement precisely." : null,
    decidedByUserId: status === "revision_requested" ? "board" : null,
    decidedAt: status === "revision_requested" ? new Date() : null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("ApprovalDetail instruction changes", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    requestRevisionMock.mockResolvedValue(makeInstructionApproval("revision_requested"));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function renderApproval(approval: Approval) {
    getApprovalMock.mockResolvedValue(approval);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ApprovalDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("sends the board's revision note with an instruction-change decision", async () => {
    await renderApproval(makeInstructionApproval("pending"));

    const note = container.querySelector("#instruction-revision-note") as HTMLTextAreaElement | null;
    const requestButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Request revision",
    );
    expect(note).toBeTruthy();
    expect(requestButton?.disabled).toBe(true);

    await act(async () => {
      if (note) {
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        valueSetter?.call(note, "  Name the source requirement precisely.  ");
        note.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });

    expect(requestButton?.disabled).toBe(false);
    await act(async () => {
      requestButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(requestRevisionMock).toHaveBeenCalledWith(
      "approval-1",
      "Name the source requirement precisely.",
    );
  });

  it("waits for the corrected agent instead of letting the board mark the rule resubmitted", async () => {
    await renderApproval(makeInstructionApproval("revision_requested"));

    expect(container.textContent).toContain("Waiting for the corrected agent to submit a revised rule.");
    expect(container.textContent).not.toContain("Mark resubmitted");
    expect(resubmitMock).not.toHaveBeenCalled();
  });
});
