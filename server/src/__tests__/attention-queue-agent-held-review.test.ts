import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueThreadInteractions, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { attentionQueueService } from "../services/attention-queue.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent-held review attention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const BOARD_USER = "local-board";
const HELD_TITLE_SUFFIX = "is finished and waiting for review, but no person is assigned";

/**
 * #184: finished work an agent marked in_review but could not hand to a
 * person sat on the agent and no surface listed it. These pin that the
 * attention queue now shows it, and only it.
 */
describeEmbeddedPostgres("attention queue: finished work an agent still holds", () => {
  let db!: ReturnType<typeof createDb>;
  let queueSvc!: ReturnType<typeof attentionQueueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let counter = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-attention-agent-held-review-");
    db = createDb(tempDb.connectionString);
    queueSvc = attentionQueueService(db);
  }, 90_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<{ companyId: string; prefix: string }> {
    const companyId = randomUUID();
    const prefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    return { companyId, prefix };
  }

  async function seedAgent(companyId: string, name: string): Promise<string> {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function seedIssue(
    company: { companyId: string; prefix: string },
    values: Partial<typeof issues.$inferInsert>,
  ) {
    counter += 1;
    const id = randomUUID();
    const identifier = `${company.prefix}-${counter}`;
    await db.insert(issues).values({
      id,
      companyId: company.companyId,
      title: `Issue ${counter}`,
      identifier,
      issueNumber: counter,
      status: "in_review",
      ...values,
    });
    return { id, identifier };
  }

  function pendingState(participant: { type: "agent" | "user"; agentId?: string; userId?: string }) {
    return {
      status: "pending",
      currentStageId: randomUUID(),
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: {
        type: participant.type,
        agentId: participant.agentId ?? null,
        userId: participant.userId ?? null,
      },
      returnAssignee: null,
      reviewRequest: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    };
  }

  async function signOffRows(companyId: string, userId: string | null = BOARD_USER) {
    const { rows } = await queueSvc.listForCompany(companyId, { userId, canApproveJoins: true });
    return rows.filter((row) => row.kind === "sign_off");
  }

  it("lists an in_review issue held by an agent with no person assigned", async () => {
    const company = await seedCompany();
    const agentId = await seedAgent(company.companyId, "Builder");
    const held = await seedIssue(company, { title: "Ship the reviews page", assigneeAgentId: agentId });

    const rows = await signOffRows(company.companyId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.key).toBe(`sign_off:${held.id}`);
    expect(row.title).toBe(`${held.identifier} ${HELD_TITLE_SUFFIX}`);
    expect(row.detail).toBe("Ship the reviews page · Held by Builder");
    expect(row.askedBy).toBe("Builder");
    expect(row.blocking).toBe("waiting");
    expect(row.consequence).toBe("Nobody will look at it until someone is assigned.");
    expect(row.href).toBe(`/issues/${held.identifier}`);
  });

  it("still lists it when an earlier review stage has already completed", async () => {
    const company = await seedCompany();
    const agentId = await seedAgent(company.companyId, "Builder");
    const held = await seedIssue(company, {
      assigneeAgentId: agentId,
      executionState: { ...pendingState({ type: "user", userId: BOARD_USER }), status: "completed" },
    });

    const rows = await signOffRows(company.companyId);
    expect(rows.map((row) => row.key)).toEqual([`sign_off:${held.id}`]);
  });

  it("shows it to every board user of the company, since no person is named on it", async () => {
    const company = await seedCompany();
    const agentId = await seedAgent(company.companyId, "Builder");
    const held = await seedIssue(company, { assigneeAgentId: agentId });

    expect((await signOffRows(company.companyId, "someone-else")).map((row) => row.key)).toEqual([
      `sign_off:${held.id}`,
    ]);
    expect((await signOffRows(company.companyId, null)).map((row) => row.key)).toEqual([
      `sign_off:${held.id}`,
    ]);
  });

  it("does not list in_review work a person is assigned to", async () => {
    const company = await seedCompany();
    await seedIssue(company, { assigneeUserId: BOARD_USER });

    expect(await signOffRows(company.companyId)).toEqual([]);
  });

  it("does not list work an agent reviewer is handling through a pending stage", async () => {
    const company = await seedCompany();
    const agentId = await seedAgent(company.companyId, "Reviewer");
    await seedIssue(company, {
      assigneeAgentId: agentId,
      executionState: pendingState({ type: "agent", agentId }),
    });

    expect(await signOffRows(company.companyId)).toEqual([]);
  });

  it("leaves a person's review gate as the ordinary sign-off row, not a held one", async () => {
    const company = await seedCompany();
    const gate = await seedIssue(company, {
      assigneeUserId: BOARD_USER,
      executionState: pendingState({ type: "user", userId: BOARD_USER }),
    });

    const rows = await signOffRows(company.companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe(`sign_off:${gate.id}`);
    expect(rows[0]!.title).toBe(`${gate.identifier} finished and wants your review`);
  });

  it("lets an open question on the issue stand for it instead of adding a second row", async () => {
    const company = await seedCompany();
    const agentId = await seedAgent(company.companyId, "Builder");
    const held = await seedIssue(company, { assigneeAgentId: agentId });
    await issueThreadInteractionService(db).create({ id: held.id, companyId: company.companyId }, {
      kind: "suggest_tasks",
      continuationPolicy: "wake_assignee_on_accept",
      payload: {
        version: 1,
        tasks: [{ clientKey: "follow-up", title: "Create the follow-up" }],
      },
    }, { agentId });

    const { rows } = await queueSvc.listForCompany(company.companyId, {
      userId: BOARD_USER,
      canApproveJoins: true,
    });
    expect(rows.map((row) => row.key)).toEqual([`question:${held.id}`]);
  });

  it("ignores hidden issues, issues not in review, and other companies", async () => {
    const company = await seedCompany();
    const other = await seedCompany();
    const agentId = await seedAgent(company.companyId, "Builder");
    const otherAgentId = await seedAgent(other.companyId, "Elsewhere");
    await seedIssue(company, { assigneeAgentId: agentId, hiddenAt: new Date() });
    await seedIssue(company, { assigneeAgentId: agentId, status: "in_progress" });
    await seedIssue(other, { assigneeAgentId: otherAgentId });

    expect(await signOffRows(company.companyId)).toEqual([]);
  });
});
