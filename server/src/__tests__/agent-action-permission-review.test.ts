import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, approvals, companies, createDb, instanceSettings } from "@paperclipai/db";
import { agentActionPermissionReviewService } from "../services/agent-action-permission-review.ts";
import { agentService } from "../services/agents.ts";
import { deterministicActivityId } from "../services/activity-log.ts";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.ts";

async function closeDbClient(db: ReturnType<typeof createDb> | undefined) {
  await db?.$client?.end?.({ timeout: 0 });
}

describe("agentActionPermissionReviewService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-action-permission-review-");
    db = createDb(started.connectionString);
    tempDb = started;
  }, 120_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  it("flags broad agent permissions once per UTC day", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Review Co",
      issuePrefix: `R${companyId.slice(0, 5).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Payments Agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      permissions: {
        canCreateAgents: false,
        actionApprovalModes: { move_money: "go_ahead" },
      },
    });

    const service = agentActionPermissionReviewService(db);
    const first = await service.runDailyReview(new Date("2026-10-15T12:00:00.000Z"));
    const second = await service.runDailyReview(new Date("2026-10-15T20:00:00.000Z"));

    expect(first).toMatchObject({ findings: 1, flagged: 1 });
    expect(second).toMatchObject({ findings: 1, flagged: 0 });
    expect(first.companiesScanned).toBeGreaterThanOrEqual(1);
    const rows = await db.select().from(activityLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId,
      action: "agent_action.permission_review_flagged",
      entityType: "agent",
      entityId: agentId,
      agentId,
      details: expect.objectContaining({
        actionType: "move_money",
        reviewDay: "2026-10-15",
      }),
    });
  });

  it("records a failed outcome for a stale direct action without a terminal receipt", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const attemptId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Reconciliation Co",
      issuePrefix: `X${companyId.slice(0, 5).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Action Agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      permissions: { canCreateAgents: false },
    });
    await db.insert(activityLog).values({
      id: attemptId,
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "agent_action.execution_started",
      entityType: "tool",
      entityId: "mcp:billing:pay_invoice",
      agentId,
      details: {
        actionType: "move_money",
        executionAttemptId: attemptId,
        leaseExpiresAt: "2026-10-15T11:10:00.000Z",
      },
      createdAt: new Date("2026-10-15T11:00:00.000Z"),
    });

    const service = agentActionPermissionReviewService(db);
    const first = await service.reconcileStaleExecutions(new Date("2026-10-15T12:00:00.000Z"));
    const second = await service.reconcileStaleExecutions(new Date("2026-10-15T13:00:00.000Z"));

    expect(first).toEqual({ scanned: 1, reconciled: 1 });
    expect(second).toEqual({ scanned: 0, reconciled: 0 });
    const rows = await db.select().from(activityLog);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "agent_action.failed",
        entityId: "mcp:billing:pay_invoice",
        details: expect.objectContaining({
          executionAttemptId: attemptId,
          outcomeUncertain: true,
          recoveredByReconciliation: true,
        }),
      }),
    ]));
  });

  it("repairs a stale approved draft execution without a manual retry", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const approvalId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Approval Reconciliation Co",
      issuePrefix: `Y${companyId.slice(0, 5).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Approval Agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      permissions: { canCreateAgents: false },
    });
    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "approval.execution_started",
      entityType: "approval",
      entityId: approvalId,
      agentId,
      details: {
        executionKind: "approval",
        approvalId,
        requestedByAgentId: agentId,
        actionType: "send_message",
        policySource: "company",
        tool: "email-tools:email_send",
        leaseExpiresAt: "2026-10-15T11:10:00.000Z",
      },
      createdAt: new Date("2026-10-15T11:00:00.000Z"),
    });

    const result = await agentActionPermissionReviewService(db)
      .reconcileStaleExecutions(new Date("2026-10-15T12:00:00.000Z"));

    expect(result).toEqual({ scanned: 1, reconciled: 1 });
    const rows = await db.select().from(activityLog);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "approval.execute_failed",
        entityId: approvalId,
      }),
      expect.objectContaining({
        action: "agent_action.failed",
        entityId: approvalId,
        actorId: agentId,
        details: expect.objectContaining({ outcomeUncertain: true }),
      }),
    ]));
  });

  it("recovers a refused action from its durable approval receipt", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const approvalId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Refusal Recovery Co",
      issuePrefix: `F${companyId.slice(0, 5).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Refused Agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      permissions: { canCreateAgents: false },
    });
    await db.insert(activityLog).values([
      {
        id: randomUUID(),
        companyId,
        actorType: "user",
        actorId: "board-user",
        action: "approval.execution_started",
        entityType: "approval",
        entityId: approvalId,
        agentId,
        details: {
          actionType: "post_publicly",
          policySource: "company",
          tool: "mcp:social:post_comment",
          leaseExpiresAt: "2026-10-15T11:10:00.000Z",
        },
        createdAt: new Date("2026-10-15T11:00:00.000Z"),
      },
      {
        id: deterministicActivityId("approval-execution-receipt", approvalId),
        companyId,
        actorType: "user",
        actorId: "board-user",
        action: "approval.execute_failed",
        entityType: "approval",
        entityId: approvalId,
        agentId,
        details: { ok: false, outcome: "refused" },
        createdAt: new Date("2026-10-15T11:01:00.000Z"),
      },
    ]);

    const result = await agentActionPermissionReviewService(db)
      .reconcileStaleExecutions(new Date("2026-10-15T12:00:00.000Z"));

    expect(result).toEqual({ scanned: 1, reconciled: 1 });
    const rows = await db.select().from(activityLog);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "agent_action.refused",
        entityId: approvalId,
        actorId: agentId,
      }),
    ]));
  });

  it("recovers a deleted agent refusal from the payload actor recorded at start", async () => {
    const companyId = randomUUID();
    const deletedAgentId = randomUUID();
    const approvalId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Deleted Agent Recovery Co",
      issuePrefix: `D${companyId.slice(0, 5).toUpperCase()}`,
    });
    await db.insert(activityLog).values([
      {
        id: randomUUID(),
        companyId,
        actorType: "user",
        actorId: "board-user",
        action: "approval.execution_started",
        entityType: "approval",
        entityId: approvalId,
        agentId: null,
        details: {
          actionActorId: deletedAgentId,
          actionType: "send_message",
          policySource: "company",
          tool: "email-tools:email_send",
          leaseExpiresAt: "2026-10-15T11:10:00.000Z",
        },
        createdAt: new Date("2026-10-15T11:00:00.000Z"),
      },
      {
        id: deterministicActivityId("approval-execution-receipt", approvalId),
        companyId,
        actorType: "user",
        actorId: "board-user",
        action: "approval.execute_failed",
        entityType: "approval",
        entityId: approvalId,
        agentId: null,
        details: { ok: false, outcome: "refused" },
        createdAt: new Date("2026-10-15T11:01:00.000Z"),
      },
    ]);

    const result = await agentActionPermissionReviewService(db)
      .reconcileStaleExecutions(new Date("2026-10-15T12:00:00.000Z"));

    expect(result).toEqual({ scanned: 1, reconciled: 1 });
    const rows = await db.select().from(activityLog);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "agent_action.refused",
        entityId: approvalId,
        actorId: deletedAgentId,
        agentId: null,
      }),
    ]));
  });

  it("repairs an approved draft abandoned before its execution start was recorded", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const approvalId = randomUUID();
    const deletedRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Pre-start Recovery Co",
      issuePrefix: `W${companyId.slice(0, 5).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Pre-start Agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      permissions: { canCreateAgents: false },
    });
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "outbound_tool_draft",
      status: "approved",
      requestedByAgentId: agentId,
      decidedByUserId: "board-user",
      decidedAt: new Date("2026-10-15T11:00:00.000Z"),
      payload: {
        runId: deletedRunId,
        actionType: "send_message",
        actionPolicySource: "company",
        toolName: "email-tools:email_send",
      },
    });

    const result = await agentActionPermissionReviewService(db)
      .reconcileStaleExecutions(new Date("2026-10-15T12:00:00.000Z"));

    expect(result).toEqual({ scanned: 1, reconciled: 1 });
    const rows = await db.select().from(activityLog);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "approval.execute_failed", entityId: approvalId }),
      expect.objectContaining({
        action: "agent_action.failed",
        entityId: approvalId,
        runId: null,
        details: expect.objectContaining({ outcomeUncertain: false }),
      }),
    ]));
    expect(rows).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "approval.execution_started", entityId: approvalId }),
    ]));
  });

  it("repairs a rejected draft abandoned before its refusal audit was recorded", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const approvalId = randomUUID();
    const deletedRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Rejection Recovery Co",
      issuePrefix: `J${companyId.slice(0, 5).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Rejected Agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      permissions: { canCreateAgents: false },
    });
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "outbound_tool_draft",
      status: "rejected",
      requestedByAgentId: agentId,
      decidedByUserId: "board-user",
      decidedAt: new Date("2026-10-15T11:00:00.000Z"),
      payload: {
        runId: deletedRunId,
        actionType: "send_message",
        actionPolicySource: "company",
        toolName: "email-tools:email_send",
      },
    });

    const result = await agentActionPermissionReviewService(db)
      .reconcileStaleExecutions(new Date("2026-10-15T12:00:00.000Z"));

    expect(result).toEqual({ scanned: 1, reconciled: 1 });
    const rows = await db.select().from(activityLog);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: deterministicActivityId("agent-action-outcome", approvalId),
        action: "agent_action.refused",
        agentId,
        runId: null,
        details: expect.objectContaining({ recoveredByReconciliation: true }),
      }),
    ]));
  });

  it("repairs a rejected draft after its requesting agent was deleted", async () => {
    const companyId = randomUUID();
    const deletedAgentId = randomUUID();
    const approvalId = randomUUID();
    const deletedRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Deleted Rejection Recovery Co",
      issuePrefix: `Q${companyId.slice(0, 5).toUpperCase()}`,
    });
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "outbound_tool_draft",
      status: "rejected",
      requestedByAgentId: null,
      decidedByUserId: "board-user",
      decidedAt: new Date("2026-10-15T11:00:00.000Z"),
      payload: {
        agentId: deletedAgentId,
        runId: deletedRunId,
        actionType: "send_message",
        actionPolicySource: "company",
        toolName: "email-tools:email_send",
      },
    });

    const result = await agentActionPermissionReviewService(db)
      .reconcileStaleExecutions(new Date("2026-10-15T12:00:00.000Z"));

    expect(result).toEqual({ scanned: 1, reconciled: 1 });
    const rows = await db.select().from(activityLog);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "agent_action.refused",
        entityId: approvalId,
        actorId: deletedAgentId,
        agentId: null,
        runId: null,
      }),
    ]));
  });

  it("repairs a pending draft abandoned before its approval-request audit was recorded", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const approvalId = randomUUID();
    const deletedRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Pending Recovery Co",
      issuePrefix: `K${companyId.slice(0, 5).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Pending Agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      permissions: { canCreateAgents: false },
    });
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "outbound_tool_draft",
      status: "pending",
      requestedByAgentId: agentId,
      createdAt: new Date("2026-10-15T11:00:00.000Z"),
      payload: {
        runId: deletedRunId,
        actionType: "send_message",
        actionPolicySource: "company",
        toolName: "email-tools:email_send",
        summary: "Email customer@example.com",
      },
    });

    const result = await agentActionPermissionReviewService(db)
      .reconcileStaleExecutions(new Date("2026-10-15T12:00:00.000Z"));

    expect(result).toEqual({ scanned: 1, reconciled: 1 });
    const rows = await db.select().from(activityLog);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: deterministicActivityId("agent-action-approval-requested", approvalId),
        action: "agent_action.approval_requested",
        agentId,
        runId: null,
        details: expect.objectContaining({ recoveredByReconciliation: true }),
      }),
    ]));
  });

  it("uses a durable approval receipt to recover the true successful outcome", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const approvalId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Receipt Recovery Co",
      issuePrefix: `Q${companyId.slice(0, 5).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Receipt Agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      permissions: { canCreateAgents: false },
    });
    await db.insert(activityLog).values([
      {
        id: randomUUID(),
        companyId,
        actorType: "user",
        actorId: "board-user",
        action: "approval.execution_started",
        entityType: "approval",
        entityId: approvalId,
        agentId,
        details: { policySource: "company", actionType: "send_message" },
        createdAt: new Date("2026-10-15T11:00:00.000Z"),
      },
      {
        id: deterministicActivityId("approval-execution-receipt", approvalId),
        companyId,
        actorType: "user",
        actorId: "board-user",
        action: "approval.executed",
        entityType: "approval",
        entityId: approvalId,
        agentId,
        details: { ok: true },
        createdAt: new Date("2026-10-15T11:01:00.000Z"),
      },
    ]);

    const result = await agentActionPermissionReviewService(db)
      .reconcileStaleExecutions(new Date("2026-10-15T12:00:00.000Z"));

    expect(result).toEqual({ scanned: 1, reconciled: 1 });
    const rows = await db.select().from(activityLog);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: deterministicActivityId("agent-action-outcome", approvalId),
        action: "agent_action.allowed",
      }),
    ]));
  });

  it("recovers a successful action after the requesting agent was deleted", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const approvalId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Deleted Receipt Recovery Co",
      issuePrefix: `D${companyId.slice(0, 5).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Deleted Receipt Agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      permissions: { canCreateAgents: false },
    });
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "outbound_tool_draft",
      status: "approved",
      requestedByAgentId: agentId,
      decidedByUserId: "board-user",
      decidedAt: new Date("2026-10-15T11:00:00.000Z"),
      payload: {
        agentId,
        actionType: "send_message",
        actionPolicySource: "company",
        toolName: "email-tools:email_send",
      },
    });
    await db.insert(activityLog).values({
      id: deterministicActivityId("approval-execution-receipt", approvalId),
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "approval.executed",
      entityType: "approval",
      entityId: approvalId,
      details: { ok: true, outcome: "allowed" },
      createdAt: new Date("2026-10-15T11:01:00.000Z"),
    });

    await agentService(db).remove(agentId);
    const result = await agentActionPermissionReviewService(db)
      .reconcileStaleExecutions(new Date("2026-10-15T12:00:00.000Z"));

    expect(result).toEqual({ scanned: 1, reconciled: 1 });
    const rows = await db.select().from(activityLog);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: deterministicActivityId("agent-action-outcome", approvalId),
        action: "agent_action.allowed",
        actorId: agentId,
        agentId: null,
        runId: null,
      }),
    ]));
  });

  it("preserves a durable refusal while repairing a missing approval receipt", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const approvalId = randomUUID();
    const startId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Outcome Recovery Co",
      issuePrefix: `V${companyId.slice(0, 5).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Outcome Agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      permissions: { canCreateAgents: false },
    });
    await db.insert(activityLog).values([
      {
        id: startId,
        companyId,
        actorType: "user",
        actorId: "board-user",
        action: "approval.execution_started",
        entityType: "approval",
        entityId: approvalId,
        agentId,
        details: { policySource: "company", actionType: "send_message" },
        createdAt: new Date("2026-10-15T11:00:00.000Z"),
      },
      {
        id: deterministicActivityId("agent-action-outcome", approvalId),
        companyId,
        actorType: "agent",
        actorId: agentId,
        action: "agent_action.refused",
        entityType: "approval",
        entityId: approvalId,
        agentId,
        details: { executionAttemptId: startId },
        createdAt: new Date("2026-10-15T11:01:00.000Z"),
      },
    ]);

    const result = await agentActionPermissionReviewService(db)
      .reconcileStaleExecutions(new Date("2026-10-15T12:00:00.000Z"));

    expect(result).toEqual({ scanned: 1, reconciled: 1 });
    const receipt = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.id, deterministicActivityId("approval-execution-receipt", approvalId)))
      .then((rows) => rows[0]);
    expect(receipt).toMatchObject({
      action: "approval.execute_failed",
      details: expect.objectContaining({ outcome: "refused" }),
    });
  });

  it("repairs a user draft receipt without inventing an agent outcome", async () => {
    const companyId = randomUUID();
    const approvalId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "User Draft Co",
      issuePrefix: `U${companyId.slice(0, 5).toUpperCase()}`,
    });
    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "approval.execution_started",
      entityType: "approval",
      entityId: approvalId,
      agentId: null,
      details: { policySource: null },
      createdAt: new Date("2026-10-15T11:00:00.000Z"),
    });

    const result = await agentActionPermissionReviewService(db)
      .reconcileStaleExecutions(new Date("2026-10-15T12:00:00.000Z"));

    expect(result).toEqual({ scanned: 1, reconciled: 1 });
    const rows = await db.select().from(activityLog);
    expect(rows.filter((row) => row.action.startsWith("agent_action."))).toHaveLength(0);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "approval.execute_failed", entityId: approvalId }),
    ]));
  });

  it("continues past a full page of completed starts to reconcile a later gap", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paged Reconciliation Co",
      issuePrefix: `Z${companyId.slice(0, 5).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Paged Agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      permissions: { canCreateAgents: false },
    });
    const starts = Array.from({ length: 501 }, (_, index) => ({
      id: randomUUID(),
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "agent_action.execution_started",
      entityType: "tool",
      entityId: `tool:${index.toString().padStart(3, "0")}`,
      agentId,
      details: { actionType: "change_files" },
      createdAt: new Date("2026-10-15T11:00:00.000Z"),
    }));
    await db.insert(activityLog).values(starts);
    await db.insert(activityLog).values(starts.slice(0, 500).map((start) => ({
      id: deterministicActivityId("agent-action-execution-outcome", start.id),
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "agent_action.allowed",
      entityType: "tool",
      entityId: start.entityId,
      agentId,
      details: { executionAttemptId: start.id },
      createdAt: new Date("2026-10-15T11:01:00.000Z"),
    })));

    const result = await agentActionPermissionReviewService(db)
      .reconcileStaleExecutions(new Date("2026-10-15T12:00:00.000Z"));

    expect(result).toEqual({ scanned: 1, reconciled: 1 });
    const repaired = await db.select().from(activityLog);
    expect(repaired).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: deterministicActivityId("agent-action-execution-outcome", starts[500]!.id),
        action: "agent_action.failed",
      }),
    ]));
  });
});
