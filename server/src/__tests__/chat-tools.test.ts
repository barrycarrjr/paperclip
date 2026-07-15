import { describe, expect, it } from "vitest";
import {
  CHAT_TOOLS,
  executeChatTool,
  getChatTool,
  listChatToolSpecs,
} from "../services/chat-tools.js";
import type { Db } from "@paperclipai/db";

function createDbStub(): Db {
  // The minimal pieces the read tools touch. Returning empty arrays everywhere
  // keeps the tests focused on the wiring/authz path rather than data shape.
  const stub = {
    select() {
      return {
        from() {
          return {
            where() {
              return Promise.resolve([]);
            },
            limit() {
              return Promise.resolve([]);
            },
          };
        },
      };
    },
  } as unknown as Db;
  return stub;
}

/**
 * A db stub that captures the values passed to `insert(...).values(...)` so
 * tests can assert how a tool maps its input onto the calendar payload,
 * without a real database.
 */
function createCapturingDb(captured: { values?: Record<string, unknown> }): Db {
  const stub = {
    insert() {
      return {
        values(v: Record<string, unknown>) {
          captured.values = v;
          return {
            returning() {
              return Promise.resolve([{ ...v, id: "evt-1" }]);
            },
          };
        },
      };
    },
  } as unknown as Db;
  return stub;
}

describe("chat-tools registry", () => {
  it("listChatToolSpecs returns one spec per tool", () => {
    const specs = listChatToolSpecs();
    expect(specs.length).toBe(CHAT_TOOLS.length);
    for (const spec of specs) {
      expect(typeof spec.name).toBe("string");
      expect(typeof spec.description).toBe("string");
      expect(spec.input_schema.type).toBe("object");
    }
  });

  it("read tools are not flagged mutating", () => {
    for (const name of [
      "list_companies",
      "get_company",
      "list_agents",
      "get_agent",
      "list_issues",
      "get_issue",
    ]) {
      const tool = getChatTool(name);
      expect(tool, `tool ${name} should exist`).toBeDefined();
      expect(tool!.mutating).toBe(false);
    }
  });

  it("mutating tools are flagged mutating", () => {
    for (const name of ["create_issue", "add_comment"]) {
      const tool = getChatTool(name);
      expect(tool, `tool ${name} should exist`).toBeDefined();
      expect(tool!.mutating).toBe(true);
    }
  });

  it("rejects unknown tool names", async () => {
    const result = await executeChatTool(
      "no_such_tool",
      {},
      { db: createDbStub(), actor: { userId: "u1", isInstanceAdmin: false, companyIds: [] }, defaultCompanyId: null },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Unknown tool/);
  });

  it("rejects calls outside the actor's company scope", async () => {
    const result = await executeChatTool(
      "get_company",
      { companyId: "11111111-1111-1111-1111-111111111111" },
      {
        db: createDbStub(),
        actor: { userId: "u1", isInstanceAdmin: false, companyIds: ["other-id"] },
        defaultCompanyId: null,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/access/i);
  });

  it("validates input via the per-tool zod schema", async () => {
    const result = await executeChatTool(
      "create_issue",
      { title: "" }, // empty title fails min(1)
      {
        db: createDbStub(),
        actor: { userId: "u1", isInstanceAdmin: true, companyIds: [] },
        defaultCompanyId: "11111111-1111-1111-1111-111111111111",
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Invalid input/);
  });

  it("web_fetch is registered as a non-mutating tool", () => {
    const tool = getChatTool("web_fetch");
    expect(tool).toBeDefined();
    expect(tool!.mutating).toBe(false);
  });

  it("web_fetch rejects non-http(s) URLs", async () => {
    const result = await executeChatTool(
      "web_fetch",
      { url: "file:///etc/passwd" },
      {
        db: createDbStub(),
        actor: { userId: "u1", isInstanceAdmin: true, companyIds: [] },
        defaultCompanyId: null,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/scheme/i);
  });

  it("web_fetch rejects loopback IP literals", async () => {
    const result = await executeChatTool(
      "web_fetch",
      { url: "http://127.0.0.1/" },
      {
        db: createDbStub(),
        actor: { userId: "u1", isInstanceAdmin: true, companyIds: [] },
        defaultCompanyId: null,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/private IP|Blocked/i);
  });

  it("web_fetch rejects 'localhost' and private-network host strings", async () => {
    const result = await executeChatTool(
      "web_fetch",
      { url: "http://localhost:8080/admin" },
      {
        db: createDbStub(),
        actor: { userId: "u1", isInstanceAdmin: true, companyIds: [] },
        defaultCompanyId: null,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Blocked host/);
  });

  it("set_secret tool result must never include the value (regression guard)", () => {
    // Our chat-tools registry intentionally does NOT include a set_secret tool yet
    // (deferred to a follow-up), so the registry should not surface the name.
    // If/when set_secret lands, this test should be tightened to assert that
    // the handler returns only { ok, name } and never echoes the value.
    expect(getChatTool("set_secret")).toBeUndefined();
  });

  it("plugin tool drafted via the trust-loop gate surfaces the human-readable guidance to the LLM", async () => {
    // When the dispatcher's draft gate intercepts a mutating outbound call it
    // returns BOTH `content` (the human-readable "do not retry — end your
    // turn" instruction) and `data` (`{drafted: true, approvalId, ...}`).
    // The chat-tools wrapper used to prefer `data` unconditionally, which
    // hid the guidance from the model and caused Clippy to re-fire the same
    // tool on the next loop iteration — a fresh pending approval would
    // appear every time the user resolved the previous one.
    const dispatcher = {
      executeTool: async () => ({
        pluginId: "3cx-tools",
        toolName: "3cx-tools:pbx_click_to_call",
        result: {
          content: [
            "[paperclip:tool-draft] queued for human approval",
            "Tool: 3cx-tools:pbx_click_to_call",
            "Approval ID: approval-1",
            "",
            "The user must approve this draft before it executes. Do not retry the tool. Tell the user it is queued and end your turn — you will not be woken when they approve.",
          ].join("\n"),
          data: {
            drafted: true,
            approvalId: "approval-1",
            status: "pending",
            tool: "3cx-tools:pbx_click_to_call",
            summary: "to 7175771023",
          },
        },
      }),
    } as unknown as Parameters<typeof executeChatTool>[3];

    const outcome = await executeChatTool(
      "3cx-tools__pbx_click_to_call",
      { toNumber: "7175771023", fromExtension: "200" },
      {
        db: createDbStub(),
        actor: { userId: "u1", isInstanceAdmin: true, companyIds: [] },
        defaultCompanyId: "11111111-1111-1111-1111-111111111111",
      },
      dispatcher,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(typeof outcome.result).toBe("string");
    expect(outcome.result as string).toMatch(/\[paperclip:tool-draft\]/);
    expect(outcome.result as string).toMatch(/Do not retry the tool/);
  });

  it("plugin tool that returned structured data without `drafted: true` keeps the data shape", async () => {
    // Sanity check: non-drafted plugin tools should still surface the
    // structured `data` field, since that's what the LLM is wired against.
    const dispatcher = {
      executeTool: async () => ({
        pluginId: "demo",
        toolName: "demo:list_things",
        result: {
          content: "human readable",
          data: { things: [{ id: 1 }] },
        },
      }),
    } as unknown as Parameters<typeof executeChatTool>[3];

    const outcome = await executeChatTool(
      "demo__list_things",
      {},
      {
        db: createDbStub(),
        actor: { userId: "u1", isInstanceAdmin: true, companyIds: [] },
        defaultCompanyId: "11111111-1111-1111-1111-111111111111",
      },
      dispatcher,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result).toEqual({ things: [{ id: 1 }] });
  });

  it("reminder tools are registered with correct mutating flags", () => {
    expect(getChatTool("create_reminder")?.mutating).toBe(true);
    expect(getChatTool("cancel_reminder")?.mutating).toBe(true);
    expect(getChatTool("list_reminders")?.mutating).toBe(false);
  });

  it("create_reminder maps 'every 2 weeks' onto an interval calendar payload", async () => {
    const captured: { values?: Record<string, unknown> } = {};
    const result = await executeChatTool(
      "create_reminder",
      {
        title: "Run payroll",
        cadence: { kind: "interval", every: 2, unit: "week" },
        timezone: "UTC",
      },
      {
        db: createCapturingDb(captured),
        actor: { userId: "u1", isInstanceAdmin: true, companyIds: [] },
        defaultCompanyId: "11111111-1111-1111-1111-111111111111",
      },
    );
    expect(result.ok).toBe(true);
    expect(captured.values).toBeDefined();
    expect(captured.values).toMatchObject({
      kind: "reminder",
      scheduleKind: "interval",
      intervalUnit: "week",
      intervalCount: 2,
      timeOfDay: "09:00",
      notify: true,
      timezone: "UTC",
    });
    // Default channel is desktop. The service normalizes the ISO anchor into a
    // Date; it should land on today at 09:00 UTC (the default time-of-day).
    expect(captured.values!.channels).toEqual(["desktop"]);
    expect(captured.values!.anchorAt).toBeInstanceOf(Date);
    expect((captured.values!.anchorAt as Date).toISOString()).toMatch(/T09:00:00\.000Z$/);
    // computeNextRun ran and produced a concrete next fire.
    expect(captured.values!.nextRunAt).toBeInstanceOf(Date);
  });

  it("create_reminder rejects an interval cadence missing its unit", async () => {
    const result = await executeChatTool(
      "create_reminder",
      { title: "x", cadence: { kind: "interval", every: 2 } },
      {
        db: createDbStub(),
        actor: { userId: "u1", isInstanceAdmin: true, companyIds: [] },
        defaultCompanyId: "11111111-1111-1111-1111-111111111111",
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unit/i);
  });

  it("create_reminder rejects a once cadence with no 'at'", async () => {
    const result = await executeChatTool(
      "create_reminder",
      { title: "x", cadence: { kind: "once" } },
      {
        db: createDbStub(),
        actor: { userId: "u1", isInstanceAdmin: true, companyIds: [] },
        defaultCompanyId: "11111111-1111-1111-1111-111111111111",
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/at\b|datetime/i);
  });

  it("cancel_reminder rejects an id that is not in the current company", async () => {
    // The stub's select().where() resolves to [] so getById returns null.
    const result = await executeChatTool(
      "cancel_reminder",
      { reminderId: "22222222-2222-2222-2222-222222222222" },
      {
        db: createDbStub(),
        actor: { userId: "u1", isInstanceAdmin: true, companyIds: [] },
        defaultCompanyId: "11111111-1111-1111-1111-111111111111",
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not found/i);
  });
});
