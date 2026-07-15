import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  calendarEventDeliveries,
  calendarEvents,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { calendarRoutes } from "../routes/calendar.js";
import { internalNotificationRoutes } from "../routes/internal-notifications.js";

/**
 * HTTP-level (supertest) runtime verification of the calendar/event routes.
 *
 * Harness: this is the union of the two in-repo models the task points at.
 *   - DB lifecycle + company seed come from `calendar-service.test.ts` (real
 *     embedded Postgres via `@paperclipai/db`, per-test row cleanup).
 *   - App builder + actor injection come from the route tests
 *     (`issue-agent-mutation-ownership-routes.test.ts`,
 *     `company-branding-route.test.ts`): an Express app with `express.json()`,
 *     a middleware that stamps `req.actor`, the real router, and `errorHandler`.
 *
 * The routers are mounted UN-mocked against the real db, so `nextRunAt`,
 * calendar occurrence expansion, and desktop-notification deliveries are
 * genuinely computed by the real services -- this exercises routing, the
 * `validate` middleware, and the authz gates end to end.
 *
 * Owner-only authz is driven with two DISTINCT `tool_session` actors (both
 * user-driven, different `userId`s, same company): the calendar routes key
 * ownership off `calendar_events.user_id`, so this is a real two-user test and
 * did NOT need the single-actor fallback described in the task.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres calendar route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const USER_A = "user-a";
const USER_B = "user-b";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describeEmbeddedPostgres("calendar + event routes (HTTP)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-calendar-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // activity_log.company_id references companies with no cascade, so it must
    // be cleared before companies. Deliveries + events cascade from companies
    // but are deleted explicitly to mirror the calendar-service test.
    await db.delete(activityLog);
    await db.delete(calendarEventDeliveries);
    await db.delete(calendarEvents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(opts: { isPortfolioRoot?: boolean } = {}) {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      isPortfolioRoot: opts.isPortfolioRoot ?? false,
    });
    return companyId;
  }

  /** A user-driven actor (Clippy-style tool session) scoped to one company. */
  function toolSessionActor(
    userId: string,
    companyId: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return { type: "tool_session", userId, companyId, source: "tool_session", ...extra };
  }

  /** An agent (non-user-driven) actor scoped to one company. */
  function agentActor(companyId: string): Record<string, unknown> {
    return {
      type: "agent",
      agentId: randomUUID(),
      companyId,
      source: "agent_key",
      runId: randomUUID(),
    };
  }

  function createApp(actor: Record<string, unknown>, opts: { remoteAddress?: string } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      // Let a test pin the TCP peer address so the loopback exemption on the
      // internal desktop-notification routes can be exercised both ways.
      if (opts.remoteAddress) {
        Object.defineProperty(req.socket, "remoteAddress", {
          value: opts.remoteAddress,
          configurable: true,
        });
      }
      next();
    });
    app.use("/api", calendarRoutes(db));
    app.use("/api", internalNotificationRoutes(db));
    app.use(errorHandler);
    return app;
  }

  // --- 1. Create + read (happy path) ------------------------------------------

  it("creates an interval reminder (201, nextRunAt + owner set) and reads it back", async () => {
    const companyId = await seedCompany();
    const app = createApp(toolSessionActor(USER_A, companyId));

    // Anchor + window sit fully inside America/New_York EDT (Aug-Oct 2026), so
    // every occurrence is at 09:00 local == 13:00 UTC and consecutive occurrences
    // are exactly 14 days apart with no daylight-saving shift to reason about.
    const anchorAt = "2026-08-03T09:00:00-04:00";

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/events`)
      .send({
        title: "Biweekly standup",
        kind: "reminder",
        scheduleKind: "interval",
        intervalUnit: "week",
        intervalCount: 2,
        timeOfDay: "09:00",
        timezone: "America/New_York",
        channels: ["desktop"],
        anchorAt,
      });

    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const eventId = createRes.body.id as string;
    expect(eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(createRes.body.userId).toBe(USER_A);
    expect(createRes.body.nextRunAt).toBeTruthy();
    expect(Number.isNaN(new Date(createRes.body.nextRunAt).getTime())).toBe(false);
    expect(createRes.body.status).toBe("active");

    const listRes = await request(app).get(`/api/companies/${companyId}/events`);
    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body.events)).toBe(true);
    expect(listRes.body.events.map((e: { id: string }) => e.id)).toContain(eventId);

    const calRes = await request(app)
      .get(`/api/companies/${companyId}/calendar`)
      .query({ from: "2026-08-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" });
    expect(calRes.status).toBe(200);
    const mine = (calRes.body.occurrences as Array<{ eventId: string; start: string }>).filter(
      (o) => o.eventId === eventId,
    );
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.length).toBeGreaterThanOrEqual(2);
    const starts = mine.map((o) => new Date(o.start));
    for (const start of starts) {
      // 09:00 America/New_York in EDT == 13:00 UTC.
      expect(start.getUTCHours()).toBe(13);
      expect(start.getUTCMinutes()).toBe(0);
    }
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i]!.getTime() - starts[i - 1]!.getTime()).toBe(14 * MS_PER_DAY);
    }
  });

  // --- 2. Validation 400 ------------------------------------------------------

  it("rejects an interval event missing intervalUnit (400 Validation error)", async () => {
    const companyId = await seedCompany();
    const app = createApp(toolSessionActor(USER_A, companyId));

    const res = await request(app)
      .post(`/api/companies/${companyId}/events`)
      .send({
        title: "Broken interval",
        scheduleKind: "interval",
        // intervalUnit intentionally omitted
        intervalCount: 2,
        timeOfDay: "09:00",
        timezone: "America/New_York",
        channels: ["desktop"],
        anchorAt: "2026-08-03T09:00:00-04:00",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
  });

  it("rejects a slack-channel event with no slackTarget (400 Validation error)", async () => {
    const companyId = await seedCompany();
    const app = createApp(toolSessionActor(USER_A, companyId));

    const res = await request(app)
      .post(`/api/companies/${companyId}/events`)
      .send({
        title: "Slack without target",
        scheduleKind: "once",
        channels: ["slack"],
        // slackTarget intentionally omitted
        anchorAt: "2026-08-03T09:00:00-04:00",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
  });

  // --- 3. Owner-only 403 (two distinct users) --------------------------------

  it("enforces owner-only PATCH/DELETE across two distinct users", async () => {
    const companyId = await seedCompany();
    const ownerApp = createApp(toolSessionActor(USER_A, companyId));
    const otherApp = createApp(toolSessionActor(USER_B, companyId));

    const createRes = await request(ownerApp)
      .post(`/api/companies/${companyId}/events`)
      .send({
        title: "Owned reminder",
        scheduleKind: "once",
        channels: ["desktop"],
        anchorAt: "2026-08-03T09:00:00-04:00",
      });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const eventId = createRes.body.id as string;

    // User B (a real, different user) cannot manage user A's reminder.
    const patchByB = await request(otherApp)
      .patch(`/api/events/${eventId}`)
      .send({ title: "hijacked" });
    expect(patchByB.status).toBe(403);
    expect(patchByB.body.error).toBe("You can only modify your own reminders");

    const deleteByB = await request(otherApp).delete(`/api/events/${eventId}`);
    expect(deleteByB.status).toBe(403);
    expect(deleteByB.body.error).toBe("You can only modify your own reminders");

    // The owner succeeds at both.
    const patchByOwner = await request(ownerApp)
      .patch(`/api/events/${eventId}`)
      .send({ title: "renamed by owner" });
    expect(patchByOwner.status).toBe(200);
    expect(patchByOwner.body.title).toBe("renamed by owner");

    const deleteByOwner = await request(ownerApp).delete(`/api/events/${eventId}`);
    expect(deleteByOwner.status).toBe(204);

    const detailAfterDelete = await request(ownerApp).get(`/api/events/${eventId}`);
    expect(detailAfterDelete.status).toBe(404);
  });

  it("refuses event creation by a non-user-driven agent actor (403)", async () => {
    const companyId = await seedCompany();
    const app = createApp(agentActor(companyId));

    const res = await request(app)
      .post(`/api/companies/${companyId}/events`)
      .send({
        title: "Agent-made reminder",
        scheduleKind: "once",
        channels: ["desktop"],
        anchorAt: "2026-08-03T09:00:00-04:00",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Reminders can only be created by a user");
  });

  // --- 4. Desktop notification queue -----------------------------------------

  it("fires an event, lists the pending desktop notification, then acks it away", async () => {
    const companyId = await seedCompany();
    const app = createApp(toolSessionActor(USER_A, companyId));
    const title = `Desktop tray ping ${randomUUID()}`;

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/events`)
      .send({
        title,
        scheduleKind: "once",
        channels: ["desktop"],
        anchorAt: "2026-08-03T09:00:00-04:00",
      });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const eventId = createRes.body.id as string;

    const fireRes = await request(app).post(`/api/events/${eventId}/fire`);
    expect(fireRes.status).toBe(200);
    expect(fireRes.body).toEqual({ ok: true });

    const pendingRes = await request(app)
      .get("/api/internal/desktop-notifications/pending")
      .query({ limit: 20 });
    expect(pendingRes.status).toBe(200);
    const mine = (pendingRes.body.notifications as Array<{ id: string; title: string }>).filter(
      (n) => n.title === title,
    );
    expect(mine.length).toBe(1);
    const deliveryId = mine[0]!.id;

    const ackRes = await request(app)
      .post("/api/internal/desktop-notifications/ack")
      .send({ ids: [deliveryId] });
    expect(ackRes.status).toBe(200);
    expect(ackRes.body.acknowledged).toEqual([deliveryId]);

    const afterAckRes = await request(app)
      .get("/api/internal/desktop-notifications/pending")
      .query({ limit: 20 });
    expect(afterAckRes.status).toBe(200);
    expect(
      (afterAckRes.body.notifications as Array<{ id: string }>).some((n) => n.id === deliveryId),
    ).toBe(false);
  });

  it("refuses desktop-notification access for a non-user-driven agent actor (403)", async () => {
    const companyId = await seedCompany();
    const app = createApp(agentActor(companyId));

    const res = await request(app).get("/api/internal/desktop-notifications/pending");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Desktop notifications are only available to the local user");
  });

  it("allows the local desktop tray (tokenless loopback) to poll and ack in authenticated mode", async () => {
    const companyId = await seedCompany();
    // Seed a pending desktop delivery as a normal user.
    const userApp = createApp(toolSessionActor(USER_A, companyId));
    const title = `Tray loopback ${randomUUID()}`;
    const createRes = await request(userApp)
      .post(`/api/companies/${companyId}/events`)
      .send({ title, scheduleKind: "once", channels: ["desktop"], anchorAt: "2026-08-03T09:00:00-04:00" });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    expect((await request(userApp).post(`/api/events/${createRes.body.id}/fire`)).status).toBe(200);

    // The tray presents no auth token (actor.type "none") and polls over
    // loopback -> the exemption lets it read and ack without a login.
    const trayApp = createApp({ type: "none", source: "none" }, { remoteAddress: "127.0.0.1" });
    const pendingRes = await request(trayApp).get("/api/internal/desktop-notifications/pending");
    expect(pendingRes.status).toBe(200);
    const mine = (pendingRes.body.notifications as Array<{ id: string; title: string }>).filter(
      (n) => n.title === title,
    );
    expect(mine.length).toBe(1);

    const ackRes = await request(trayApp)
      .post("/api/internal/desktop-notifications/ack")
      .send({ ids: [mine[0]!.id] });
    expect(ackRes.status).toBe(200);
    expect(ackRes.body.acknowledged).toEqual([mine[0]!.id]);
  });

  it("still rejects a tokenless NON-loopback caller on the desktop endpoint (401)", async () => {
    // Same tokenless actor, but not from loopback -> the exemption must not apply.
    const app = createApp({ type: "none", source: "none" }, { remoteAddress: "203.0.113.7" });
    const res = await request(app).get("/api/internal/desktop-notifications/pending");
    expect(res.status).toBe(401);
  });

  // --- 5. Portfolio gating ----------------------------------------------------

  it("returns 403 for portfolio-events on a NON-portfolio-root company", async () => {
    const companyId = await seedCompany({ isPortfolioRoot: false });
    // Actor DOES have portfolio-root access, so the 403 is specifically the
    // "not the portfolio root company" gate, not an access failure.
    const app = createApp(toolSessionActor(USER_A, companyId, { isPortfolioRootAgent: true }));

    const res = await request(app).get(`/api/companies/${companyId}/portfolio-events`);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("portfolio root");
  });

  it("returns 403 for portfolio-events on the root company without portfolio access", async () => {
    const companyId = await seedCompany({ isPortfolioRoot: true });
    // Root company, but this actor lacks portfolio-root access.
    const app = createApp(toolSessionActor(USER_A, companyId, { isPortfolioRootAgent: false }));

    const res = await request(app).get(`/api/companies/${companyId}/portfolio-events`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Portfolio root access required");
  });

  it("returns 200 for portfolio-events on the root company with portfolio access", async () => {
    const companyId = await seedCompany({ isPortfolioRoot: true });
    const app = createApp(toolSessionActor(USER_A, companyId, { isPortfolioRootAgent: true }));

    const res = await request(app).get(`/api/companies/${companyId}/portfolio-events`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(Array.isArray(res.body.companies)).toBe(true);
    expect(res.body.companies.map((c: { id: string }) => c.id)).toContain(companyId);
  });
});
