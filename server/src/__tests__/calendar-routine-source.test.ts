import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, routines, routineTriggers } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { routineCalendarSource } from "../services/calendar-sources.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine calendar source tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// A whole day in UTC, so a 9am daily cron lands exactly once inside it.
const FROM = new Date("2026-08-10T00:00:00.000Z");
const TO = new Date("2026-08-10T23:59:59.999Z");
const DAILY_9AM = "0 9 * * *";

describeEmbeddedPostgres("routine calendar source", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-calendar-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<string> {
    const [row] = await db
      .insert(companies)
      .values({ id: randomUUID(), name: "Industry Bureau LLC", issuePrefix: "IB" })
      .returning();
    companyId = row.id;
    return row.id;
  }

  async function seedRoutine(
    routine: Partial<typeof routines.$inferInsert> = {},
    trigger: Partial<typeof routineTriggers.$inferInsert> = {},
  ): Promise<string> {
    const id = await seedCompany();
    const [created] = await db
      .insert(routines)
      .values({ companyId: id, title: "Weekly invoice sweep", ...routine })
      .returning();
    await db.insert(routineTriggers).values({
      companyId: id,
      routineId: created.id,
      kind: "schedule",
      cronExpression: DAILY_9AM,
      timezone: "UTC",
      ...trigger,
    });
    return created.id;
  }

  function list() {
    return routineCalendarSource(db).listOccurrences(companyId, FROM, TO);
  }

  it("draws a scheduled routine on the calendar", async () => {
    const routineId = await seedRoutine();

    const occurrences = await list();

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({
      eventId: routineId,
      source: "routine",
      kind: "routine",
      title: "Weekly invoice sweep",
      notify: false,
      allDay: false,
    });
    expect(occurrences[0].start).toBe("2026-08-10T09:00:00.000Z");
  });

  // A paused routine will not run however good its cron looks, so showing it
  // would promise work that never happens.
  it("leaves out a routine that is not active", async () => {
    await seedRoutine({ status: "paused" });

    expect(await list()).toHaveLength(0);
  });

  it("leaves out a trigger that is switched off", async () => {
    await seedRoutine({}, { enabled: false });

    expect(await list()).toHaveLength(0);
  });

  // Webhook and api triggers fire when something outside calls in, so they
  // have no future date to draw.
  it("leaves out triggers that are not schedules", async () => {
    await seedRoutine({}, { kind: "webhook", cronExpression: null });

    expect(await list()).toHaveLength(0);
  });

  it("leaves out a schedule trigger with no cron expression", async () => {
    await seedRoutine({}, { cronExpression: null });

    expect(await list()).toHaveLength(0);
  });

  it("names the trigger when a routine has more than one schedule", async () => {
    const routineId = await seedRoutine({}, { label: "Morning" });
    await db.insert(routineTriggers).values({
      companyId,
      routineId,
      kind: "schedule",
      label: "Evening",
      cronExpression: "0 17 * * *",
      timezone: "UTC",
    });

    const occurrences = (await list()).sort((a, b) => a.start.localeCompare(b.start));

    expect(occurrences).toHaveLength(2);
    expect(occurrences[0].title).toBe("Weekly invoice sweep (Morning)");
    expect(occurrences[1].title).toBe("Weekly invoice sweep (Evening)");
    // Both point at the routine, so either click lands on the same page.
    expect(occurrences.every((occ) => occ.eventId === routineId)).toBe(true);
  });

  // The scheduler treats a missing timezone as UTC. If the drawing disagreed,
  // the calendar would show a different time than the one that actually fires.
  it("reads a missing timezone as UTC, matching the scheduler", async () => {
    await seedRoutine({}, { timezone: null });

    expect((await list())[0].start).toBe("2026-08-10T09:00:00.000Z");
  });

  it("honours the trigger's timezone", async () => {
    await seedRoutine({}, { timezone: "America/New_York" });

    // 9am New York in August is 13:00 UTC.
    expect((await list())[0].start).toBe("2026-08-10T13:00:00.000Z");
  });

  it("stays out of the way when the caller asked only for reminder kinds", async () => {
    await seedRoutine();

    const occurrences = await routineCalendarSource(db).listOccurrences(companyId, FROM, TO, {
      kinds: ["reminder"],
    });

    expect(occurrences).toHaveLength(0);
  });

  it("does not leak another company's routines", async () => {
    await seedRoutine();
    const otherCompany = randomUUID();

    const occurrences = await routineCalendarSource(db).listOccurrences(otherCompany, FROM, TO);

    expect(occurrences).toHaveLength(0);
  });
});
