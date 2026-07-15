import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  calendarEventDeliveries,
  calendarEvents,
  companies,
  createDb,
} from "@paperclipai/db";
import type { CreateCalendarEvent } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { calendarService } from "../services/calendar.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres calendar service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const OWNER_USER_ID = "user-owner";

describeEmbeddedPostgres("calendar service fire + delivery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-calendar-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(calendarEventDeliveries);
    await db.delete(calendarEvents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  function createInput(overrides: Partial<CreateCalendarEvent>): CreateCalendarEvent {
    return {
      title: "Reminder",
      kind: "reminder",
      timezone: "UTC",
      allDay: false,
      notify: true,
      channels: ["desktop"],
      leadTimeMinutes: 0,
      scheduleKind: "once",
      anchorAt: new Date(Date.now() + 3_600_000).toISOString(),
      ...overrides,
    } as CreateCalendarEvent;
  }

  it("fires exactly once under concurrent ticks (dedupe) and advances nextRunAt", async () => {
    const companyId = await seedCompany();
    const svc = calendarService(db);
    const anchor = new Date(Date.now() - 3 * 24 * 3_600_000);
    const event = await svc.create(
      companyId,
      createInput({
        title: "Standup",
        body: "Daily standup",
        channels: ["desktop"],
        scheduleKind: "interval",
        intervalUnit: "day",
        intervalCount: 1,
        timeOfDay: "09:00",
        anchorAt: anchor.toISOString(),
      }),
      { userId: OWNER_USER_ID, agentId: null },
    );

    // Force the reminder to be due in the past so the tick claims it.
    const dueAt = new Date(Date.now() - 3_600_000);
    await db.update(calendarEvents).set({ nextRunAt: dueAt }).where(eq(calendarEvents.id, event.id));

    const now = new Date();
    const [a, b] = await Promise.all([svc.tickDueEvents(now), svc.tickDueEvents(now)]);
    expect(a.fired + b.fired).toBe(1);

    const deliveries = await db
      .select()
      .from(calendarEventDeliveries)
      .where(eq(calendarEventDeliveries.eventId, event.id));
    const countByChannel = new Map<string, number>();
    for (const delivery of deliveries) {
      countByChannel.set(delivery.channel, (countByChannel.get(delivery.channel) ?? 0) + 1);
    }
    expect(countByChannel.get("desktop")).toBe(1);
    expect(countByChannel.get("in_app")).toBe(1);
    expect(deliveries.length).toBe(2);

    const [after] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, event.id));
    expect(after.status).toBe("active");
    expect(after.nextRunAt).not.toBeNull();
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(dueAt.getTime());
    expect(after.occurrenceCount).toBe(1);
  });

  it("fans out to desktop (pending), slack (failed without token), and in_app (delivered)", async () => {
    const companyId = await seedCompany();
    const svc = calendarService(db);
    const event = await svc.create(
      companyId,
      createInput({
        title: "Launch",
        channels: ["desktop", "slack"],
        slackTarget: "U123",
      }),
      { userId: OWNER_USER_ID, agentId: null },
    );

    await svc.fireNow(event.id);

    const deliveries = await db
      .select()
      .from(calendarEventDeliveries)
      .where(eq(calendarEventDeliveries.eventId, event.id));
    const byChannel = new Map(deliveries.map((delivery) => [delivery.channel, delivery]));

    expect(byChannel.get("desktop")?.status).toBe("pending");

    const slack = byChannel.get("slack");
    expect(slack?.status).toBe("failed");
    expect(slack?.failureReason).toContain("SLACK_BOT_TOKEN");

    const inApp = byChannel.get("in_app");
    expect(inApp?.status).toBe("delivered");
    expect(inApp?.deliveredAt).not.toBeNull();
  });

  it("completes a due one-time event after firing", async () => {
    const companyId = await seedCompany();
    const svc = calendarService(db);
    const anchor = new Date(Date.now() - 2 * 3_600_000);
    const event = await svc.create(
      companyId,
      createInput({
        title: "Renew license",
        kind: "deadline",
        channels: ["desktop"],
        scheduleKind: "once",
        anchorAt: anchor.toISOString(),
      }),
      { userId: OWNER_USER_ID, agentId: null },
    );

    // A past one-off yields a null nextRunAt on create; simulate it having been
    // scheduled and now due so the tick can fire and terminate it.
    await db.update(calendarEvents).set({ nextRunAt: anchor }).where(eq(calendarEvents.id, event.id));

    const result = await svc.tickDueEvents(new Date());
    expect(result.fired).toBe(1);

    const [after] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, event.id));
    expect(after.status).toBe("completed");
    expect(after.nextRunAt).toBeNull();

    const deliveries = await db
      .select()
      .from(calendarEventDeliveries)
      .where(eq(calendarEventDeliveries.eventId, event.id));
    expect(deliveries.length).toBeGreaterThan(0);
  });

  it("lists then acknowledges pending desktop notifications", async () => {
    const companyId = await seedCompany();
    const svc = calendarService(db);
    const event = await svc.create(
      companyId,
      createInput({ title: "Ping", channels: ["desktop"] }),
      { userId: OWNER_USER_ID, agentId: null },
    );

    await svc.fireNow(event.id);

    const pending = await svc.listPendingDesktopNotifications();
    const mine = pending.filter((notification) => notification.title === "Ping");
    expect(mine.length).toBe(1);
    const deliveryId = mine[0]!.id;

    const acknowledged = await svc.ackDesktopNotifications([deliveryId]);
    expect(acknowledged).toEqual([deliveryId]);

    const afterAck = await svc.listPendingDesktopNotifications();
    expect(afterAck.some((notification) => notification.id === deliveryId)).toBe(false);
  });
});
