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

  // A handful of 4x-daily routines put 40 entries on every day of the month
  // and buried every reminder behind "+20 more". At month scale the useful
  // fact is that the routine runs today, and how often.
  it("collapses a routine that fires several times a day into one entry", async () => {
    await seedRoutine({}, { cronExpression: "0 9,12,15,18 * * *" });

    const occurrences = await list();

    expect(occurrences).toHaveLength(1);
    // The count is its own field, not spelled into the title: a day cell
    // truncates the title, so a count living there was the first thing lost.
    expect(occurrences[0].title).toBe("Weekly invoice sweep");
    expect(occurrences[0].repeatsInDay).toBe(4);
    // Kept at the first firing of the day, so it sorts where the work starts.
    expect(occurrences[0].start).toBe("2026-08-10T09:00:00.000Z");
  });

  it("reports a once-a-day routine as firing once", async () => {
    await seedRoutine();

    const occurrence = (await list())[0];
    expect(occurrence.title).toBe("Weekly invoice sweep");
    expect(occurrence.repeatsInDay).toBe(1);
  });

  it("counts a day in the schedule's own timezone, not UTC", async () => {
    // 23:00 and 01:00 New York are the same NY day but two different UTC days.
    await seedRoutine({}, { cronExpression: "0 23,1 * * *", timezone: "America/New_York" });

    const occurrences = await routineCalendarSource(db).listOccurrences(
      companyId,
      new Date("2026-08-10T00:00:00.000Z"),
      new Date("2026-08-12T23:59:59.999Z"),
    );

    // New York's Aug 10 runs 01:00 (05:00 UTC on the 10th) and 23:00 (03:00
    // UTC on the 11th). Cut by UTC those are two separate days and would never
    // combine, so a single ×2 entry starting at the earlier one proves the day
    // boundary follows the schedule's timezone.
    const interiorDay = occurrences.find((occ) => occ.start === "2026-08-10T05:00:00.000Z");
    expect(interiorDay?.repeatsInDay).toBe(2);

    // Days clipped by the window edge honestly report only what falls inside.
    expect(occurrences.every((occ) => (occ.repeatsInDay ?? 1) <= 2)).toBe(true);
  });

  it("does not leak another company's routines", async () => {
    await seedRoutine();
    const otherCompany = randomUUID();

    const occurrences = await routineCalendarSource(db).listOccurrences(otherCompany, FROM, TO);

    expect(occurrences).toHaveLength(0);
  });
});
