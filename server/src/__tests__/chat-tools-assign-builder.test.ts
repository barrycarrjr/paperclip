import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  update: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  resolveByReference: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockPortfolioRootCache = vi.hoisted(() => ({
  getPortfolioRootCompanyId: vi.fn(),
}));

const mockQueueIssueAssignmentWakeup = vi.hoisted(() => vi.fn());

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

vi.mock("../services/portfolio-root-cache.js", () => ({
  getPortfolioRootCompanyId: mockPortfolioRootCache.getPortfolioRootCompanyId,
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: mockQueueIssueAssignmentWakeup,
}));

const { executeChatTool } = await import("../services/chat-tools.js");

const HQ_COMPANY_ID = "00000000-0000-0000-0000-000000000001";
const OTHER_COMPANY_ID = "22222222-2222-2222-2222-222222222222";
const BUILDER_AGENT_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ISSUE_ID = "11111111-1111-1111-1111-111111111111";

function emptyDb(): Db {
  return {} as unknown as Db;
}

function userCtx({
  userId = "user-1",
  companyIds = [HQ_COMPANY_ID, OTHER_COMPANY_ID],
  isInstanceAdmin = false,
  memberships = [{ companyId: HQ_COMPANY_ID, membershipRole: "admin" }],
  defaultCompanyId = OTHER_COMPANY_ID,
}: {
  userId?: string;
  companyIds?: string[];
  isInstanceAdmin?: boolean;
  memberships?: Array<{ companyId: string; membershipRole?: string | null; status?: string }>;
  defaultCompanyId?: string | null;
}) {
  return {
    db: emptyDb(),
    actor: {
      userId,
      isInstanceAdmin,
      companyIds,
      memberships,
    },
    defaultCompanyId,
  };
}

describe("Clippy Builder assignment and HQ permission gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPortfolioRootCache.getPortfolioRootCompanyId.mockResolvedValue(HQ_COMPANY_ID);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAgentService.resolveByReference.mockImplementation(async (companyId: string, ref: string) => {
      if (companyId === HQ_COMPANY_ID && (ref === "Builder" || ref === "builder" || ref === BUILDER_AGENT_ID)) {
        return {
          agent: {
            id: BUILDER_AGENT_ID,
            name: "Builder",
            role: "builder",
            status: "active",
            companyId: HQ_COMPANY_ID,
          },
        };
      }
      return { agent: null };
    });

    mockIssueService.create.mockResolvedValue({
      id: ISSUE_ID,
      identifier: "HQ-101",
      companyId: HQ_COMPANY_ID,
      title: "Add dark mode toggle",
      description: "Implement dark mode in app header",
      status: "backlog",
      priority: "high",
      assigneeAgentId: BUILDER_AGENT_ID,
      assigneeUserId: null,
      createdAt: new Date("2026-10-28T12:00:00.000Z"),
      updatedAt: new Date("2026-10-28T12:00:00.000Z"),
    });

    mockIssueService.getById.mockResolvedValue({
      id: ISSUE_ID,
      identifier: "HQ-101",
      companyId: HQ_COMPANY_ID,
      title: "Add dark mode toggle",
      description: null,
      status: "backlog",
      priority: "high",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdAt: new Date("2026-10-28T12:00:00.000Z"),
      updatedAt: new Date("2026-10-28T12:00:00.000Z"),
    });

    mockIssueService.update.mockResolvedValue({
      id: ISSUE_ID,
      identifier: "HQ-101",
      companyId: HQ_COMPANY_ID,
      title: "Add dark mode toggle",
      description: null,
      status: "backlog",
      priority: "high",
      assigneeAgentId: BUILDER_AGENT_ID,
      assigneeUserId: null,
      createdAt: new Date("2026-10-28T12:00:00.000Z"),
      updatedAt: new Date("2026-10-28T12:05:00.000Z"),
    });
  });

  describe("create_issue targeting Builder", () => {
    it("allows authorized HQ user to assign tasks to Builder and wakes Builder up", async () => {
      const ctx = userCtx({
        companyIds: [HQ_COMPANY_ID, OTHER_COMPANY_ID],
        memberships: [{ companyId: HQ_COMPANY_ID, membershipRole: "admin" }],
        defaultCompanyId: OTHER_COMPANY_ID,
      });

      const result = await executeChatTool(
        "create_issue",
        {
          title: "Add dark mode toggle",
          description: "Implement dark mode in app header",
          priority: "high",
          assigneeAgentId: "Builder",
        },
        ctx,
      );

      expect(result.ok).toBe(true);
      expect(mockAccessService.canUser).toHaveBeenCalledWith(
        HQ_COMPANY_ID,
        "user-1",
        "tasks:assign",
      );
      expect(mockIssueService.create).toHaveBeenCalledWith(
        HQ_COMPANY_ID,
        expect.objectContaining({
          title: "Add dark mode toggle",
          description: "Implement dark mode in app header",
          priority: "high",
          assigneeAgentId: BUILDER_AGENT_ID,
        }),
      );
      expect(mockQueueIssueAssignmentWakeup).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "issue_assigned",
          mutation: "create",
          contextSource: "issue.create",
        }),
      );
    });

    it("allows instance admin to assign to Builder even without explicit memberships", async () => {
      const ctx = userCtx({
        isInstanceAdmin: true,
        companyIds: [],
        memberships: [],
        defaultCompanyId: null,
      });

      const result = await executeChatTool(
        "create_issue",
        {
          title: "Build infrastructure",
          assigneeAgentId: "builder",
        },
        ctx,
      );

      expect(result.ok).toBe(true);
      expect(mockIssueService.create).toHaveBeenCalledWith(
        HQ_COMPANY_ID,
        expect.objectContaining({
          assigneeAgentId: BUILDER_AGENT_ID,
        }),
      );
      expect(mockQueueIssueAssignmentWakeup).toHaveBeenCalled();
    });

    it("rejects non-HQ users from creating/assigning tasks to Builder in HQ", async () => {
      const ctx = userCtx({
        companyIds: [OTHER_COMPANY_ID],
        memberships: [{ companyId: OTHER_COMPANY_ID, membershipRole: "admin" }],
        defaultCompanyId: OTHER_COMPANY_ID,
      });

      const result = await executeChatTool(
        "create_issue",
        {
          title: "Build something",
          assigneeAgentId: "Builder",
        },
        ctx,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(`No access to company ${HQ_COMPANY_ID}`);
      }
      expect(mockIssueService.create).not.toHaveBeenCalled();
      expect(mockQueueIssueAssignmentWakeup).not.toHaveBeenCalled();
    });

    it("rejects HQ viewers from creating/assigning tasks to Builder in HQ", async () => {
      const ctx = userCtx({
        companyIds: [HQ_COMPANY_ID],
        memberships: [{ companyId: HQ_COMPANY_ID, membershipRole: "viewer" }],
        defaultCompanyId: HQ_COMPANY_ID,
      });

      const result = await executeChatTool(
        "create_issue",
        {
          title: "Build something",
          assigneeAgentId: "Builder",
        },
        ctx,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("Viewer access is read-only");
      }
      expect(mockIssueService.create).not.toHaveBeenCalled();
      expect(mockQueueIssueAssignmentWakeup).not.toHaveBeenCalled();
    });

    it("rejects HQ members lacking tasks:assign permission", async () => {
      mockAccessService.canUser.mockResolvedValue(false);

      const ctx = userCtx({
        companyIds: [HQ_COMPANY_ID],
        memberships: [{ companyId: HQ_COMPANY_ID, membershipRole: "custom" }],
        defaultCompanyId: HQ_COMPANY_ID,
      });

      const result = await executeChatTool(
        "create_issue",
        {
          title: "Build something",
          assigneeAgentId: "Builder",
        },
        ctx,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("Missing permission: tasks:assign");
      }
      expect(mockIssueService.create).not.toHaveBeenCalled();
      expect(mockQueueIssueAssignmentWakeup).not.toHaveBeenCalled();
    });
  });

  describe("update_issue targeting Builder", () => {
    it("allows authorized HQ user to assign an existing issue to Builder", async () => {
      const ctx = userCtx({
        companyIds: [HQ_COMPANY_ID],
        memberships: [{ companyId: HQ_COMPANY_ID, membershipRole: "admin" }],
      });

      const result = await executeChatTool(
        "update_issue",
        {
          issueId: ISSUE_ID,
          assigneeAgentId: "Builder",
          comment: "Assigning to Builder for implementation",
        },
        ctx,
      );

      expect(result.ok).toBe(true);
      expect(mockAccessService.canUser).toHaveBeenCalledWith(
        HQ_COMPANY_ID,
        "user-1",
        "tasks:assign",
      );
      expect(mockIssueService.update).toHaveBeenCalledWith(
        ISSUE_ID,
        expect.objectContaining({
          assigneeAgentId: BUILDER_AGENT_ID,
        }),
      );
      expect(mockQueueIssueAssignmentWakeup).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "issue_assigned",
          mutation: "update",
          contextSource: "issue.assign",
        }),
      );
    });

    it("rejects user without HQ access when updating an issue in HQ", async () => {
      const ctx = userCtx({
        companyIds: [OTHER_COMPANY_ID],
        memberships: [{ companyId: OTHER_COMPANY_ID, membershipRole: "admin" }],
      });

      const result = await executeChatTool(
        "update_issue",
        {
          issueId: ISSUE_ID,
          assigneeAgentId: "Builder",
        },
        ctx,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(`No access to company ${HQ_COMPANY_ID}`);
      }
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("rejects HQ viewer when reassigning issue to Builder", async () => {
      const ctx = userCtx({
        companyIds: [HQ_COMPANY_ID],
        memberships: [{ companyId: HQ_COMPANY_ID, membershipRole: "viewer" }],
      });

      const result = await executeChatTool(
        "update_issue",
        {
          issueId: ISSUE_ID,
          assigneeAgentId: "Builder",
        },
        ctx,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("Viewer access is read-only");
      }
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("rejects assigning to terminated agents with conflict error", async () => {
      mockAgentService.resolveByReference.mockResolvedValue({
        agent: {
          id: BUILDER_AGENT_ID,
          name: "Builder",
          role: "builder",
          status: "terminated",
          companyId: HQ_COMPANY_ID,
        },
      });

      const ctx = userCtx({
        companyIds: [HQ_COMPANY_ID],
        memberships: [{ companyId: HQ_COMPANY_ID, membershipRole: "admin" }],
      });

      const result = await executeChatTool(
        "update_issue",
        {
          issueId: ISSUE_ID,
          assigneeAgentId: "Builder",
        },
        ctx,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Cannot assign work to terminated agents");
      }
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });
  });
});
