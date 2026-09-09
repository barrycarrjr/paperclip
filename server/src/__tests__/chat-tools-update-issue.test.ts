import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

/**
 * `update_issue` — the tool whose absence stranded a run.
 *
 * An agent could read an issue, comment on it and create new ones, but not
 * move the one it was working on. An assigned issue left `in_progress` with
 * nothing live on it gets its agent woken again roughly every thirty seconds,
 * so an agent that was blocked and knew it was blocked had no way to say so
 * and posted "No new context. No-op. Exiting." on a loop instead.
 */

const mockIssueService = vi.hoisted(() => ({
  update: vi.fn(),
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

const { executeChatTool, getChatTool } = await import("../services/chat-tools.js");

const ISSUE_ID = "11111111-1111-1111-1111-111111111111";
const COMPANY_ID = "22222222-2222-2222-2222-222222222222";

/**
 * Enough database to find one issue and record any comment written about it.
 * Shaped like the drizzle chains the tool uses and nothing more.
 */
function dbWithIssue(captured: { comment?: Record<string, unknown> } = {}): Db {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                then(resolve: (value: unknown) => unknown) {
                  return Promise.resolve([{ id: ISSUE_ID, companyId: COMPANY_ID }]).then(resolve);
                },
              };
            },
          };
        },
      };
    },
    insert() {
      return {
        values(values: Record<string, unknown>) {
          captured.comment = values;
          return Promise.resolve([]);
        },
      };
    },
  } as unknown as Db;
}

function agentCtx(db: Db, agentId = "33333333-3333-3333-3333-333333333333") {
  return {
    db,
    actor: { userId: `agent:${agentId}`, isInstanceAdmin: false, companyIds: [COMPANY_ID] },
    defaultCompanyId: COMPANY_ID,
  };
}

describe("update_issue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.update.mockResolvedValue({
      id: ISSUE_ID,
      identifier: "IND-1260",
      companyId: COMPANY_ID,
      title: "an email someone handed over",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdAt: new Date("2026-09-09T16:00:00.000Z"),
      updatedAt: new Date("2026-09-09T16:30:00.000Z"),
    });
  });

  it("is registered and flagged mutating", () => {
    const tool = getChatTool("update_issue");
    expect(tool).toBeDefined();
    expect(tool!.mutating).toBe(true);
  });

  it("lets an agent mark its own work blocked", async () => {
    const result = await executeChatTool(
      "update_issue",
      { issueId: ISSUE_ID, status: "blocked" },
      agentCtx(dbWithIssue()),
    );

    expect(result.ok).toBe(true);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      ISSUE_ID,
      expect.objectContaining({ status: "blocked" }),
    );
  });

  it("credits the agent, not a user who does not exist", async () => {
    // A bridge session for an agent run carries `agent:<uuid>` as its user id.
    // Writing that into a user column is how an agent's edits end up
    // attributed to nobody.
    const agentId = "44444444-4444-4444-4444-444444444444";
    await executeChatTool(
      "update_issue",
      { issueId: ISSUE_ID, status: "done" },
      agentCtx(dbWithIssue(), agentId),
    );

    const [, patch] = mockIssueService.update.mock.calls[0]!;
    expect(patch).toMatchObject({ actorAgentId: agentId });
    expect(patch).not.toHaveProperty("actorUserId");
  });

  it("credits a person as a person", async () => {
    await executeChatTool(
      "update_issue",
      { issueId: ISSUE_ID, priority: "high" },
      {
        db: dbWithIssue(),
        actor: { userId: "user-1", isInstanceAdmin: false, companyIds: [COMPANY_ID] },
        defaultCompanyId: COMPANY_ID,
      },
    );

    const [, patch] = mockIssueService.update.mock.calls[0]!;
    expect(patch).toMatchObject({ actorUserId: "user-1" });
    expect(patch).not.toHaveProperty("actorAgentId");
  });

  it("posts the accompanying comment under the agent, not a phantom user", async () => {
    const captured: { comment?: Record<string, unknown> } = {};
    const agentId = "55555555-5555-5555-5555-555555555555";
    await executeChatTool(
      "update_issue",
      { issueId: ISSUE_ID, status: "blocked", comment: "Waiting on Brandon." },
      agentCtx(dbWithIssue(captured), agentId),
    );

    expect(captured.comment).toMatchObject({
      issueId: ISSUE_ID,
      body: "Waiting on Brandon.",
      authorAgentId: agentId,
    });
  });

  it("refuses a call that would change nothing", async () => {
    const result = await executeChatTool(
      "update_issue",
      { issueId: ISSUE_ID, comment: "just talking" },
      agentCtx(dbWithIssue()),
    );

    expect(result.ok).toBe(false);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("refuses a status that is not a status", async () => {
    const result = await executeChatTool(
      "update_issue",
      { issueId: ISSUE_ID, status: "on_fire" },
      agentCtx(dbWithIssue()),
    );

    expect(result.ok).toBe(false);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("refuses an issue in a company the caller cannot reach", async () => {
    const result = await executeChatTool(
      "update_issue",
      { issueId: ISSUE_ID, status: "done" },
      {
        db: dbWithIssue(),
        actor: { userId: "user-1", isInstanceAdmin: false, companyIds: ["another-company"] },
        defaultCompanyId: null,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/access/i);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("tells the model why leaving work in_progress is not free", () => {
    // The description is the only thing that gets an agent to use this at the
    // right moment; the loop it prevents is invisible from inside a run.
    const tool = getChatTool("update_issue")!;
    expect(tool.description).toMatch(/blocked/);
    expect(tool.description).toMatch(/wake you again/i);
    expect(tool.spec.input_schema.properties).toHaveProperty("status");
    expect(tool.spec.input_schema.properties).toHaveProperty("priority");
  });
});
