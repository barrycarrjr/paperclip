import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  inboxDismissals,
  invites,
  joinRequests,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { inboxDismissalService } from "../services/inbox-dismissals.ts";
import { attentionQueueService } from "../services/attention-queue.ts";
import { summarizeAttentionForBadges } from "../routes/sidebar-badges.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres inbox dismissal tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("inbox dismissals", () => {
  let db!: ReturnType<typeof createDb>;
  let dismissalsSvc!: ReturnType<typeof inboxDismissalService>;
  let queueSvc!: ReturnType<typeof attentionQueueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-inbox-dismissals-");
    db = createDb(tempDb.connectionString);
    dismissalsSvc = inboxDismissalService(db);
    queueSvc = attentionQueueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(inboxDismissals);
    await db.delete(joinRequests);
    await db.delete(invites);
    await db.delete(heartbeatRuns);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("upserts a single dismissal record per user and inbox item key", async () => {
    const companyId = randomUUID();
    const userId = "board-user";
    const firstDismissedAt = new Date("2026-03-11T01:00:00.000Z");
    const secondDismissedAt = new Date("2026-03-11T02:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });

    await dismissalsSvc.dismiss(companyId, userId, "approval:approval-1", firstDismissedAt);
    await dismissalsSvc.dismiss(companyId, userId, "approval:approval-1", secondDismissedAt);

    const dismissals = await dismissalsSvc.list(companyId, userId);

    expect(dismissals).toHaveLength(1);
    expect(dismissals[0]?.itemKey).toBe("approval:approval-1");
    expect(new Date(dismissals[0]?.dismissedAt ?? 0).toISOString()).toBe(secondDismissedAt.toISOString());
  });

  it("honors dismissal timestamps and resurfaces approvals with newer activity", async () => {
    const companyId = randomUUID();
    const userId = "board-user";
    const primaryAgentId = randomUUID();
    const secondaryAgentId = randomUUID();
    const hiddenApprovalId = randomUUID();
    const resurfacedApprovalId = randomUUID();
    const inviteId = randomUUID();
    const hiddenJoinRequestId = randomUUID();
    const hiddenRunId = randomUUID();
    const visibleRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: primaryAgentId,
        companyId,
        name: "Primary",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: secondaryAgentId,
        companyId,
        name: "Secondary",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(approvals).values([
      {
        id: hiddenApprovalId,
        companyId,
        type: "hire_agent",
        status: "pending",
        payload: {},
        updatedAt: new Date("2026-03-11T01:00:00.000Z"),
      },
      {
        id: resurfacedApprovalId,
        companyId,
        type: "hire_agent",
        status: "revision_requested",
        payload: {},
        updatedAt: new Date("2026-03-11T03:00:00.000Z"),
      },
    ]);

    await db.insert(invites).values({
      id: inviteId,
      companyId,
      inviteType: "company_join",
      tokenHash: "hash-1",
      allowedJoinTypes: "both",
      expiresAt: new Date("2026-03-12T00:00:00.000Z"),
    });

    await db.insert(joinRequests).values({
      id: hiddenJoinRequestId,
      inviteId,
      companyId,
      requestType: "human",
      status: "pending_approval",
      requestIp: "127.0.0.1",
      createdAt: new Date("2026-03-11T01:00:00.000Z"),
      updatedAt: new Date("2026-03-11T01:00:00.000Z"),
    });

    // Recent, deliberately. A failure that has not happened again in a
    // fortnight is set aside as history, so fixed dates in the past would make
    // this test about staleness instead of about dismissals.
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await db.insert(heartbeatRuns).values([
      {
        id: hiddenRunId,
        companyId,
        agentId: primaryAgentId,
        invocationSource: "assignment",
        status: "failed",
        createdAt: threeHoursAgo,
        updatedAt: threeHoursAgo,
      },
      {
        id: visibleRunId,
        companyId,
        agentId: secondaryAgentId,
        invocationSource: "assignment",
        status: "timed_out",
        createdAt: anHourAgo,
        updatedAt: anHourAgo,
      },
    ]);

    await dismissalsSvc.dismiss(companyId, userId, `approval:${hiddenApprovalId}`, new Date("2026-03-11T02:00:00.000Z"));
    await dismissalsSvc.dismiss(companyId, userId, `approval:${resurfacedApprovalId}`, new Date("2026-03-11T02:00:00.000Z"));
    await dismissalsSvc.dismiss(companyId, userId, `join:${hiddenJoinRequestId}`, new Date("2026-03-11T02:00:00.000Z"));
    // A run failure is dismissed against the PROBLEM, not the run: an agent
    // that keeps failing mints a new run id every time, so the old `run:<id>`
    // key meant a dismissal lasted only until the next attempt.
    await dismissalsSvc.dismiss(
      companyId,
      userId,
      `run-group:${primaryAgentId}:no-issue`,
      new Date(Date.now() - 2 * 60 * 60 * 1000),
    );

    const dismissedAtByKey = new Map(
      (await dismissalsSvc.list(companyId, userId)).map((dismissal) => [
        dismissal.itemKey,
        new Date(dismissal.dismissedAt).getTime(),
      ]),
    );

    const { rows } = await queueSvc.listForCompany(companyId, {
      userId,
      canApproveJoins: true,
      dismissedAtByKey,
    });
    const badges = summarizeAttentionForBadges(rows);

    // inbox is 2, not 3: unread issues used to be added here and are not a
    // decision anyone has to make, so they no longer move the badge.
    expect(badges).toEqual({
      inbox: 2,
      approvals: 1,
      failedRuns: 1,
      joinRequests: 0,
    });
    // Dismissing now hides the row itself, not just the number, so the list
    // the operator opens matches the badge that sent them there.
    expect(rows.map((row) => row.key).sort()).toEqual(
      [`approval:${resurfacedApprovalId}`, `run-group:${secondaryAgentId}:no-issue`].sort(),
    );
    expect(rows.find((row) => row.kind === "run_failure")?.runId).toBe(visibleRunId);
  });

  it("sets aside a failure that stopped happening, and says how many", async () => {
    // The live case this came from: two rows had sat in "Awaiting your tap"
    // since the 31st of May, describing work nothing had attempted since, right
    // next to a row about the same agent failing forty-three times that week.
    const companyId = randomUUID();
    const userId = "board-user";
    const quietAgentId = randomUUID();
    const busyAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: quietAgentId,
        companyId,
        name: "Gone quiet",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: busyAgentId,
        companyId,
        name: "Still failing",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const justNow = new Date(Date.now() - 5 * 60 * 1000);
    await db.insert(heartbeatRuns).values([
      {
        id: randomUUID(),
        companyId,
        agentId: quietAgentId,
        invocationSource: "assignment",
        status: "failed",
        createdAt: longAgo,
        updatedAt: longAgo,
      },
      {
        id: randomUUID(),
        companyId,
        agentId: busyAgentId,
        invocationSource: "assignment",
        status: "failed",
        createdAt: justNow,
        updatedAt: justNow,
      },
    ]);

    const actor = { userId, canApproveJoins: true };
    const listed = await queueSvc.listForCompany(companyId, actor);
    expect(listed.rows.map((row) => row.title)).toEqual([
      "Still failing failed with no retry left",
    ]);
    expect(listed.setAside).toBe(1);

    // Set aside, never deleted. Asking brings it back.
    const withOlder = await queueSvc.listForCompany(companyId, actor, { includeSetAside: true });
    expect(withOlder.rows).toHaveLength(2);
    expect(withOlder.setAside).toBe(1);

    // And the badge counts only what is live, so a months-old failure cannot
    // keep a number on the sidebar forever.
    expect(summarizeAttentionForBadges(listed.rows).failedRuns).toBe(1);
  });

  it("keeps a snooze and a dismissal on one row without either clearing the other", async () => {
    // They share a row and both write through ON CONFLICT, so the set clauses
    // have to be disjoint. Nothing but a real upsert can prove that.
    const companyId = randomUUID();
    const userId = "board-user";
    const itemKey = `approval:${randomUUID()}`;
    const dismissedAt = new Date("2026-03-11T01:00:00.000Z");
    const snoozedUntil = new Date("2026-03-12T09:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });

    await dismissalsSvc.dismiss(companyId, userId, itemKey, dismissedAt);
    const afterSnooze = await dismissalsSvc.snooze(companyId, userId, itemKey, snoozedUntil);

    // Snoozing must not wipe the dismissal.
    expect(afterSnooze.dismissedAt.toISOString()).toBe(dismissedAt.toISOString());
    expect(afterSnooze.snoozedUntil?.toISOString()).toBe(snoozedUntil.toISOString());

    const laterDismissal = new Date("2026-03-11T05:00:00.000Z");
    const afterDismiss = await dismissalsSvc.dismiss(companyId, userId, itemKey, laterDismissal);

    // And dismissing again must not wipe the snooze.
    expect(afterDismiss.dismissedAt.toISOString()).toBe(laterDismissal.toISOString());
    expect(afterDismiss.snoozedUntil?.toISOString()).toBe(snoozedUntil.toISOString());

    const rows = await dismissalsSvc.list(companyId, userId);
    expect(rows).toHaveLength(1);
  });

  it("leaves the dismissal inert when a row exists only because of a snooze", async () => {
    // A snooze-first row has to store something in the NOT NULL dismissedAt.
    // Whatever it stores must never read as a real dismissal, or snoozing
    // something would silently dismiss it too.
    const companyId = randomUUID();
    const userId = "board-user";
    const itemKey = `question:${randomUUID()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });

    const row = await dismissalsSvc.snooze(
      companyId,
      userId,
      itemKey,
      new Date("2026-03-12T09:00:00.000Z"),
    );

    const hidden = await dismissalsSvc.loadHiddenByKey(companyId, userId);
    const dismissedAtMs = hidden.dismissedAtByKey.get(itemKey)!;
    // The dismissal rule is "dismissed at or after the item last changed", and
    // nothing in the product is older than the epoch.
    expect(dismissedAtMs).toBeLessThan(new Date("2000-01-01").getTime());
    expect(hidden.snoozedUntilByKey.get(itemKey)).toBe(row.snoozedUntil!.getTime());
  });

  it("lifts a snooze without disturbing the dismissal", async () => {
    const companyId = randomUUID();
    const userId = "board-user";
    const itemKey = `approval:${randomUUID()}`;
    const dismissedAt = new Date("2026-03-11T01:00:00.000Z");

        await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });

    await dismissalsSvc.dismiss(companyId, userId, itemKey, dismissedAt);
    await dismissalsSvc.snooze(companyId, userId, itemKey, new Date("2026-03-12T09:00:00.000Z"));
    const lifted = await dismissalsSvc.snooze(companyId, userId, itemKey, null);

    expect(lifted.snoozedUntil).toBeNull();
    expect(lifted.dismissedAt.toISOString()).toBe(dismissedAt.toISOString());

    const hidden = await dismissalsSvc.loadHiddenByKey(companyId, userId);
    expect(hidden.snoozedUntilByKey.has(itemKey)).toBe(false);
    expect(hidden.dismissedAtByKey.get(itemKey)).toBe(dismissedAt.getTime());
  });

});
