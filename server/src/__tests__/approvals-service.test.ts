import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalService } from "../services/approvals.ts";

const mockAgentService = vi.hoisted(() => ({
  activatePendingApproval: vi.fn(),
  create: vi.fn(),
  terminate: vi.fn(),
}));

const mockNotifyHireApproved = vi.hoisted(() => vi.fn());

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => mockAgentService),
}));

vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: mockNotifyHireApproved,
}));

type ApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgentId: string | null;
};

function createApproval(status: string): ApprovalRecord {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "hire_agent",
    status,
    payload: { agentId: "agent-1" },
    requestedByAgentId: "requester-1",
  };
}

function createDbStub(selectResults: ApprovalRecord[][], updateResults: ApprovalRecord[]) {
  const pendingSelectResults = [...selectResults];
  const selectWhere = vi.fn(async () => pendingSelectResults.shift() ?? []);
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));

  const returning = vi.fn(async () => updateResults);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  return {
    db: { select, update },
    selectWhere,
    returning,
  };
}

describe("approvalService resolution idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.activatePendingApproval.mockResolvedValue(undefined);
    mockAgentService.create.mockResolvedValue({ id: "agent-1" });
    mockAgentService.terminate.mockResolvedValue(undefined);
    mockNotifyHireApproved.mockResolvedValue(undefined);
  });

  it("treats repeated approve retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("approved")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("approved");
    expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
    expect(mockNotifyHireApproved).not.toHaveBeenCalled();
  });

  it("treats repeated reject retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("rejected")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.reject("approval-1", "board", "not now");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("rejected");
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  });

  it("still performs side effects when the resolution update is newly applied", async () => {
    const approved = createApproval("approved");
    const dbStub = createDbStub([[createApproval("pending")]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.activatePendingApproval).toHaveBeenCalledWith("agent-1");
    expect(mockNotifyHireApproved).toHaveBeenCalledTimes(1);
  });

  it("returns an existing revision request as an idempotent retry", async () => {
    const revised = {
      ...createApproval("revision_requested"),
      decidedByUserId: "original-board",
      decisionNote: "Tighten the wording.",
    };
    const dbStub = createDbStub([[revised]], []);

    const result = await approvalService(dbStub.db as any)
      .requestRevision("approval-1", "retrying-board", "Replace the note");

    expect(result).toEqual({ approval: revised, applied: false });
    expect(dbStub.returning).not.toHaveBeenCalled();
  });

  it("returns a concurrent revision request after losing the pending update race", async () => {
    const revised = {
      ...createApproval("revision_requested"),
      decidedByUserId: "other-board",
      decisionNote: "Original decision note.",
    };
    const dbStub = createDbStub(
      [[createApproval("pending")], [revised]],
      [],
    );

    const result = await approvalService(dbStub.db as any)
      .requestRevision("approval-1", "board", "Racing note");

    expect(result).toEqual({ approval: revised, applied: false });
    expect(dbStub.returning).toHaveBeenCalledTimes(1);
  });

  it("rejects an instruction change revision without an actionable note", async () => {
    const instructionApproval = {
      ...createApproval("pending"),
      type: "instruction_change",
      payload: {},
    };
    const dbStub = createDbStub([[instructionApproval]], []);

    await expect(
      approvalService(dbStub.db as any).requestRevision("approval-1", "board", "   "),
    ).rejects.toMatchObject({
      status: 422,
      message: "A revision note is required for instruction changes",
    });
    expect(dbStub.returning).not.toHaveBeenCalled();
  });
});
