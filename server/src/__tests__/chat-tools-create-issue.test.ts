import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

const { executeChatTool, getChatTool } = await import("../services/chat-tools.js");

const COMPANY_ID = "22222222-2222-2222-2222-222222222222";
const ISSUE_ID = "11111111-1111-1111-1111-111111111111";

function emptyDb(): Db {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return Promise.resolve([]);
            },
          };
        },
      };
    },
  } as unknown as Db;
}

function userCtx(db: Db, userId = "user-1", companyIds = [COMPANY_ID]) {
  return {
    db,
    actor: { userId, isInstanceAdmin: false, companyIds },
    defaultCompanyId: COMPANY_ID,
  };
}

function agentCtx(db: Db, agentId = "33333333-3333-3333-3333-333333333333") {
  return {
    db,
    actor: { userId: `agent:${agentId}`, isInstanceAdmin: false, companyIds: [COMPANY_ID] },
    defaultCompanyId: COMPANY_ID,
  };
}

describe("create_issue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.create.mockResolvedValue({
      id: ISSUE_ID,
      identifier: "HQ-42",
      issueNumber: 42,
      companyId: COMPANY_ID,
      title: "Clippy filed this bug",
      description: "Bug details here",
      status: "backlog",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdAt: new Date("2026-09-09T16:00:00.000Z"),
      updatedAt: new Date("2026-09-09T16:00:00.000Z"),
    });
  });

  it("is registered and flagged mutating", () => {
    const tool = getChatTool("create_issue");
    expect(tool).toBeDefined();
    expect(tool!.mutating).toBe(true);
  });

  it("creates an issue through issueService and returns identifier", async () => {
    const result = await executeChatTool(
      "create_issue",
      { title: "Fix the thing", description: "More details" },
      userCtx(emptyDb()),
    );

    expect(result.ok).toBe(true);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({
        title: "Fix the thing",
        description: "More details",
        originKind: "chat",
        createdByUserId: "user-1",
        createdByAgentId: null,
      }),
    );
    if (result.ok) {
      const payload = result.result as { issue: { identifier: string; title: string } };
      expect(payload.issue.identifier).toBe("HQ-42");
    }
  });

  it("credits the agent when invoked by an agent", async () => {
    const agentId = "44444444-4444-4444-4444-444444444444";
    const result = await executeChatTool(
      "create_issue",
      { title: "Agent discovered issue" },
      agentCtx(emptyDb(), agentId),
    );

    expect(result.ok).toBe(true);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({
        title: "Agent discovered issue",
        createdByUserId: null,
        createdByAgentId: agentId,
      }),
    );
  });

  it("rejects when no company context is provided or found", async () => {
    const result = await executeChatTool(
      "create_issue",
      { title: "Nowhere issue" },
      {
        db: emptyDb(),
        actor: { userId: "u1", isInstanceAdmin: true, companyIds: [] },
        defaultCompanyId: null,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/No company context/);
    }
  });
});
