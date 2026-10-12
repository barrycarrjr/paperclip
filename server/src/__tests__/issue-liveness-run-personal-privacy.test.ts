import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// The Run wakes the agent that owns each recovery task it makes. Nothing may
// really run on this machine, so every adapter answers at once.
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Acknowledged liveness escalation.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { runningProcesses } from "../adapters/index.ts";
import { errorHandler } from "../middleware/index.js";
import { instanceSettingsRoutes } from "../routes/instance-settings.js";
import { loadPersonalCompanyIndex } from "../services/personal-companies.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stuck-task run privacy tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// The owner of this instance is an instance admin and owns his own Personal.
// Bob owns another Personal. Carol is an instance admin with no seat anywhere.
const OWNER = "user-owner";
const BOB = "user-bob";
const CAROL = "user-carol";
const RUN_ACTION = "instance.settings.issue_graph_liveness_auto_recovery_run";

/**
 * The Run button beside the stuck-task preview makes recovery tasks in every
 * company and retires ones no longer needed. The preview hides someone else's
 * Personal company, counts included, so the Run's reply must not give those
 * counts and ids back. It still does its work there.
 */
describeEmbeddedPostgres("the stuck-task run and Personal companies", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let acmeId!: string;
  let bobPersonalId!: string;
  let ownerPersonalId!: string;
  const prefixOf: Record<string, string> = {};
  const blockedIssueOf: Record<string, string> = {};
  const obsoleteRecoveryOf: Record<string, string> = {};

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-liveness-run-personal-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  beforeEach(async () => {
    acmeId = randomUUID();
    bobPersonalId = randomUUID();
    ownerPersonalId = randomUUID();
    prefixOf[acmeId] = "ACR";
    prefixOf[bobPersonalId] = "MER";
    prefixOf[ownerPersonalId] = "ME2R";
    await db.insert(companies).values([
      { id: acmeId, name: "Acme", issuePrefix: prefixOf[acmeId]! },
      { id: bobPersonalId, name: "Personal", issuePrefix: prefixOf[bobPersonalId]!, kind: "personal", ownerUserId: BOB },
      {
        id: ownerPersonalId,
        name: "Personal",
        issuePrefix: prefixOf[ownerPersonalId]!,
        kind: "personal",
        ownerUserId: OWNER,
      },
    ]);
    await loadPersonalCompanyIndex(db);
    for (const companyId of [acmeId, bobPersonalId, ownerPersonalId]) {
      await seedStuckTask(companyId);
      await seedObsoleteRecovery(companyId);
    }
  });

  afterEach(async () => {
    // Let the runs the wake-ups started finish before their rows go.
    vi.clearAllMocks();
    runningProcesses.clear();
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // A blocked task whose blocker nobody owns: the Run makes a recovery task for it.
  async function seedStuckTask(companyId: string) {
    const managerId = randomUUID();
    const coderId = randomUUID();
    const blockedIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const prefix = prefixOf[companyId]!;
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
    ]);
    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked parent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: coderId,
        issueNumber: 1,
        identifier: `${prefix}-1`,
        createdAt: anHourAgo,
        updatedAt: anHourAgo,
      },
      {
        id: blockerIssueId,
        companyId,
        title: "Missing unblock owner",
        status: "todo",
        priority: "medium",
        issueNumber: 2,
        identifier: `${prefix}-2`,
        createdAt: anHourAgo,
        updatedAt: anHourAgo,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });
    blockedIssueOf[companyId] = blockedIssueId;
  }

  // An open recovery task for an incident that is over: the Run retires it.
  async function seedObsoleteRecovery(companyId: string) {
    const [recovery] = await db
      .insert(issues)
      .values({
        companyId,
        title: "Recover a task that is no longer stuck",
        status: "todo",
        priority: "medium",
        issueNumber: 3,
        identifier: `${prefixOf[companyId]}-3`,
        originKind: "harness_liveness_escalation",
        originId: ["harness_liveness", companyId, randomUUID(), "blocked_by_unassigned_issue", randomUUID()].join(":"),
      })
      .returning({ id: issues.id });
    obsoleteRecoveryOf[companyId] = recovery!.id;
  }

  const carol = () => ({
    type: "board",
    userId: CAROL,
    source: "session",
    isInstanceAdmin: true,
    companyIds: [],
    memberships: [],
  });
  const owner = () => ({
    type: "board",
    userId: OWNER,
    source: "session",
    isInstanceAdmin: true,
    companyIds: [ownerPersonalId],
    memberships: [{ companyId: ownerPersonalId, membershipRole: "owner", status: "active" }],
  });

  async function runAs(actor: Record<string, unknown>) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      (req as unknown as { actor: Record<string, unknown> }).actor = actor;
      next();
    });
    instance.use("/api", instanceSettingsRoutes(db));
    instance.use(errorHandler);
    const res = await request(instance)
      .post("/api/instance/settings/experimental/issue-graph-liveness-auto-recovery/run")
      .send({ lookbackHours: 24 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as {
      findings: number;
      escalationsCreated: number;
      obsoleteRecoveriesRetired: number;
      issueIds: string[];
      escalationIssueIds: string[];
      retiredRecoveryIssueIds: string[];
    };
  }

  async function companiesOf(issueIds: string[]) {
    if (issueIds.length === 0) return [];
    const rows = await db
      .select({ companyId: issues.companyId })
      .from(issues)
      .where(inArray(issues.id, issueIds));
    return rows.map((row) => row.companyId).sort();
  }

  /** Recovery tasks the Run made in the company, not counting the seeded one. */
  async function recoveriesMadeIn(companyId: string) {
    const rows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    return rows.filter((row) => row.id !== obsoleteRecoveryOf[companyId]).length;
  }

  async function statusOf(issueId: string) {
    const [row] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    return row?.status;
  }

  it("tells an instance admin nothing about someone else's Personal company, and still does its work there", async () => {
    const reply = await runAs(carol());

    expect(reply).toMatchObject({
      findings: 1,
      escalationsCreated: 1,
      obsoleteRecoveriesRetired: 1,
      issueIds: [blockedIssueOf[acmeId]],
      retiredRecoveryIssueIds: [obsoleteRecoveryOf[acmeId]],
    });
    expect(await companiesOf(reply.escalationIssueIds)).toEqual([acmeId]);
    // The activity row the Run leaves in every company says no more.
    const logged = await db.select({ details: activityLog.details }).from(activityLog).where(eq(activityLog.action, RUN_ACTION));
    expect(logged.length).toBeGreaterThan(0);
    for (const row of logged) {
      expect((row.details as { escalationIssueIds: string[] }).escalationIssueIds).toEqual(reply.escalationIssueIds);
    }

    // It acted in both Personal companies all the same.
    for (const personalId of [bobPersonalId, ownerPersonalId]) {
      expect(await recoveriesMadeIn(personalId)).toBe(1);
      expect(await statusOf(obsoleteRecoveryOf[personalId]!)).toBe("cancelled");
    }
  });

  it("still tells the owner what it did in his own Personal company", async () => {
    const reply = await runAs(owner());

    expect(reply).toMatchObject({ findings: 2, escalationsCreated: 2, obsoleteRecoveriesRetired: 2 });
    expect([...reply.issueIds].sort()).toEqual([blockedIssueOf[acmeId], blockedIssueOf[ownerPersonalId]].sort());
    expect([...reply.retiredRecoveryIssueIds].sort()).toEqual(
      [obsoleteRecoveryOf[acmeId], obsoleteRecoveryOf[ownerPersonalId]].sort(),
    );
    expect(await companiesOf(reply.escalationIssueIds)).toEqual([acmeId, ownerPersonalId].sort());
  });
});
