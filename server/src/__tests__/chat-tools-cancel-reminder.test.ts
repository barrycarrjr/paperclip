import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const calendar = vi.hoisted(() => ({ getById: vi.fn(), update: vi.fn() }));

vi.mock("../services/calendar.js", () => ({
  calendarService: () => calendar,
}));

const { executeChatTool } = await import("../services/chat-tools.js");

/**
 * Clippy cancels only the person's own reminders, as the web app allows, so a
 * colleague's reminder stays put. An instance admin keeps the allowance
 * Clippy's tools give them.
 */

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const REMINDER_ID = "33333333-3333-4333-8333-333333333333";

function ctxFor(userId: string, opts: { isInstanceAdmin?: boolean } = {}) {
  return {
    db: {} as Db,
    actor: {
      userId,
      isInstanceAdmin: opts.isInstanceAdmin ?? false,
      companyIds: [COMPANY_ID],
      memberships: [{ companyId: COMPANY_ID, membershipRole: "operator", status: "active" }],
    },
    defaultCompanyId: COMPANY_ID,
  };
}

function reminderOwnedBy(userId: string) {
  return { id: REMINDER_ID, companyId: COMPANY_ID, userId, title: "Run payroll", status: "active" };
}

describe("cancel_reminder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calendar.getById.mockResolvedValue(reminderOwnedBy("user-ann"));
    calendar.update.mockResolvedValue({ ...reminderOwnedBy("user-ann"), status: "cancelled" });
  });

  it("refuses someone else's reminder, as the web app does", async () => {
    const result = await executeChatTool("cancel_reminder", { reminderId: REMINDER_ID }, ctxFor("user-ben"));
    expect(result).toEqual({ ok: false, error: "You can only modify your own reminders" });
    expect(calendar.update).not.toHaveBeenCalled();
  });

  it("cancels the person's own reminder, and an agent run's own", async () => {
    const own = await executeChatTool("cancel_reminder", { reminderId: REMINDER_ID }, ctxFor("user-ann"));
    expect(own.ok).toBe(true);
    expect(calendar.update).toHaveBeenCalledWith(
      REMINDER_ID,
      { status: "cancelled" },
      { userId: "user-ann", agentId: null },
    );

    // A reminder an agent made through these tools is owned by its run's actor.
    calendar.getById.mockResolvedValue(reminderOwnedBy("agent:a1"));
    const agentRun = await executeChatTool("cancel_reminder", { reminderId: REMINDER_ID }, ctxFor("agent:a1"));
    expect(agentRun.ok).toBe(true);
  });

  it("keeps the instance admin's allowance", async () => {
    const result = await executeChatTool(
      "cancel_reminder",
      { reminderId: REMINDER_ID },
      ctxFor("user-owner", { isInstanceAdmin: true }),
    );
    expect(result.ok).toBe(true);
    expect(calendar.update).toHaveBeenCalledTimes(1);
  });
});
