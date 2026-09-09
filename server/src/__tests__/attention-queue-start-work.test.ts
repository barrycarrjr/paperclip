import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { START_WORK_ORIGIN_KIND, startWorkInteractionIdempotencyKey } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { attentionQueueService } from "../services/attention-queue.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres attention queue start work tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const BOARD_USER = "local-board";
const REQUEST_TEXT = "Get the shop's Google reviews answered every day";

/**
 * The Brief row for a plan a board user asked for. The card is the same
 * suggest_tasks card an agent would post, so the only thing that tells the
 * two apart is who created it; these tests pin that the wording follows the
 * creator and that nothing else about the row (key, kind, deep link) moves.
 */
describeEmbeddedPostgres("attention queue: plans a board user asked for", () => {
  let db!: ReturnType<typeof createDb>;
  let issuesSvc!: ReturnType<typeof issueService>;
  let interactionsSvc!: ReturnType<typeof issueThreadInteractionService>;
  let queueSvc!: ReturnType<typeof attentionQueueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-attention-start-work-");
    db = createDb(tempDb.connectionString);
    issuesSvc = issueService(db);
    interactionsSvc = issueThreadInteractionService(db);
    queueSvc = attentionQueueService(db);
  }, 90_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(issueThreadInteractions);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    return companyId;
  }

  async function seedAgent(companyId: string, role: string, name: string): Promise<string> {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role,
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  /**
   * Mirrors what startWorkService.plan writes: a backlog container with no
   * assignee, keyed by originKind/originId, plus a pending suggest_tasks
   * card created by a board user with the accept-only wake policy.
   */
  async function seedStartWorkPlan(companyId: string, options: { title?: string } = {}) {
    const requestKey = randomUUID();
    const container = await issuesSvc.create(companyId, {
      title: `Request: ${REQUEST_TEXT}`,
      description: REQUEST_TEXT,
      status: "backlog",
      priority: "medium",
      originKind: START_WORK_ORIGIN_KIND,
      originId: requestKey,
      createdByUserId: BOARD_USER,
    });
    const interaction = await interactionsSvc.create({ id: container.id, companyId }, {
      kind: "suggest_tasks",
      idempotencyKey: startWorkInteractionIdempotencyKey(requestKey),
      continuationPolicy: "wake_assignee_on_accept",
      ...(options.title ? { title: options.title } : {}),
      payload: {
        version: 1,
        tasks: [{ clientKey: "reply", title: "Reply to new reviews" }],
      },
    }, { userId: BOARD_USER });
    return { container, interaction };
  }

  async function questionRows(companyId: string) {
    const { rows } = await queueSvc.listForCompany(companyId, {
      userId: BOARD_USER,
      canApproveJoins: true,
    });
    return rows.filter((row) => row.kind === "question");
  }

  it("a pending board-created suggest_tasks card on a backlog container is a waiting row titled Plan waiting for your decision with the no-agent-paused consequence and a deep link to the card", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, "ceo", "Chief");
    const { container, interaction } = await seedStartWorkPlan(companyId);

    const rows = await questionRows(companyId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    expect(row.key).toBe(`question:${container.id}`);
    expect(row.kind).toBe("question");
    expect(row.count).toBe(1);
    expect(row.title).toBe("Plan waiting for your decision");
    expect(row.detail).toBe(`Request: ${REQUEST_TEXT}`);
    expect(row.blocking).toBe("waiting");
    expect(row.consequence).toBe("No tasks are created until you accept it. Waiting costs nothing.");
    expect(row.consequence).not.toContain("paused");
    // The row links to a request issue that really does exist, so it must
    // never claim that nothing at all was created.
    expect(row.consequence).not.toContain("Nothing is created");
    expect(row.href).toBe(`/issues/${container.identifier}#interaction-${interaction.id}`);
    // A board-created plan is not a confirmation request, so it never lapses by itself.
    expect(row.deadlineOutcome).toBeNull();
  });

  it("a board-created plan that carries a title keeps that title as the row headline", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, "ceo", "Chief");
    // startWorkService.plan writes "Plan for: <first line>"; the fallback
    // title only applies when the card has neither title nor summary.
    await seedStartWorkPlan(companyId, { title: `Plan for: ${REQUEST_TEXT}` });

    const rows = await questionRows(companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe(`Plan for: ${REQUEST_TEXT}`);
    expect(rows[0]!.blocking).toBe("waiting");
    expect(rows[0]!.consequence).toBe("No tasks are created until you accept it. Waiting costs nothing.");
  });

  it("an agent-created suggest_tasks card with wake_assignee_on_accept is still a stopped row with the agent-paused wording", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "engineer", "Engineer");
    const host = await issuesSvc.create(companyId, {
      title: "Ship the reviews feature",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const interaction = await interactionsSvc.create({ id: host.id, companyId }, {
      kind: "suggest_tasks",
      continuationPolicy: "wake_assignee_on_accept",
      payload: {
        version: 1,
        tasks: [{ clientKey: "follow-up", title: "Create the follow-up" }],
      },
    }, { agentId });

    const rows = await questionRows(companyId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    expect(row.key).toBe(`question:${host.id}`);
    expect(row.title).toBe("An agent is asking you a question");
    expect(row.blocking).toBe("stopped");
    expect(row.consequence).toBe(
      "The agent is paused on this issue until you answer. Waiting costs nothing.",
    );
    expect(row.href).toBe(`/issues/${host.identifier}#interaction-${interaction.id}`);
  });

  it("a cancelled container's card no longer appears", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, "ceo", "Chief");
    const { container, interaction } = await seedStartWorkPlan(companyId);
    expect(await questionRows(companyId)).toHaveLength(1);

    // Rejecting the plan cancels the container (item 8), so the card is
    // no longer waiting on anyone.
    const rejected = await interactionsSvc.rejectInteraction(
      { id: container.id, companyId },
      interaction.id,
      { reason: "Not this week" },
      { userId: BOARD_USER },
    );
    expect(rejected.status).toBe("rejected");

    const { rows } = await queueSvc.listForCompany(companyId, {
      userId: BOARD_USER,
      canApproveJoins: true,
    });
    expect(rows.filter((row) => row.kind === "question")).toHaveLength(0);
    expect(rows.find((row) => row.key === `question:${container.id}`)).toBeUndefined();
  });
});
