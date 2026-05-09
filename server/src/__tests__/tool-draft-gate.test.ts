import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(async () => ({ outboundToolDraftMode: true })),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/approvals.js", () => ({
  approvalService: () => mockApprovalService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

const stubDb = {} as never;

async function loadDraftGate() {
  const { createDraftGate } = await import("../services/tool-draft-gate.js");
  return createDraftGate({ db: stubDb });
}

function ctx(overrides: Partial<ToolRunContext>): ToolRunContext {
  return {
    agentId: "00000000-0000-0000-0000-000000000000",
    runId: "00000000-0000-0000-0000-000000000000",
    companyId: "00000000-0000-0000-0000-0000000000aa",
    projectId: "",
    ...overrides,
  };
}

describe("tool draft gate — synthetic agent id handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApprovalService.create.mockResolvedValue({ id: "approval-1" });
  });

  it("routes Clippy invocations through requestedByUserId, not requestedByAgentId", async () => {
    const gate = await loadDraftGate();
    const result = await gate.intercept(
      "3cx-tools:pbx_click_to_call",
      { toNumber: "+15555550199", fromExtension: "200" },
      ctx({ agentId: "clippy:user-abc-123" }),
    );

    expect(result.intercepted).toBe(true);
    expect(mockApprovalService.create).toHaveBeenCalledTimes(1);
    const createArgs = mockApprovalService.create.mock.calls[0]![1];
    expect(createArgs.requestedByAgentId).toBeNull();
    expect(createArgs.requestedByUserId).toBe("user-abc-123");
    // Original synthetic id is preserved in the payload for traceability.
    expect((createArgs.payload as Record<string, unknown>).agentId).toBe(
      "clippy:user-abc-123",
    );
  });

  it("nulls activity-log agentId/runId for Clippy invocations", async () => {
    const gate = await loadDraftGate();
    await gate.intercept(
      "3cx-tools:pbx_click_to_call",
      { toNumber: "+15555550199", fromExtension: "200" },
      ctx({ agentId: "clippy:user-abc-123", runId: "11111111-1111-1111-1111-111111111111" }),
    );

    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    const logArgs = mockLogActivity.mock.calls[0]![1];
    expect(logArgs.actorType).toBe("user");
    expect(logArgs.actorId).toBe("user-abc-123");
    expect(logArgs.agentId).toBeNull();
    // The synthetic runId from chat-tools doesn't reference a real
    // heartbeat_runs row, so we drop it to avoid an FK violation.
    expect(logArgs.runId).toBeNull();
  });

  it("preserves real agent ids verbatim", async () => {
    const gate = await loadDraftGate();
    const realAgentId = "22222222-2222-2222-2222-222222222222";
    const realRunId = "33333333-3333-3333-3333-333333333333";
    await gate.intercept(
      "3cx-tools:pbx_click_to_call",
      { toNumber: "+15555550199", fromExtension: "200" },
      ctx({ agentId: realAgentId, runId: realRunId }),
    );

    const createArgs = mockApprovalService.create.mock.calls[0]![1];
    expect(createArgs.requestedByAgentId).toBe(realAgentId);
    expect(createArgs.requestedByUserId).toBeNull();

    const logArgs = mockLogActivity.mock.calls[0]![1];
    expect(logArgs.actorType).toBe("agent");
    expect(logArgs.actorId).toBe(realAgentId);
    expect(logArgs.agentId).toBe(realAgentId);
    expect(logArgs.runId).toBe(realRunId);
  });
});
