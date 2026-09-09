import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  projects,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { getZonedMinuteParts } from "../services/cron.ts";
import { routineService } from "../services/routines.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine timezone tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * The time zone on a scheduled trigger decides what "9am" means, and it used to
 * be taken from whichever browser created the automation and never shown again.
 * These tests pin the two halves of making it visible and choosable:
 *
 *  - a zone a person picks is the zone that gets stored and scheduled from, and
 *  - an automation that already exists keeps firing at exactly the same hour
 *    when it is saved again, whatever zone the machine doing the saving is in.
 */
describeEmbeddedPostgres("scheduled routine time zones", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-timezone-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRoutine() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Automations",
      status: "in_progress",
    });

    const svc = routineService(db, { heartbeat: { wakeup: async () => null } });
    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "Morning report",
        description: "Runs every morning",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    return { routine, svc };
  }

  /** The wall-clock hour and minute a run will land on, read in `timeZone`. */
  function firingClock(nextRunAt: Date | null, timeZone: string) {
    expect(nextRunAt).not.toBeNull();
    const parts = getZonedMinuteParts(nextRunAt!, timeZone);
    return { hour: parts.hour, minute: parts.minute };
  }

  it("stores the time zone the person chose and schedules from it", async () => {
    const { routine, svc } = await seedRoutine();

    const { trigger } = await svc.createTrigger(
      routine.id,
      { kind: "schedule", cronExpression: "0 9 * * *", timezone: "America/New_York", enabled: true },
      {},
    );

    expect(trigger.timezone).toBe("America/New_York");
    expect(firingClock(trigger.nextRunAt, "America/New_York")).toEqual({ hour: 9, minute: 0 });
  });

  it("keeps two automations on different zones apart", async () => {
    const { routine, svc } = await seedRoutine();

    const newYork = await svc.createTrigger(
      routine.id,
      { kind: "schedule", cronExpression: "0 9 * * *", timezone: "America/New_York", enabled: true },
      {},
    );
    const tokyo = await svc.createTrigger(
      routine.id,
      { kind: "schedule", cronExpression: "0 9 * * *", timezone: "Asia/Tokyo", enabled: true },
      {},
    );

    expect(firingClock(newYork.trigger.nextRunAt, "America/New_York")).toEqual({ hour: 9, minute: 0 });
    expect(firingClock(tokyo.trigger.nextRunAt, "Asia/Tokyo")).toEqual({ hour: 9, minute: 0 });
    // Same cron, same "9am", genuinely different moments.
    expect(newYork.trigger.nextRunAt!.getTime()).not.toBe(tokyo.trigger.nextRunAt!.getTime());
  });

  it("does not move an existing automation's firing time when it is saved again", async () => {
    const { routine, svc } = await seedRoutine();

    const created = await svc.createTrigger(
      routine.id,
      { kind: "schedule", cronExpression: "0 9 * * *", timezone: "America/New_York", enabled: true },
      {},
    );
    const before = firingClock(created.trigger.nextRunAt, "America/New_York");

    // Exactly what the routine detail page sends after a rename: the label the
    // person typed, plus the schedule and zone the editor was showing, which it
    // read off the trigger itself rather than off the browser.
    const saved = await svc.updateTrigger(
      created.trigger.id,
      {
        label: "Renamed by somebody in Tokyo",
        cronExpression: created.trigger.cronExpression!,
        timezone: created.trigger.timezone!,
      },
      {},
    );

    expect(saved?.timezone).toBe("America/New_York");
    expect(firingClock(saved?.nextRunAt ?? null, "America/New_York")).toEqual(before);
    expect(before).toEqual({ hour: 9, minute: 0 });
  });

  it("leaves the zone alone when a save says nothing about it", async () => {
    const { routine, svc } = await seedRoutine();

    const created = await svc.createTrigger(
      routine.id,
      { kind: "schedule", cronExpression: "0 9 * * *", timezone: "America/New_York", enabled: true },
      {},
    );

    const saved = await svc.updateTrigger(created.trigger.id, { label: "Renamed" }, {});

    expect(saved?.timezone).toBe("America/New_York");
    expect(firingClock(saved?.nextRunAt ?? null, "America/New_York")).toEqual({ hour: 9, minute: 0 });
  });

  it("moves the firing time only when the person picks a different zone", async () => {
    const { routine, svc } = await seedRoutine();

    const created = await svc.createTrigger(
      routine.id,
      { kind: "schedule", cronExpression: "0 9 * * *", timezone: "America/New_York", enabled: true },
      {},
    );

    const saved = await svc.updateTrigger(
      created.trigger.id,
      { cronExpression: "0 9 * * *", timezone: "Europe/London" },
      {},
    );

    expect(saved?.timezone).toBe("Europe/London");
    expect(firingClock(saved?.nextRunAt ?? null, "Europe/London")).toEqual({ hour: 9, minute: 0 });
    expect(saved?.nextRunAt!.getTime()).not.toBe(created.trigger.nextRunAt!.getTime());
  });
});
