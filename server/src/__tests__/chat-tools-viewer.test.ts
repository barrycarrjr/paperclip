import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";

const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

const { CHAT_TOOLS, executeChatTool } = await import("../services/chat-tools.js");

/**
 * Clippy acts as the person chatting, so where they are only a viewer its own
 * tools read but change nothing, the same as the web app.
 */

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const REMINDER_ID = "33333333-3333-4333-8333-333333333333";

/** Every read finds one row in the company, so a tool gets as far as its access check. */
function dbWithRowInCompany(): Db {
  const rows = [{ id: ISSUE_ID, companyId: COMPANY_ID, name: "Acme", title: "Payroll" }];
  const query: Record<string, unknown> = {};
  for (const step of ["from", "where", "orderBy", "limit"]) query[step] = () => query;
  query.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return { select: () => query } as unknown as Db;
}

function ctxFor(role: string, opts: { isInstanceAdmin?: boolean } = {}) {
  return {
    db: dbWithRowInCompany(),
    actor: {
      userId: "user-1",
      isInstanceAdmin: opts.isInstanceAdmin ?? false,
      companyIds: [COMPANY_ID],
      memberships: [{ companyId: COMPANY_ID, membershipRole: role, status: "active" }],
    },
    defaultCompanyId: COMPANY_ID,
    chatSessionId: "sess-1",
  };
}

/** A valid call for each tool that changes something. */
const CHANGES: Record<string, unknown> = {
  create_issue: { title: "Chase the invoices" },
  update_issue: { issueId: ISSUE_ID, status: "done" },
  add_comment: { issueId: ISSUE_ID, body: "Done." },
  create_reminder: { title: "Run payroll", cadence: { kind: "once", at: "2026-11-03T09:00:00Z" } },
  cancel_reminder: { reminderId: REMINDER_ID },
  remember: { name: "Courier", content: "Use the blue van." },
  forget_memory: { name: "Courier" },
};

function pluginDispatcher() {
  const executeTool = vi.fn(async () => ({ result: { content: "called" } }));
  return { dispatcher: { executeTool } as unknown as PluginToolDispatcher, executeTool };
}

describe("Clippy's own tools for a viewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.create.mockResolvedValue({
      id: ISSUE_ID,
      identifier: "AC-1",
      companyId: COMPANY_ID,
      title: "Chase the invoices",
      status: "backlog",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdAt: new Date("2026-10-11T09:00:00.000Z"),
      updatedAt: new Date("2026-10-11T09:00:00.000Z"),
    });
  });

  it("covers every tool that changes something in a company, apart from the directive", () => {
    // broadcast_directive skips viewer companies itself; see the directive tests.
    const changing = CHAT_TOOLS.filter((t) => t.mutating && t.name !== "broadcast_directive").map((t) => t.name);
    expect(changing.sort()).toEqual(Object.keys(CHANGES).sort());
  });

  for (const [name, input] of Object.entries(CHANGES)) {
    it(`refuses ${name} where the person is only a viewer`, async () => {
      const result = await executeChatTool(name, input, ctxFor("viewer"));
      expect(result).toEqual({ ok: false, error: "Viewer access is read-only" });
      expect(mockIssueService.create).not.toHaveBeenCalled();
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });
  }

  it("still reads for a viewer", async () => {
    const result = await executeChatTool("get_company", { companyId: COMPANY_ID }, ctxFor("viewer"));
    expect(result.ok).toBe(true);
  });

  it("lets a member, and an instance admin who is only a viewer, make the change", async () => {
    for (const ctx of [ctxFor("member"), ctxFor("viewer", { isInstanceAdmin: true })]) {
      const result = await executeChatTool("create_issue", CHANGES.create_issue, ctx);
      expect(result.ok).toBe(true);
    }
    expect(mockIssueService.create).toHaveBeenCalledTimes(2);
  });

  it("runs no plugin tool where the person is only a viewer, as the web app's plugin route refuses them", async () => {
    const { dispatcher, executeTool } = pluginDispatcher();
    const refused = await executeChatTool("demo__ping", {}, ctxFor("viewer"), dispatcher);
    expect(refused).toEqual({ ok: false, error: "Viewer access is read-only" });
    expect(executeTool).not.toHaveBeenCalled();

    const allowed = await executeChatTool("demo__ping", {}, ctxFor("member"), dispatcher);
    expect(allowed).toEqual({ ok: true, result: "called" });
    expect(executeTool).toHaveBeenCalledTimes(1);
  });
});
