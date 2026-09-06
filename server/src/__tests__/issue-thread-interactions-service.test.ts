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

describeEmbeddedPostgres("issueThreadInteractionService", () => {
  let db!: ReturnType<typeof createDb>;
  let issuesSvc!: ReturnType<typeof issueService>;
  let interactionsSvc!: ReturnType<typeof issueThreadInteractionService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-thread-interactions-");
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

  it("accepts suggested tasks by creating a rooted issue tree under the current issue", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const assigneeAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });

    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Persist thread interactions",
      level: "task",
      status: "active",
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      requestDepth: 2,
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "suggest_tasks",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        tasks: [
          {
            clientKey: "root",
            title: "Create the root follow-up",
            assigneeAgentId,
          },
          {
            clientKey: "child",
            parentClientKey: "root",
            title: "Create the nested follow-up",
          },
        ],
      },
    }, {
      userId: "local-board",
    });

    expect(created.status).toBe("pending");

    const accepted = await interactionsSvc.acceptSuggestedTasks({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, created.id, {}, {
      userId: "local-board",
    });

    expect(accepted.interaction.kind).toBe("suggest_tasks");
    expect(accepted.interaction.status).toBe("accepted");
    expect(accepted.interaction.result).toMatchObject({
      version: 1,
      createdTasks: [
        expect.objectContaining({ clientKey: "root", parentIssueId: issueId }),
        expect.objectContaining({ clientKey: "child" }),
      ],
    });
    expect(accepted.createdIssues).toEqual([
      expect.objectContaining({
        assigneeAgentId,
        status: "todo",
      }),
      expect.objectContaining({
        assigneeAgentId: null,
        status: "todo",
      }),
    ]);

    const children = await issuesSvc.list(companyId, { parentId: issueId });
    expect(children).toHaveLength(1);
    expect(children[0]?.title).toBe("Create the root follow-up");

    const nestedChildren = await issuesSvc.list(companyId, { parentId: children[0]!.id });
    expect(nestedChildren).toHaveLength(1);
    expect(nestedChildren[0]?.title).toBe("Create the nested follow-up");
    expect(nestedChildren[0]?.requestDepth).toBe(4);

    const listed = await interactionsSvc.listForIssue(issueId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe("accepted");

    await expect(interactionsSvc.acceptSuggestedTasks({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, created.id, {}, {
      userId: "local-board",
    })).rejects.toThrow("Interaction has already been resolved");

    const childrenAfterDuplicateAccept = await issuesSvc.list(companyId, { parentId: issueId });
    expect(childrenAfterDuplicateAccept).toHaveLength(1);
  });

  it("accepts a selected subset of suggested tasks and records the skipped drafts", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });

    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Selectively persist thread interactions",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      requestDepth: 2,
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "suggest_tasks",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        tasks: [
          {
            clientKey: "root",
            title: "Create the root follow-up",
          },
          {
            clientKey: "child",
            parentClientKey: "root",
            title: "Create the nested follow-up",
          },
          {
            clientKey: "sibling",
            title: "Create the sibling follow-up",
          },
        ],
      },
    }, {
      userId: "local-board",
    });

    const accepted = await interactionsSvc.acceptSuggestedTasks({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, created.id, {
      selectedClientKeys: ["root"],
    }, {
      userId: "local-board",
    });

    expect(accepted.interaction.result).toMatchObject({
      version: 1,
      createdTasks: [
        expect.objectContaining({ clientKey: "root", parentIssueId: issueId }),
      ],
      skippedClientKeys: ["child", "sibling"],
    });

    const children = await issuesSvc.list(companyId, { parentId: issueId });
    expect(children).toHaveLength(1);
    expect(children[0]?.title).toBe("Create the root follow-up");
  });

  it("rejects partial acceptance when a selected task omits its selected-tree parent", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });

    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Validate selective acceptance",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "suggest_tasks",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        tasks: [
          {
            clientKey: "root",
            title: "Create the root follow-up",
          },
          {
            clientKey: "child",
            parentClientKey: "root",
            title: "Create the nested follow-up",
          },
        ],
      },
    }, {
      userId: "local-board",
    });

    await expect(
      interactionsSvc.acceptSuggestedTasks({
        id: issueId,
        companyId,
        goalId,
        projectId: null,
      }, created.id, {
        selectedClientKeys: ["child"],
      }, {
        userId: "local-board",
      }),
    ).rejects.toThrow("requires its parent");
  });

  it("persists validated answers for ask_user_questions interactions", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });

    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Persist question answers",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Question parent",
      status: "todo",
      priority: "medium",
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "ask_user_questions",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        questions: [
          {
            id: "scope",
            prompt: "Choose the scope",
            selectionMode: "single",
            required: true,
            options: [
              { id: "phase-1", label: "Phase 1" },
              { id: "phase-2", label: "Phase 2" },
            ],
          },
          {
            id: "extras",
            prompt: "Optional extras",
            selectionMode: "multi",
            options: [
              { id: "tests", label: "Tests" },
              { id: "docs", label: "Docs" },
            ],
          },
        ],
      },
    }, {
      userId: "local-board",
    });

    const answered = await interactionsSvc.answerQuestions({
      id: issueId,
      companyId,
    }, created.id, {
      answers: [
        { questionId: "scope", optionIds: ["phase-1"] },
        { questionId: "extras", optionIds: ["docs", "tests", "docs"] },
      ],
      summaryMarkdown: "Ship Phase 1 with tests and docs.",
    }, {
      userId: "local-board",
    });

    expect(answered.status).toBe("answered");
    expect(answered.result).toEqual({
      version: 1,
      answers: [
        { questionId: "scope", optionIds: ["phase-1"] },
        { questionId: "extras", optionIds: ["docs", "tests"] },
      ],
      summaryMarkdown: "Ship Phase 1 with tests and docs.",
    });

    await expect(interactionsSvc.answerQuestions({
      id: issueId,
      companyId,
    }, created.id, {
      answers: [
        { questionId: "scope", optionIds: ["phase-2"] },
      ],
    }, {
      userId: "local-board",
    })).rejects.toThrow("Interaction has already been resolved");
  });

  it("reuses the existing interaction when the same idempotency key is submitted twice", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });

    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Interaction dedupe",
      level: "task",
      status: "active",
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
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      startedAt: new Date("2026-04-20T12:00:00.000Z"),
    });

    const input = {
      kind: "ask_user_questions" as const,
      idempotencyKey: "run-1:questionnaire",
      sourceRunId: runId,
      continuationPolicy: "wake_assignee" as const,
      payload: {
        version: 1 as const,
        questions: [
          {
            id: "scope",
            prompt: "Pick a scope",
            selectionMode: "single" as const,
            options: [{ id: "phase-2", label: "Phase 2" }],
          },
        ],
      },
    };

    const first = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, input, {
      agentId,
    });

    const second = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, input, {
      agentId,
    });

    expect(second.id).toBe(first.id);
    expect(second.sourceRunId).toBe(runId);

    const rows = await db.select().from(issueThreadInteractions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.idempotencyKey).toBe("run-1:questionnaire");
  });

  it("accepts request_confirmation interactions without creating child issues", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Confirm a request",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        prompt: "Apply this plan?",
        acceptLabel: "Apply",
        rejectLabel: "Keep editing",
        detailsMarkdown: "Creates follow-up work after acceptance.",
      },
    }, {
      userId: "local-board",
    });

    expect(created.kind).toBe("request_confirmation");
    expect(created.status).toBe("pending");

    const accepted = await interactionsSvc.acceptInteraction({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, created.id, {}, {
      userId: "local-board",
    });

    expect(accepted.createdIssues).toEqual([]);
    expect(accepted.interaction).toMatchObject({
      kind: "request_confirmation",
      status: "accepted",
      result: {
        version: 1,
        outcome: "accepted",
      },
      resolvedByUserId: "local-board",
    });

    const requiresReason = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Decline only with a reason?",
        rejectRequiresReason: true,
      },
    }, {
      userId: "local-board",
    });

    await expect(interactionsSvc.rejectInteraction({
      id: issueId,
      companyId,
    }, requiresReason.id, {}, {
      userId: "local-board",
    })).rejects.toThrow("A decline reason is required for this confirmation");
  });

  it("returns agent-authored request confirmations to the creating agent when a board user accepts", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Confirm a request",
      level: "task",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Senior Product Engineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Review the plan",
      status: "in_review",
      priority: "medium",
      assigneeUserId: "local-board",
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      continuationPolicy: "wake_assignee_on_accept",
      payload: {
        version: 1,
        prompt: "Approve this plan?",
        acceptLabel: "Approve plan",
        rejectLabel: "Ask for changes",
      },
    }, {
      agentId,
    });

    const accepted = await interactionsSvc.acceptInteraction({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, created.id, {}, {
      userId: "local-board",
    });

    expect(accepted.continuationIssue).toEqual({
      id: issueId,
      assigneeAgentId: agentId,
      assigneeUserId: null,
      status: "todo",
    });

    const updatedIssue = (await db.select().from(issues)).find((issue) => issue.id === issueId);
    expect(updatedIssue).toMatchObject({
      id: issueId,
      status: "todo",
      assigneeAgentId: agentId,
      assigneeUserId: null,
    });
  });

  it("expires supersedable request confirmations when a user comments", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const commentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Comment supersede",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Proceed with the current draft?",
        supersedeOnUserComment: true,
      },
    }, {
      userId: "local-board",
    });

    const expired = await interactionsSvc.expireRequestConfirmationsSupersededByComment({
      id: issueId,
      companyId,
    }, {
      id: commentId,
      authorUserId: "local-board",
    }, {
      userId: "local-board",
    });

    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      id: created.id,
      status: "expired",
      result: {
        version: 1,
        outcome: "superseded_by_comment",
        commentId,
      },
      resolvedByUserId: "local-board",
    });
  });

  it("expires request confirmations when the watched issue document revision changes", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const nextRevisionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Document target confirmation",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
    });
    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Plan",
      format: "markdown",
      latestBody: "v1",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: "plan",
    });
    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Plan",
      format: "markdown",
      body: "v1",
    });

    const created = await interactionsSvc.create({
      id: issueId,
      companyId,
    }, {
      kind: "request_confirmation",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        prompt: "Apply the plan document?",
        target: {
          type: "issue_document",
          issueId,
          documentId,
          key: "plan",
          revisionId,
          revisionNumber: 1,
        },
      },
    }, {
      userId: "local-board",
    });

    await db.insert(documentRevisions).values({
      id: nextRevisionId,
      companyId,
      documentId,
      revisionNumber: 2,
      title: "Plan",
      format: "markdown",
      body: "v2",
    });
    await db.update(documents).set({
      latestBody: "v2",
      latestRevisionId: nextRevisionId,
      latestRevisionNumber: 2,
    });

    const accepted = await interactionsSvc.acceptInteraction({
      id: issueId,
      companyId,
      goalId,
      projectId: null,
    }, created.id, {}, {
      userId: "local-board",
    });

    expect(accepted.interaction).toMatchObject({
      id: created.id,
      status: "expired",
      payload: {
        target: {
          type: "issue_document",
          key: "plan",
          revisionId: nextRevisionId,
          revisionNumber: 2,
        },
      },
      result: {
        version: 1,
        outcome: "stale_target",
        staleTarget: {
          type: "issue_document",
          key: "plan",
          revisionId,
        },
      },
    });
  });

  describe("start_work containers (plans a board user asked for)", () => {
    const REQUEST_TEXT = "Get the shop's Google reviews answered every day";

    async function seedAgent(companyId: string, role: string, name: string, status = "active") {
      const id = randomUUID();
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role,
        status,
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
    async function seedStartWorkPlan(args: {
      tasks: Array<{ clientKey: string; title: string; parentClientKey?: string; assigneeAgentId?: string }>;
      withAgents?: boolean;
    }) {
      const companyId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
      await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
      const engineerId = args.withAgents === false ? null : await seedAgent(companyId, "engineer", "Engineer");
      const ceoId = args.withAgents === false ? null : await seedAgent(companyId, "ceo", "Chief");

      const requestKey = randomUUID();
      const container = await issuesSvc.create(companyId, {
        title: `Request: ${REQUEST_TEXT}`,
        description: REQUEST_TEXT,
        status: "backlog",
        priority: "medium",
        originKind: START_WORK_ORIGIN_KIND,
        originId: requestKey,
        createdByUserId: "local-board",
      });
      const interaction = await interactionsSvc.create({ id: container.id, companyId }, {
        kind: "suggest_tasks",
        idempotencyKey: `start-work:${requestKey}`,
        continuationPolicy: "wake_assignee_on_accept",
        title: `Plan for: ${REQUEST_TEXT}`,
        payload: { version: 1, tasks: args.tasks },
      }, { userId: "local-board" });

      return { companyId, container, interaction, ceoId, engineerId };
    }

    async function loadIssue(id: string) {
      return (await db.select().from(issues).where(eq(issues.id, id)))[0]!;
    }

    async function childrenOf(containerId: string) {
      return db.select().from(issues).where(eq(issues.parentId, containerId));
    }

    it("accepting a plan on a start_work container moves it to todo, assigns the CEO-first owner, appends the Accepted plan section with every created identifier, and returns it as continuationIssue", async () => {
      const seeded = await seedStartWorkPlan({
        tasks: [
          { clientKey: "reply", title: "Reply to new reviews" },
          { clientKey: "digest", title: "Send a weekly digest", parentClientKey: "reply" },
          { clientKey: "skip-me", title: "Print flyers" },
        ],
      });

      const accepted = await interactionsSvc.acceptSuggestedTasks({
        id: seeded.container.id,
        companyId: seeded.companyId,
        projectId: null,
        goalId: null,
      }, seeded.interaction.id, { selectedClientKeys: ["reply", "digest"] }, { userId: "local-board" });

      expect(accepted.interaction.status).toBe("accepted");
      expect(accepted.createdIssues).toHaveLength(2);
      expect(accepted.continuationIssue).toEqual({
        id: seeded.container.id,
        assigneeAgentId: seeded.ceoId,
        assigneeUserId: null,
        status: "todo",
      });

      const container = await loadIssue(seeded.container.id);
      expect(container.status).toBe("todo");
      expect(container.assigneeAgentId).toBe(seeded.ceoId);
      expect(container.assigneeUserId).toBeNull();

      const children = await childrenOf(seeded.container.id);
      expect(children).toHaveLength(1);
      const grandchildren = await childrenOf(children[0]!.id);
      expect(grandchildren).toHaveLength(1);
      const createdIdentifiers = [children[0]!.identifier, grandchildren[0]!.identifier];
      expect(createdIdentifiers.every((identifier) => typeof identifier === "string" && identifier.length > 0)).toBe(true);

      expect(container.description).toBe(
        `${REQUEST_TEXT}\n\n## Accepted plan\n${createdIdentifiers.join("\n")}\nLeft out by the reviewer: Print flyers`,
      );
      expect(container.description).not.toMatch(/[–—]/);
    });

    it("accepting a plan on a start_work container with no usable agent leaves it in todo, unassigned, and returns continuationIssue with a null assignee", async () => {
      const seeded = await seedStartWorkPlan({
        tasks: [{ clientKey: "reply", title: "Reply to new reviews" }],
      });
      // The roster changed between drafting and accepting: everyone is paused.
      await db.update(agents).set({ status: "paused" }).where(eq(agents.companyId, seeded.companyId));

      const accepted = await interactionsSvc.acceptSuggestedTasks({
        id: seeded.container.id,
        companyId: seeded.companyId,
        projectId: null,
        goalId: null,
      }, seeded.interaction.id, {}, { userId: "local-board" });

      expect(accepted.continuationIssue).toEqual({
        id: seeded.container.id,
        assigneeAgentId: null,
        assigneeUserId: null,
        status: "todo",
      });
      const container = await loadIssue(seeded.container.id);
      expect(container.status).toBe("todo");
      expect(container.assigneeAgentId).toBeNull();
      expect(container.description).toContain("## Accepted plan");
    });

    it("a 409 from a second accept leaves the container in backlog and unassigned", async () => {
      // Claim first, hand-over after: when the claim is already taken the
      // hand-over never runs, whatever state the container is in.
      const stolen = await seedStartWorkPlan({
        tasks: [{ clientKey: "reply", title: "Reply to new reviews" }],
      });
      await db
        .update(issueThreadInteractions)
        .set({ status: "accepted", resolvedAt: new Date() })
        .where(eq(issueThreadInteractions.id, stolen.interaction.id));

      await expect(interactionsSvc.acceptSuggestedTasks({
        id: stolen.container.id,
        companyId: stolen.companyId,
        projectId: null,
        goalId: null,
      }, stolen.interaction.id, {}, { userId: "local-board" })).rejects.toMatchObject({
        status: 409,
        message: "Interaction has already been resolved",
      });

      const untouched = await loadIssue(stolen.container.id);
      expect(untouched.status).toBe("backlog");
      expect(untouched.assigneeAgentId).toBeNull();
      expect(untouched.description).toBe(REQUEST_TEXT);
      expect(await childrenOf(stolen.container.id)).toHaveLength(0);

      // Two people accept at once: exactly one wins, and the loser adds
      // nothing on top of the winner's hand-over.
      const raced = await seedStartWorkPlan({
        tasks: [{ clientKey: "reply", title: "Reply to new reviews" }],
      });
      const issueRef = { id: raced.container.id, companyId: raced.companyId, projectId: null, goalId: null };
      const outcomes = await Promise.allSettled([
        interactionsSvc.acceptSuggestedTasks(issueRef, raced.interaction.id, {}, { userId: "local-board" }),
        interactionsSvc.acceptSuggestedTasks(issueRef, raced.interaction.id, {}, { userId: "other-board" }),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const loser = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
      expect(loser.reason).toMatchObject({ status: 409 });
      expect(await childrenOf(raced.container.id)).toHaveLength(1);
      const handedOver = await loadIssue(raced.container.id);
      expect(handedOver.status).toBe("todo");
      expect(handedOver.assigneeAgentId).toBe(raced.ceoId);
    });

    it("a failed child creation rolls back the hand-over with the children", async () => {
      const seeded = await seedStartWorkPlan({
        tasks: [
          { clientKey: "first", title: "The one that fits" },
          { clientKey: "second", title: "The one over the cap" },
        ],
      });
      // 24 existing children: the first task still fits under the 25-child
      // cap, the second trips it, so the whole accept must unwind.
      for (let index = 0; index < 24; index += 1) {
        await db.insert(issues).values({
          id: randomUUID(),
          companyId: seeded.companyId,
          parentId: seeded.container.id,
          title: `Existing child ${index + 1}`,
          status: "todo",
          priority: "medium",
        });
      }

      await expect(interactionsSvc.acceptSuggestedTasks({
        id: seeded.container.id,
        companyId: seeded.companyId,
        projectId: null,
        goalId: null,
      }, seeded.interaction.id, {}, { userId: "local-board" })).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("maximum 25 child issues"),
      });

      const container = await loadIssue(seeded.container.id);
      expect(container.status).toBe("backlog");
      expect(container.assigneeAgentId).toBeNull();
      expect(container.description).toBe(REQUEST_TEXT);
      expect(await childrenOf(seeded.container.id)).toHaveLength(24);
      const [card] = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, seeded.interaction.id));
      expect(card?.status).toBe("pending");
      expect(card?.result).toBeNull();
    });

    it("rejecting a plan on a start_work container cancels the container and wakes nobody", async () => {
      const seeded = await seedStartWorkPlan({
        tasks: [{ clientKey: "reply", title: "Reply to new reviews" }],
      });

      const rejected = await interactionsSvc.rejectInteraction({
        id: seeded.container.id,
        companyId: seeded.companyId,
      }, seeded.interaction.id, { reason: "Not this week" }, { userId: "local-board" });

      expect(rejected.status).toBe("rejected");
      const container = await loadIssue(seeded.container.id);
      expect(container.status).toBe("cancelled");
      expect(container.cancelledAt).not.toBeNull();
      expect(container.assigneeAgentId).toBeNull();
      expect(await childrenOf(seeded.container.id)).toHaveLength(0);
      expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
      expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    });

    /**
     * The state after a board user accepts a plan: the container has left
     * backlog and belongs to the lead, who keeps proposing work on it. Every
     * card the lead files from here is an ordinary card, not the plan.
     */
    async function seedAcceptedStartWorkRequest() {
      const seeded = await seedStartWorkPlan({
        tasks: [{ clientKey: "reply", title: "Reply to new reviews" }],
      });
      const accepted = await interactionsSvc.acceptSuggestedTasks({
        id: seeded.container.id,
        companyId: seeded.companyId,
        projectId: null,
        goalId: null,
      }, seeded.interaction.id, {}, { userId: "local-board" });
      expect(accepted.continuationIssue?.status).toBe("todo");
      expect(accepted.continuationIssue?.assigneeAgentId).toBe(seeded.ceoId);
      return { ...seeded, childId: accepted.createdIssues[0]!.id };
    }

    it("accepting a later agent card on an already accepted start_work container leaves the container alone", async () => {
      const seeded = await seedAcceptedStartWorkRequest();
      // The lead delegated: the engineer is now running the container.
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: seeded.companyId,
        agentId: seeded.engineerId!,
        invocationSource: "manual",
        status: "running",
        startedAt: new Date(),
      });
      await db.update(issues).set({
        status: "in_progress",
        assigneeAgentId: seeded.engineerId,
        checkoutRunId: runId,
        executionRunId: runId,
        executionLockedAt: new Date(),
        startedAt: new Date(),
      }).where(eq(issues.id, seeded.container.id));

      const followUp = await interactionsSvc.create({ id: seeded.container.id, companyId: seeded.companyId }, {
        kind: "suggest_tasks",
        continuationPolicy: "wake_assignee_on_accept",
        sourceRunId: runId,
        payload: { version: 1, tasks: [{ clientKey: "a", title: "Follow-up A" }] },
      }, { agentId: seeded.engineerId! });

      const accepted = await interactionsSvc.acceptSuggestedTasks({
        id: seeded.container.id,
        companyId: seeded.companyId,
        projectId: null,
        goalId: null,
      }, followUp.id, {}, { userId: "local-board" });

      expect(accepted.continuationIssue).toBeNull();
      expect(accepted.createdIssues).toHaveLength(1);
      const container = await loadIssue(seeded.container.id);
      expect({
        status: container.status,
        assigneeAgentId: container.assigneeAgentId,
        executionRunId: container.executionRunId,
        checkoutRunId: container.checkoutRunId,
        acceptedPlanSections: (container.description ?? "").match(/## Accepted plan/g)?.length ?? 0,
      }).toEqual({
        status: "in_progress",
        assigneeAgentId: seeded.engineerId,
        executionRunId: runId,
        checkoutRunId: runId,
        acceptedPlanSections: 1,
      });
    });

    it("rejecting a later agent card on an already accepted start_work container does not cancel the request", async () => {
      const seeded = await seedAcceptedStartWorkRequest();

      const followUp = await interactionsSvc.create({ id: seeded.container.id, companyId: seeded.companyId }, {
        kind: "suggest_tasks",
        continuationPolicy: "wake_assignee_on_accept",
        payload: {
          version: 1,
          tasks: [
            { clientKey: "a", title: "Follow-up A" },
            { clientKey: "b", title: "Follow-up B" },
          ],
        },
      }, { agentId: seeded.ceoId! });
      const [followUpRow] = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, followUp.id));
      expect(followUpRow?.createdByAgentId).toBe(seeded.ceoId);
      expect(followUpRow?.createdByUserId).toBeNull();

      const rejected = await interactionsSvc.rejectInteraction({
        id: seeded.container.id,
        companyId: seeded.companyId,
      }, followUp.id, { reason: "Not those" }, { userId: "local-board" });
      expect(rejected.status).toBe("rejected");

      const container = await loadIssue(seeded.container.id);
      const child = await loadIssue(seeded.childId);
      expect({
        status: container.status,
        cancelled: container.cancelledAt !== null,
        assigneeAgentId: container.assigneeAgentId,
        childStatus: child.status,
      }).toEqual({
        status: "todo",
        cancelled: false,
        assigneeAgentId: seeded.ceoId,
        childStatus: "todo",
      });
    });

    it("accepting or rejecting suggest_tasks on an ordinary issue does not touch the host issue (existing behaviour pinned)", async () => {
      const companyId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
      await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
      const agentId = await seedAgent(companyId, "ceo", "Chief");
      await seedAgent(companyId, "engineer", "Engineer");

      const makeOrdinaryIssue = async () => {
        const issueId = randomUUID();
        await db.insert(issues).values({
          id: issueId,
          companyId,
          title: "Ordinary work",
          description: "Plain description",
          status: "in_progress",
          priority: "medium",
          assigneeAgentId: agentId,
        });
        const interaction = await interactionsSvc.create({ id: issueId, companyId }, {
          kind: "suggest_tasks",
          continuationPolicy: "wake_assignee_on_accept",
          payload: { version: 1, tasks: [{ clientKey: "one", title: "Follow up" }] },
        }, { agentId });
        return { issueId, interaction };
      };

      const acceptedHost = await makeOrdinaryIssue();
      const accepted = await interactionsSvc.acceptSuggestedTasks({
        id: acceptedHost.issueId,
        companyId,
        projectId: null,
        goalId: null,
      }, acceptedHost.interaction.id, {}, { userId: "local-board" });
      expect(accepted.continuationIssue).toBeNull();
      expect(accepted.createdIssues).toHaveLength(1);
      const acceptedIssue = await loadIssue(acceptedHost.issueId);
      expect(acceptedIssue).toMatchObject({
        status: "in_progress",
        assigneeAgentId: agentId,
        description: "Plain description",
      });

      const rejectedHost = await makeOrdinaryIssue();
      await interactionsSvc.rejectInteraction({
        id: rejectedHost.issueId,
        companyId,
      }, rejectedHost.interaction.id, { reason: "No" }, { userId: "local-board" });
      const rejectedIssue = await loadIssue(rejectedHost.issueId);
      expect(rejectedIssue).toMatchObject({
        status: "in_progress",
        assigneeAgentId: agentId,
        description: "Plain description",
        cancelledAt: null,
      });
    });
  });
});
