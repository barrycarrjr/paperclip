// TEMPORARY reproduction for review finding security-2. Delete after running.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  documentRevisions,
  documents,
  goals,
  heartbeatRuns,
  issueDocuments,
  instanceSettings,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { START_WORK_ORIGIN_KIND } from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("refute security-2: a later agent card on an accepted start_work container", () => {
  let db!: ReturnType<typeof createDb>;
  let issuesSvc!: ReturnType<typeof issueService>;
  let interactionsSvc!: ReturnType<typeof issueThreadInteractionService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-refute-security-2-");
    db = createDb(tempDb.connectionString);
    issuesSvc = issueService(db);
    interactionsSvc = issueThreadInteractionService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(issueThreadInteractions);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(companyId: string, role: string, name: string) {
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

  async function loadIssue(id: string) {
    return (await db.select().from(issues).where(eq(issues.id, id)))[0]!;
  }

  async function loadInteraction(id: string) {
    return (await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, id)))[0]!;
  }

  /** Mirrors startWorkService.plan plus a board user's accept of the plan card. */
  async function seedAcceptedRequest() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    const engineerId = await seedAgent(companyId, "engineer", "Engineer");
    const ceoId = await seedAgent(companyId, "ceo", "Chief");

    const requestKey = randomUUID();
    const container = await issuesSvc.create(companyId, {
      title: "Request: Answer Google reviews daily",
      description: "Answer Google reviews daily",
      status: "backlog",
      priority: "medium",
      originKind: START_WORK_ORIGIN_KIND,
      originId: requestKey,
      createdByUserId: "local-board",
    });
    const plan = await interactionsSvc.create({ id: container.id, companyId }, {
      kind: "suggest_tasks",
      idempotencyKey: `start-work:${requestKey}`,
      continuationPolicy: "wake_assignee_on_accept",
      title: "Plan for: Answer Google reviews daily",
      payload: { version: 1, tasks: [{ clientKey: "reply", title: "Reply to new reviews", assigneeAgentId: engineerId }] },
    }, { userId: "local-board" });

    const accepted = await interactionsSvc.acceptSuggestedTasks({
      id: container.id,
      companyId,
      projectId: null,
      goalId: null,
    }, plan.id, {}, { userId: "local-board" });
    expect(accepted.continuationIssue?.status).toBe("todo");
    expect(accepted.continuationIssue?.assigneeAgentId).toBe(ceoId);
    const child = accepted.createdIssues[0]!;

    return { companyId, container, engineerId, ceoId, childId: child.id };
  }

  it("REJECT: declining a later agent-proposed follow-up card must leave the container as it was", async () => {
    const s = await seedAcceptedRequest();

    // The woken lead proposes two follow-ups on the container itself.
    const followUp = await interactionsSvc.create({ id: s.container.id, companyId: s.companyId }, {
      kind: "suggest_tasks",
      continuationPolicy: "wake_assignee_on_accept",
      payload: { version: 1, tasks: [{ clientKey: "a", title: "Follow-up A" }, { clientKey: "b", title: "Follow-up B" }] },
    }, { agentId: s.ceoId });
    const followUpRow = await loadInteraction(followUp.id);
    expect(followUpRow.createdByAgentId).toBe(s.ceoId);
    expect(followUpRow.createdByUserId).toBeNull();

    const before = await loadIssue(s.container.id);
    expect(before.status).toBe("todo");

    await interactionsSvc.rejectInteraction({ id: s.container.id, companyId: s.companyId }, followUp.id, { reason: "Not those" }, { userId: "local-board" });

    const container = await loadIssue(s.container.id);
    const child = await loadIssue(s.childId);
    expect({
      containerStatus: container.status,
      containerCancelled: container.cancelledAt !== null,
      containerAssignee: container.assigneeAgentId,
      childStatus: child.status,
    }).toEqual({
      containerStatus: "todo",
      containerCancelled: false,
      containerAssignee: s.ceoId,
      childStatus: "todo",
    });
  });

  it("ACCEPT: accepting a later agent-proposed follow-up card must not re-run the hand-over on a running container", async () => {
    const s = await seedAcceptedRequest();

    // The lead delegated: the engineer is now running the container.
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: s.companyId,
      agentId: s.engineerId,
      invocationSource: "manual",
      status: "running",
      startedAt: new Date(),
    });
    await db.update(issues).set({
      status: "in_progress",
      assigneeAgentId: s.engineerId,
      checkoutRunId: runId,
      executionRunId: runId,
      executionLockedAt: new Date(),
      startedAt: new Date(),
    }).where(eq(issues.id, s.container.id));

    const followUp = await interactionsSvc.create({ id: s.container.id, companyId: s.companyId }, {
      kind: "suggest_tasks",
      continuationPolicy: "wake_assignee_on_accept",
      sourceRunId: runId,
      payload: { version: 1, tasks: [{ clientKey: "a", title: "Follow-up A" }] },
    }, { agentId: s.engineerId });

    const accepted = await interactionsSvc.acceptSuggestedTasks({
      id: s.container.id,
      companyId: s.companyId,
      projectId: null,
      goalId: null,
    }, followUp.id, {}, { userId: "local-board" });

    const container = await loadIssue(s.container.id);
    expect({
      continuationIssue: accepted.continuationIssue,
      containerStatus: container.status,
      containerAssignee: container.assigneeAgentId,
      executionRunId: container.executionRunId,
      checkoutRunId: container.checkoutRunId,
      acceptedPlanSections: (container.description ?? "").match(/## Accepted plan/g)?.length ?? 0,
    }).toEqual({
      continuationIssue: null,
      containerStatus: "in_progress",
      containerAssignee: s.engineerId,
      executionRunId: runId,
      checkoutRunId: runId,
      acceptedPlanSections: 1,
    });
  });
});
