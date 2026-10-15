import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  goals,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueInboxArchives,
  issueRelations,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { agentService } from "../services/agents.ts";
import { clampIssueListLimit, ISSUE_LIST_MAX_LIMIT, issueService } from "../services/issues.ts";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "../services/issue-execution-policy.ts";
import { buildProjectMentionHref } from "@paperclipai/shared";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("issue list limit helpers", () => {
  it("clamps untrusted issue-list limits to the server maximum", () => {
    expect(clampIssueListLimit(0)).toBe(1);
    expect(clampIssueListLimit(25.9)).toBe(25);
    expect(clampIssueListLimit(ISSUE_LIST_MAX_LIMIT + 10)).toBe(ISSUE_LIST_MAX_LIMIT);
  });
});

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService.list participantAgentId", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-service-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  }, 90_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns issues an agent participated in across the supported signals", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "OtherAgent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const assignedIssueId = randomUUID();
    const createdIssueId = randomUUID();
    const commentedIssueId = randomUUID();
    const activityIssueId = randomUUID();
    const excludedIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: assignedIssueId,
        companyId,
        title: "Assigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        createdByAgentId: otherAgentId,
      },
      {
        id: createdIssueId,
        companyId,
        title: "Created issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
      {
        id: commentedIssueId,
        companyId,
        title: "Commented issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
      },
      {
        id: activityIssueId,
        companyId,
        title: "Activity issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
      },
      {
        id: excludedIssueId,
        companyId,
        title: "Excluded issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
        assigneeAgentId: otherAgentId,
      },
    ]);

    await db.insert(issueComments).values({
      companyId,
      issueId: commentedIssueId,
      authorAgentId: agentId,
      body: "Investigating this issue.",
    });

    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: activityIssueId,
      agentId,
      details: { changed: true },
    });

    const result = await svc.list(companyId, { participantAgentId: agentId });
    const resultIds = new Set(result.map((issue) => issue.id));

    expect(resultIds).toEqual(new Set([
      assignedIssueId,
      createdIssueId,
      commentedIssueId,
      activityIssueId,
    ]));
    expect(resultIds.has(excludedIssueId)).toBe(false);
  });

  it("combines participation filtering with search", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

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

    const matchedIssueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: matchedIssueId,
        companyId,
        title: "Invoice reconciliation",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
      {
        id: otherIssueId,
        companyId,
        title: "Weekly planning",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
    ]);

    const result = await svc.list(companyId, {
      participantAgentId: agentId,
      q: "invoice",
    });

    expect(result.map((issue) => issue.id)).toEqual([matchedIssueId]);
  });

  it("applies result limits to issue search", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const exactIdentifierId = randomUUID();
    const titleMatchId = randomUUID();
    const descriptionMatchId = randomUUID();

    await db.insert(issues).values([
      {
        id: exactIdentifierId,
        companyId,
        issueNumber: 42,
        identifier: "PAP-42",
        title: "Completely unrelated",
        status: "todo",
        priority: "medium",
      },
      {
        id: titleMatchId,
        companyId,
        title: "Search ranking issue",
        status: "todo",
        priority: "medium",
      },
      {
        id: descriptionMatchId,
        companyId,
        title: "Another item",
        description: "Contains the search keyword",
        status: "todo",
        priority: "medium",
      },
    ]);

    const result = await svc.list(companyId, {
      q: "search",
      limit: 2,
    });

    expect(result.map((issue) => issue.id)).toEqual([titleMatchId, descriptionMatchId]);
  });

  it("ranks comment matches ahead of description-only matches", async () => {
    const companyId = randomUUID();
    const commentMatchId = randomUUID();
    const descriptionMatchId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: commentMatchId,
        companyId,
        title: "Comment match",
        status: "todo",
        priority: "medium",
      },
      {
        id: descriptionMatchId,
        companyId,
        title: "Description match",
        description: "Contains pull/3303 in the description",
        status: "todo",
        priority: "medium",
      },
    ]);

    await db.insert(issueComments).values({
      companyId,
      issueId: commentMatchId,
      body: "Reference: https://github.com/paperclipai/paperclip/pull/3303",
    });

    const result = await svc.list(companyId, {
      q: "pull/3303",
      limit: 2,
      includeRoutineExecutions: true,
    });

    expect(result.map((issue) => issue.id)).toEqual([commentMatchId, descriptionMatchId]);
  });

  it("filters issue lists to the full descendant tree for a root issue", async () => {
    const companyId = randomUUID();
    const rootId = randomUUID();
    const childId = randomUUID();
    const grandchildId = randomUUID();
    const siblingId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: rootId,
        companyId,
        title: "Root",
        status: "todo",
        priority: "medium",
      },
      {
        id: childId,
        companyId,
        parentId: rootId,
        title: "Child",
        status: "todo",
        priority: "medium",
      },
      {
        id: grandchildId,
        companyId,
        parentId: childId,
        title: "Grandchild",
        status: "todo",
        priority: "medium",
      },
      {
        id: siblingId,
        companyId,
        title: "Sibling",
        status: "todo",
        priority: "medium",
      },
    ]);

    const result = await svc.list(companyId, { descendantOf: rootId });

    expect(new Set(result.map((issue) => issue.id))).toEqual(new Set([childId, grandchildId]));
  });

  it("combines descendant filtering with search", async () => {
    const companyId = randomUUID();
    const rootId = randomUUID();
    const childId = randomUUID();
    const grandchildId = randomUUID();
    const outsideMatchId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: rootId,
        companyId,
        title: "Root",
        status: "todo",
        priority: "medium",
      },
      {
        id: childId,
        companyId,
        parentId: rootId,
        title: "Relevant parent",
        status: "todo",
        priority: "medium",
      },
      {
        id: grandchildId,
        companyId,
        parentId: childId,
        title: "Needle grandchild",
        status: "todo",
        priority: "medium",
      },
      {
        id: outsideMatchId,
        companyId,
        title: "Needle outside",
        status: "todo",
        priority: "medium",
      },
    ]);

    const result = await svc.list(companyId, { descendantOf: rootId, q: "needle" });

    expect(result.map((issue) => issue.id)).toEqual([grandchildId]);
  });

  it("accepts issue identifiers through getById", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1064,
      identifier: "PAP-1064",
      title: "Feedback votes error",
      status: "todo",
      priority: "medium",
      createdByUserId: "user-1",
    });

    const issue = await svc.getById("PAP-1064");

    expect(issue).toEqual(
      expect.objectContaining({
        id: issueId,
        identifier: "PAP-1064",
      }),
    );
  });

  it("returns null instead of throwing for malformed non-uuid issue refs", async () => {
    await expect(svc.getById("not-a-uuid")).resolves.toBeNull();
  });
  it("filters issues by execution workspace id", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const targetWorkspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const linkedIssueId = randomUUID();
    const otherLinkedIssueId = randomUUID();
    const unlinkedIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(executionWorkspaces).values([
      {
        id: targetWorkspaceId,
        companyId,
        projectId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Target workspace",
        status: "active",
        providerType: "local_fs",
      },
      {
        id: otherWorkspaceId,
        companyId,
        projectId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Other workspace",
        status: "active",
        providerType: "local_fs",
      },
    ]);

    await db.insert(issues).values([
      {
        id: linkedIssueId,
        companyId,
        projectId,
        title: "Linked issue",
        status: "todo",
        priority: "medium",
        executionWorkspaceId: targetWorkspaceId,
      },
      {
        id: otherLinkedIssueId,
        companyId,
        projectId,
        title: "Other linked issue",
        status: "todo",
        priority: "medium",
        executionWorkspaceId: otherWorkspaceId,
      },
      {
        id: unlinkedIssueId,
        companyId,
        projectId,
        title: "Unlinked issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    const result = await svc.list(companyId, { executionWorkspaceId: targetWorkspaceId });

    expect(result.map((issue) => issue.id)).toEqual([linkedIssueId]);
  });

  it("filters issues by generic workspace id across execution and project workspace links", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const executionLinkedIssueId = randomUUID();
    const projectLinkedIssueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Feature workspace",
      sourceType: "local_path",
      visibility: "default",
      isPrimary: false,
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Execution workspace",
      status: "active",
      providerType: "git_worktree",
    });

    await db.insert(issues).values([
      {
        id: executionLinkedIssueId,
        companyId,
        projectId,
        projectWorkspaceId,
        title: "Execution linked issue",
        status: "done",
        priority: "medium",
        executionWorkspaceId,
      },
      {
        id: projectLinkedIssueId,
        companyId,
        projectId,
        projectWorkspaceId,
        title: "Project linked issue",
        status: "todo",
        priority: "medium",
      },
      {
        id: otherIssueId,
        companyId,
        projectId,
        title: "Other issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    const executionResult = await svc.list(companyId, { workspaceId: executionWorkspaceId });
    const projectResult = await svc.list(companyId, { workspaceId: projectWorkspaceId });

    expect(executionResult.map((issue) => issue.id)).toEqual([executionLinkedIssueId]);
    expect(projectResult.map((issue) => issue.id).sort()).toEqual([executionLinkedIssueId, projectLinkedIssueId].sort());
  });

  it("hides archived inbox issues until new external activity arrives", async () => {
    const companyId = randomUUID();
    const userId = "user-1";
    const otherUserId = "user-2";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const visibleIssueId = randomUUID();
    const archivedIssueId = randomUUID();
    const resurfacedIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: visibleIssueId,
        companyId,
        title: "Visible issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        createdAt: new Date("2026-03-26T10:00:00.000Z"),
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: archivedIssueId,
        companyId,
        title: "Archived issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        createdAt: new Date("2026-03-26T11:00:00.000Z"),
        updatedAt: new Date("2026-03-26T11:00:00.000Z"),
      },
      {
        id: resurfacedIssueId,
        companyId,
        title: "Resurfaced issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T12:00:00.000Z"),
      },
    ]);

    await svc.archiveInbox(companyId, archivedIssueId, userId, new Date("2026-03-26T12:30:00.000Z"));
    await svc.archiveInbox(companyId, resurfacedIssueId, userId, new Date("2026-03-26T13:00:00.000Z"));

    await db.insert(issueComments).values({
      companyId,
      issueId: resurfacedIssueId,
      authorUserId: otherUserId,
      body: "This should bring the issue back into Mine.",
      createdAt: new Date("2026-03-26T13:30:00.000Z"),
      updatedAt: new Date("2026-03-26T13:30:00.000Z"),
    });

    const archivedFiltered = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });

    expect(archivedFiltered.map((issue) => issue.id)).toEqual([
      resurfacedIssueId,
      visibleIssueId,
    ]);

    await svc.unarchiveInbox(companyId, archivedIssueId, userId);

    const afterUnarchive = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });

    expect(new Set(afterUnarchive.map((issue) => issue.id))).toEqual(new Set([
      visibleIssueId,
      archivedIssueId,
      resurfacedIssueId,
    ]));
  });

  it("resurfaces archived issue when status/updatedAt changes after archiving", async () => {
    const companyId = randomUUID();
    const userId = "user-1";
    const otherUserId = "user-2";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const issueId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue with old comment then status change",
      status: "todo",
      priority: "medium",
      createdByUserId: userId,
      createdAt: new Date("2026-03-26T10:00:00.000Z"),
      updatedAt: new Date("2026-03-26T10:00:00.000Z"),
    });

    // Old external comment before archiving
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorUserId: otherUserId,
      body: "Old comment before archive",
      createdAt: new Date("2026-03-26T11:00:00.000Z"),
      updatedAt: new Date("2026-03-26T11:00:00.000Z"),
    });

    // Archive after seeing the comment
    await svc.archiveInbox(
      companyId,
      issueId,
      userId,
      new Date("2026-03-26T12:00:00.000Z"),
    );

    // Verify it's archived
    const afterArchive = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });
    expect(afterArchive.map((i) => i.id)).not.toContain(issueId);

    // Status/work update changes updatedAt (no new comment)
    await db
      .update(issues)
      .set({
        status: "in_progress",
        updatedAt: new Date("2026-03-26T13:00:00.000Z"),
      })
      .where(eq(issues.id, issueId));

    // Should resurface because updatedAt > archivedAt
    const afterUpdate = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });
    expect(afterUpdate.map((i) => i.id)).toContain(issueId);
  });

  it("sorts and exposes last activity from comments and non-local issue activity logs", async () => {
    const companyId = randomUUID();
    const olderIssueId = randomUUID();
    const commentIssueId = randomUUID();
    const activityIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: olderIssueId,
        companyId,
        title: "Older issue",
        status: "todo",
        priority: "medium",
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: commentIssueId,
        companyId,
        title: "Comment activity issue",
        status: "todo",
        priority: "medium",
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: activityIssueId,
        companyId,
        title: "Logged activity issue",
        status: "todo",
        priority: "medium",
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
    ]);

    await db.insert(issueComments).values({
      companyId,
      issueId: commentIssueId,
      body: "New comment without touching issue.updatedAt",
      createdAt: new Date("2026-03-26T11:00:00.000Z"),
      updatedAt: new Date("2026-03-26T11:00:00.000Z"),
    });

    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "system",
        actorId: "system",
        action: "issue.document_updated",
        entityType: "issue",
        entityId: activityIssueId,
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
      },
      {
        companyId,
        actorType: "user",
        actorId: "user-1",
        action: "issue.read_marked",
        entityType: "issue",
        entityId: olderIssueId,
        createdAt: new Date("2026-03-26T13:00:00.000Z"),
      },
    ]);

    const result = await svc.list(companyId, {});

    expect(result.map((issue) => issue.id)).toEqual([
      activityIssueId,
      commentIssueId,
      olderIssueId,
    ]);
    expect(result.find((issue) => issue.id === activityIssueId)?.lastActivityAt?.toISOString()).toBe(
      "2026-03-26T12:00:00.000Z",
    );
    expect(result.find((issue) => issue.id === commentIssueId)?.lastActivityAt?.toISOString()).toBe(
      "2026-03-26T11:00:00.000Z",
    );
    expect(result.find((issue) => issue.id === olderIssueId)?.lastActivityAt?.toISOString()).toBe(
      "2026-03-26T10:00:00.000Z",
    );
  });

  it("paginates earlier comments in descending order from an anchor comment", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const firstCommentId = randomUUID();
    const anchorCommentId = randomUUID();
    const latestCommentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Paged comments issue",
      status: "todo",
      priority: "medium",
    });

    await db.insert(issueComments).values([
      {
        id: firstCommentId,
        companyId,
        issueId,
        body: "First comment",
        createdAt: new Date("2026-03-26T10:00:00.000Z"),
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: anchorCommentId,
        companyId,
        issueId,
        body: "Anchor comment",
        createdAt: new Date("2026-03-26T11:00:00.000Z"),
        updatedAt: new Date("2026-03-26T11:00:00.000Z"),
      },
      {
        id: latestCommentId,
        companyId,
        issueId,
        body: "Latest comment",
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T12:00:00.000Z"),
      },
    ]);

    const comments = await svc.listComments(issueId, {
      afterCommentId: anchorCommentId,
      order: "desc",
      limit: 50,
    });

    expect(comments.map((comment) => comment.id)).toEqual([firstCommentId]);
  });

  it("includes blockedBy summaries on list rows in one batched pass", async () => {
    const companyId = randomUUID();
    const blockerId = randomUUID();
    const blockedId = randomUUID();
    const unblockedId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Blocker issue",
        status: "todo",
        priority: "high",
      },
      {
        id: blockedId,
        companyId,
        title: "Blocked issue",
        status: "blocked",
        priority: "medium",
      },
      {
        id: unblockedId,
        companyId,
        title: "Unblocked issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedId,
      type: "blocks",
    });

    const defaultResult = await svc.list(companyId);
    expect(defaultResult.find((issue) => issue.id === blockedId)?.blockedBy).toBeUndefined();

    const result = await svc.list(companyId, { includeBlockedBy: true });
    const byId = new Map(result.map((issue) => [issue.id, issue]));

    expect(byId.get(blockedId)?.blockedBy).toEqual([
      expect.objectContaining({
        id: blockerId,
        identifier: null,
        title: "Blocker issue",
        status: "todo",
        priority: "high",
      }),
    ]);
    expect(byId.get(blockerId)?.blockedBy).toEqual([]);
    expect(byId.get(unblockedId)?.blockedBy).toEqual([]);
  });

  it("trims list payload fields that can grow large on issue index routes", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const longDescription = "x".repeat(5_000);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Large issue",
      description: longDescription,
      status: "todo",
      priority: "medium",
      executionPolicy: { stages: Array.from({ length: 20 }, (_, index) => ({ index, kind: "review", notes: "y".repeat(400) })) },
      executionState: { history: Array.from({ length: 20 }, (_, index) => ({ index, body: "z".repeat(400) })) },
      executionWorkspaceSettings: { notes: "w".repeat(2_000) },
    });

    const [result] = await svc.list(companyId);

    expect(result).toBeTruthy();
    expect(result?.description).toHaveLength(1200);
    expect(result?.executionPolicy).toBeNull();
    expect(result?.executionState).toBeNull();
    expect(result?.executionWorkspaceSettings).toBeNull();
  });

  it("does not let description preview truncation split multibyte characters", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const description = `${"x".repeat(1199)}— still valid after truncation`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Multibyte boundary issue",
      description,
      status: "todo",
      priority: "medium",
    });

    const [result] = await svc.list(companyId);

    expect(result?.description).toHaveLength(1200);
    expect(result?.description?.endsWith("—")).toBe(true);
  });
});

describeEmbeddedPostgres("issueService automatic reviewer defaults", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-automatic-reviewer-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 90_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedReviewedAgent() {
    const companyId = randomUUID();
    const reviewerId = randomUUID();
    const workerId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Automatic Review Company",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: reviewerId,
        companyId,
        name: "Reviewer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
      },
      {
        id: workerId,
        companyId,
        name: "Worker",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        defaultReviewerAgentId: reviewerId,
      },
    ]);
    return { companyId, reviewerId, workerId };
  }

  it("adds a review stage when the assigned agent has an automatic reviewer", async () => {
    const { companyId, reviewerId, workerId } = await seedReviewedAgent();

    const issue = await svc.create(companyId, {
      title: "Review this automatically",
      assigneeAgentId: workerId,
    });

    expect(issue.executionPolicy).toMatchObject({
      mode: "normal",
      commentRequired: true,
      stages: [
        {
          type: "review",
          approvalsNeeded: 1,
          participants: [{ type: "agent", agentId: reviewerId, userId: null }],
        },
      ],
    });
  });

  it("starts review when a task is created as done for an agent with an automatic reviewer", async () => {
    const { companyId, reviewerId, workerId } = await seedReviewedAgent();

    const issue = await svc.create(companyId, {
      title: "Create directly into review",
      status: "done",
      assigneeAgentId: workerId,
    });

    expect(issue.status).toBe("in_review");
    expect(issue.assigneeAgentId).toBe(reviewerId);
    expect(issue.completedAt).toBeNull();
    expect(issue.executionState).toMatchObject({
      status: "pending",
      currentParticipant: { type: "agent", agentId: reviewerId },
      returnAssignee: { type: "agent", agentId: workerId },
    });
  });

  it("preserves the automatic policy while review hands the task between agents", async () => {
    const { companyId, reviewerId, workerId } = await seedReviewedAgent();
    const issue = await svc.create(companyId, {
      title: "Keep policy during review",
      status: "in_progress",
      assigneeAgentId: workerId,
    });
    const policy = normalizeIssueExecutionPolicy(issue.executionPolicy)!;

    const submission = applyIssueExecutionPolicyTransition({
      issue,
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: workerId },
    });
    const inReview = await svc.update(issue.id, {
      ...submission.patch,
      preserveExecutionPolicy: submission.workflowControlledAssignment === true,
    });

    expect(inReview).toMatchObject({
      status: "in_review",
      assigneeAgentId: reviewerId,
      executionPolicy: policy,
      executionPolicyExplicit: false,
    });

    const changesRequested = applyIssueExecutionPolicyTransition({
      issue: inReview!,
      policy,
      requestedStatus: "in_progress",
      requestedAssigneePatch: {},
      actor: { agentId: reviewerId },
      commentBody: "Please revise this work.",
    });
    const returned = await svc.update(issue.id, {
      ...changesRequested.patch,
      preserveExecutionPolicy: changesRequested.workflowControlledAssignment === true,
    });

    expect(returned).toMatchObject({
      status: "in_progress",
      assigneeAgentId: workerId,
      executionPolicy: policy,
      executionPolicyExplicit: false,
    });
    expect(returned?.executionState).toMatchObject({
      status: "changes_requested",
      currentParticipant: { type: "agent", agentId: reviewerId },
      returnAssignee: { type: "agent", agentId: workerId },
    });
  });

  it("keeps an explicit null policy as an opt-out", async () => {
    const { companyId, workerId } = await seedReviewedAgent();

    const issue = await svc.create(companyId, {
      title: "No review for this task",
      assigneeAgentId: workerId,
      executionPolicy: null,
    });

    expect(issue.executionPolicy).toBeNull();
  });

  it("adds the review stage when an unassigned task is assigned later", async () => {
    const { companyId, reviewerId, workerId } = await seedReviewedAgent();
    const unassigned = await svc.create(companyId, { title: "Assign later" });

    const assigned = await svc.update(unassigned.id, { assigneeAgentId: workerId });

    expect(assigned?.executionPolicy).toMatchObject({
      stages: [
        {
          type: "review",
          participants: [{ type: "agent", agentId: reviewerId }],
        },
      ],
    });
  });

  it("preserves an explicit null policy when an unassigned task is assigned later", async () => {
    const { companyId, workerId } = await seedReviewedAgent();
    const unassigned = await svc.create(companyId, {
      title: "Keep assignment opt-out",
      executionPolicy: null,
    });

    const assigned = await svc.update(unassigned.id, { assigneeAgentId: workerId });

    expect(assigned?.executionPolicy).toBeNull();
    expect(assigned?.executionPolicyExplicit).toBe(true);
  });

  it("rejects a stale automatic-policy assignment after an explicit opt-out", async () => {
    const { companyId, workerId } = await seedReviewedAgent();
    const unassigned = await svc.create(companyId, {
      title: "Reject stale automatic policy",
      executionPolicy: null,
    });
    const staleAutomaticPolicy = await svc.defaultExecutionPolicyForAssignee(companyId, workerId);

    await expect(svc.update(unassigned.id, {
      assigneeAgentId: workerId,
      executionPolicy: staleAutomaticPolicy,
      executionPolicyExplicit: false,
    })).rejects.toMatchObject({
      status: 409,
      message: "Issue review policy changed during assignment. Retry the update.",
    });
    const preserved = await svc.getById(unassigned.id);
    expect(preserved?.assigneeAgentId).toBeNull();
    expect(preserved?.executionPolicy).toBeNull();
    expect(preserved?.executionPolicyExplicit).toBe(true);
  });

  it("rejects a stale reviewer decision after concurrent reassignment", async () => {
    const { companyId, reviewerId, workerId } = await seedReviewedAgent();
    const inReview = await svc.create(companyId, {
      title: "Reject delayed approval",
      status: "done",
      assigneeAgentId: workerId,
    });
    const stalePolicy = normalizeIssueExecutionPolicy(inReview.executionPolicy)!;
    const staleState = parseIssueExecutionState(inReview.executionState)!;
    const approval = applyIssueExecutionPolicyTransition({
      issue: inReview,
      policy: stalePolicy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: reviewerId },
      commentBody: "Approved before reassignment",
    });

    const nextReviewerId = randomUUID();
    const nextWorkerId = randomUUID();
    await db.insert(agents).values([
      {
        id: nextReviewerId,
        companyId,
        name: "Next Reviewer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
      },
      {
        id: nextWorkerId,
        companyId,
        name: "Next Worker",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        defaultReviewerAgentId: nextReviewerId,
      },
    ]);
    const nextPolicy = await svc.defaultExecutionPolicyForAssignee(companyId, nextWorkerId);
    await db.update(issues)
      .set({
        status: "in_progress",
        assigneeAgentId: nextWorkerId,
        executionPolicy: nextPolicy,
        executionState: null,
      })
      .where(eq(issues.id, inReview.id));

    await expect(svc.update(inReview.id, {
      status: "done",
      ...approval.patch,
      preserveExecutionPolicy: true,
      expectedExecutionPolicy: stalePolicy,
      expectedExecutionState: staleState,
    })).rejects.toMatchObject({
      status: 409,
      message: "Issue review state changed. Retry the update.",
    });
    const preserved = await svc.getById(inReview.id);
    expect(preserved?.status).toBe("in_progress");
    expect(preserved?.assigneeAgentId).toBe(nextWorkerId);
    expect(preserved?.executionPolicy).toEqual(nextPolicy);
    expect(preserved?.executionState).toBeNull();
  });

  it("adds the review stage when checkout assigns an unassigned task", async () => {
    const { companyId, reviewerId, workerId } = await seedReviewedAgent();
    const unassigned = await svc.create(companyId, { title: "Checkout later" });

    const checkedOut = await svc.checkout(unassigned.id, workerId, ["backlog"], null);

    expect(checkedOut.executionPolicy).toMatchObject({
      stages: [
        {
          type: "review",
          participants: [{ type: "agent", agentId: reviewerId }],
        },
      ],
    });
    expect(checkedOut.executionPolicyExplicit).toBe(false);
  });

  it("replaces an inherited automatic policy when a different agent checks out", async () => {
    const { companyId, workerId } = await seedReviewedAgent();
    const nextReviewerId = randomUUID();
    const nextWorkerId = randomUUID();
    await db.insert(agents).values([
      {
        id: nextReviewerId,
        companyId,
        name: "Next Reviewer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
      },
      {
        id: nextWorkerId,
        companyId,
        name: "Next Worker",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        defaultReviewerAgentId: nextReviewerId,
      },
    ]);
    const assigned = await svc.create(companyId, {
      title: "Reassign automatic reviewer on checkout",
      status: "in_progress",
      assigneeAgentId: workerId,
    });
    await svc.release(assigned.id, workerId, null);

    const checkedOut = await svc.checkout(assigned.id, nextWorkerId, ["todo"], null);

    expect(checkedOut.executionPolicy).toMatchObject({
      stages: [{ participants: [{ type: "agent", agentId: nextReviewerId }] }],
    });
    expect(checkedOut.executionPolicyExplicit).toBe(false);
    const policy = normalizeIssueExecutionPolicy(checkedOut.executionPolicy)!;
    const completion = applyIssueExecutionPolicyTransition({
      issue: checkedOut,
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: nextWorkerId },
    });
    expect(completion.patch).toMatchObject({
      status: "in_review",
      assigneeAgentId: nextReviewerId,
      executionState: {
        status: "pending",
        returnAssignee: { type: "agent", agentId: nextWorkerId },
      },
    });
  });

  it("starts a fresh automatic review after completed work is released and reassigned", async () => {
    const { companyId, reviewerId, workerId } = await seedReviewedAgent();
    const nextReviewerId = randomUUID();
    const nextWorkerId = randomUUID();
    await db.insert(agents).values([
      {
        id: nextReviewerId,
        companyId,
        name: "Fresh Reviewer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
      },
      {
        id: nextWorkerId,
        companyId,
        name: "Fresh Worker",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        defaultReviewerAgentId: nextReviewerId,
      },
    ]);
    const inReview = await svc.create(companyId, {
      title: "Review reassigned completed work",
      status: "done",
      assigneeAgentId: workerId,
    });
    const firstPolicy = normalizeIssueExecutionPolicy(inReview.executionPolicy)!;
    const approval = applyIssueExecutionPolicyTransition({
      issue: inReview,
      policy: firstPolicy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: reviewerId },
      commentBody: "Approved.",
    });
    const completed = await svc.update(inReview.id, {
      status: "done",
      ...approval.patch,
      preserveExecutionPolicy: approval.workflowControlledAssignment === true,
    });
    expect(completed?.executionState).toMatchObject({ status: "completed" });
    await svc.release(inReview.id, reviewerId, null);

    const checkedOut = await svc.checkout(inReview.id, nextWorkerId, ["todo"], null);

    expect(checkedOut.executionState).toBeNull();
    expect(checkedOut.executionPolicy).toMatchObject({
      stages: [{ participants: [{ type: "agent", agentId: nextReviewerId }] }],
    });
    const nextPolicy = normalizeIssueExecutionPolicy(checkedOut.executionPolicy)!;
    const completion = applyIssueExecutionPolicyTransition({
      issue: checkedOut,
      policy: nextPolicy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: nextWorkerId },
    });
    expect(completion.patch).toMatchObject({
      status: "in_review",
      assigneeAgentId: nextReviewerId,
      executionState: { status: "pending" },
    });
  });

  it("starts a fresh automatic review when changes-requested work moves to a new worker", async () => {
    const { companyId, reviewerId, workerId } = await seedReviewedAgent();
    const nextReviewerId = randomUUID();
    const nextWorkerId = randomUUID();
    await db.insert(agents).values([
      {
        id: nextReviewerId,
        companyId,
        name: "Changes Reviewer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
      },
      {
        id: nextWorkerId,
        companyId,
        name: "Changes Worker",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        defaultReviewerAgentId: nextReviewerId,
      },
    ]);
    const inReview = await svc.create(companyId, {
      title: "Move requested changes to new worker",
      status: "done",
      assigneeAgentId: workerId,
    });
    const firstPolicy = normalizeIssueExecutionPolicy(inReview.executionPolicy)!;
    const rejection = applyIssueExecutionPolicyTransition({
      issue: inReview,
      policy: firstPolicy,
      requestedStatus: "in_progress",
      requestedAssigneePatch: {},
      actor: { agentId: reviewerId },
      commentBody: "Please revise.",
    });
    const changesRequested = await svc.update(inReview.id, {
      ...rejection.patch,
      preserveExecutionPolicy: rejection.workflowControlledAssignment === true,
    });
    expect(changesRequested?.executionState).toMatchObject({ status: "changes_requested" });
    await svc.release(inReview.id, workerId, null);

    const checkedOut = await svc.checkout(inReview.id, nextWorkerId, ["todo"], null);

    expect(checkedOut.executionState).toBeNull();
    expect(checkedOut.executionPolicy).toMatchObject({
      stages: [{ participants: [{ type: "agent", agentId: nextReviewerId }] }],
    });
    const nextPolicy = normalizeIssueExecutionPolicy(checkedOut.executionPolicy)!;
    const completion = applyIssueExecutionPolicyTransition({
      issue: checkedOut,
      policy: nextPolicy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: nextWorkerId },
    });
    expect(completion.patch).toMatchObject({
      status: "in_review",
      assigneeAgentId: nextReviewerId,
      executionState: {
        status: "pending",
        returnAssignee: { type: "agent", agentId: nextWorkerId },
      },
    });
  });

  it("backfills the automatic policy when checkout finds a direct assignment", async () => {
    const { companyId, reviewerId, workerId } = await seedReviewedAgent();
    const issue = await svc.create(companyId, { title: "Direct assignment without policy" });
    await db.update(issues).set({ assigneeAgentId: workerId }).where(eq(issues.id, issue.id));

    const checkedOut = await svc.checkout(issue.id, workerId, ["backlog"], null);

    expect(checkedOut.executionPolicy).toMatchObject({
      stages: [{ participants: [{ type: "agent", agentId: reviewerId }] }],
    });
    expect(checkedOut.executionPolicyExplicit).toBe(false);
  });

  it("does not check out work assigned to another agent", async () => {
    const { companyId, workerId } = await seedReviewedAgent();
    const nextWorkerId = randomUUID();
    await db.insert(agents).values({
      id: nextWorkerId,
      companyId,
      name: "Waiting Worker",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
    });
    const assigned = await svc.create(companyId, {
      title: "Do not take a stale assignment",
      assigneeAgentId: workerId,
    });

    await expect(svc.checkout(assigned.id, nextWorkerId, ["backlog"], null))
      .rejects.toMatchObject({ status: 409, message: "Issue checkout conflict" });
  });

  it("preserves an explicit null policy when checkout assigns an unassigned task", async () => {
    const { companyId, workerId } = await seedReviewedAgent();
    const unassigned = await svc.create(companyId, {
      title: "Explicit checkout opt-out",
      executionPolicy: null,
    });

    const checkedOut = await svc.checkout(unassigned.id, workerId, ["backlog"], null);

    expect(checkedOut.executionPolicy).toBeNull();
    expect(checkedOut.executionPolicyExplicit).toBe(true);
  });

  it("preserves an explicit null policy when the assigned agent checks out", async () => {
    const { companyId, workerId } = await seedReviewedAgent();
    const assigned = await svc.create(companyId, {
      title: "Assigned checkout opt-out",
      assigneeAgentId: workerId,
    });
    await svc.update(assigned.id, { executionPolicy: null });

    const checkedOut = await svc.checkout(assigned.id, workerId, ["backlog"], null);

    expect(checkedOut.executionPolicy).toBeNull();
    expect(checkedOut.executionPolicyExplicit).toBe(true);
  });

  it("stops task creation when the configured reviewer is unavailable", async () => {
    const { companyId, reviewerId, workerId } = await seedReviewedAgent();
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, reviewerId));

    await expect(svc.create(companyId, {
      title: "Cannot skip review",
      assigneeAgentId: workerId,
    })).rejects.toMatchObject({
      status: 409,
      message: "The assigned agent's automatic reviewer is unavailable. Choose another reviewer or remove the automatic reviewer setting.",
    });
  });

  it("rejects explicit reviewers outside the company or unavailable for work", async () => {
    const { companyId, workerId } = await seedReviewedAgent();
    const otherCompanyId = randomUUID();
    const foreignReviewerId = randomUUID();
    const pendingReviewerId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Foreign Review Company",
      issuePrefix: `F${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: foreignReviewerId,
        companyId: otherCompanyId,
        name: "Foreign Reviewer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
      },
      {
        id: pendingReviewerId,
        companyId,
        name: "Pending Reviewer",
        role: "engineer",
        status: "pending_approval",
        adapterType: "codex_local",
      },
    ]);

    await expect(svc.create(companyId, {
      title: "Foreign reviewer policy",
      status: "done",
      assigneeAgentId: workerId,
      executionPolicy: {
        stages: [{ type: "review", participants: [{ type: "agent", agentId: foreignReviewerId }] }],
      },
    })).rejects.toMatchObject({ status: 422, message: "Assignee must belong to same company" });

    await expect(svc.create(companyId, {
      title: "Pending reviewer policy",
      assigneeAgentId: workerId,
      executionPolicy: {
        stages: [{ type: "review", participants: [{ type: "agent", agentId: pendingReviewerId }] }],
      },
    })).rejects.toMatchObject({ status: 409, message: "Cannot assign work to pending approval agents" });
  });

  it("rejects self-review and reviewers from another company", async () => {
    const { companyId, workerId } = await seedReviewedAgent();
    const otherCompanyId = randomUUID();
    const otherReviewerId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Company",
      issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: otherReviewerId,
      companyId: otherCompanyId,
      name: "Other Reviewer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
    });

    await expect(agentService(db).update(workerId, { defaultReviewerAgentId: workerId }))
      .rejects.toMatchObject({ status: 422, message: "An agent cannot review its own work" });
    await expect(agentService(db).create(companyId, {
      id: workerId,
      name: "Self reviewer",
      adapterType: "codex_local",
      defaultReviewerAgentId: workerId,
    })).rejects.toMatchObject({ status: 422, message: "An agent cannot review its own work" });
    await expect(agentService(db).update(workerId, { defaultReviewerAgentId: otherReviewerId }))
      .rejects.toMatchObject({ status: 422, message: "Default reviewer must belong to the same company" });
  });
});

describeEmbeddedPostgres("issueService.create workspace inheritance", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-create-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  }, 90_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("inherits the parent issue workspace linkage when child workspace fields are omitted", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const parentIssueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
      sharedWorkspaceKey: "workspace-key",
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Issue worktree",
      status: "active",
      providerType: "git_worktree",
      providerRef: `/tmp/${executionWorkspaceId}`,
    });

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        workspaceRuntime: { profile: "agent" },
      },
    });

    const child = await svc.create(companyId, {
      parentId: parentIssueId,
      projectId,
      title: "Child issue",
    });

    expect(child.parentId).toBe(parentIssueId);
    expect(child.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(child.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(child.executionWorkspacePreference).toBe("reuse_existing");
    expect(child.executionWorkspaceSettings).toEqual({
      mode: "isolated_workspace",
      workspaceRuntime: { profile: "agent" },
    });
  });

  it("keeps explicit workspace fields instead of inheriting the parent linkage", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const parentIssueId = randomUUID();
    const parentProjectWorkspaceId = randomUUID();
    const parentExecutionWorkspaceId = randomUUID();
    const explicitProjectWorkspaceId = randomUUID();
    const explicitExecutionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values([
      {
        id: parentProjectWorkspaceId,
        companyId,
        projectId,
        name: "Parent workspace",
      },
      {
        id: explicitProjectWorkspaceId,
        companyId,
        projectId,
        name: "Explicit workspace",
      },
    ]);

    await db.insert(executionWorkspaces).values([
      {
        id: parentExecutionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId: parentProjectWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Parent worktree",
        status: "active",
        providerType: "git_worktree",
      },
      {
        id: explicitExecutionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId: explicitProjectWorkspaceId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Explicit shared workspace",
        status: "active",
        providerType: "local_fs",
      },
    ]);

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId: parentProjectWorkspaceId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId: parentExecutionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
      },
    });

    const child = await svc.create(companyId, {
      parentId: parentIssueId,
      projectId,
      title: "Child issue",
      projectWorkspaceId: explicitProjectWorkspaceId,
      executionWorkspaceId: explicitExecutionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "shared_workspace",
      },
    });

    expect(child.projectWorkspaceId).toBe(explicitProjectWorkspaceId);
    expect(child.executionWorkspaceId).toBe(explicitExecutionWorkspaceId);
    expect(child.executionWorkspacePreference).toBe("reuse_existing");
    expect(child.executionWorkspaceSettings).toEqual({
      mode: "shared_workspace",
    });
  });

  it("inherits workspace linkage from an explicit source issue without creating a parent-child relationship", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const sourceIssueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "operator_branch",
      strategyType: "git_worktree",
      name: "Operator branch",
      status: "active",
      providerType: "git_worktree",
    });

    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Source issue",
      status: "todo",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "operator_branch",
      },
    });

    const followUp = await svc.create(companyId, {
      projectId,
      title: "Follow-up issue",
      inheritExecutionWorkspaceFromIssueId: sourceIssueId,
    });

    expect(followUp.parentId).toBeNull();
    expect(followUp.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(followUp.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(followUp.executionWorkspacePreference).toBe("reuse_existing");
    expect(followUp.executionWorkspaceSettings).toEqual({
      mode: "operator_branch",
    });
  });

  it("createChild applies parent defaults, acceptance criteria, workspace inheritance, and optional parent blocker chaining", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const goalId = randomUUID();
    const parentIssueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Ship child helpers",
      level: "task",
      status: "active",
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      goalId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Issue worktree",
      status: "active",
      providerType: "git_worktree",
      providerRef: `/tmp/${executionWorkspaceId}`,
    });

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      requestDepth: 1,
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
      },
    });

    const { issue: child, parentBlockerAdded } = await svc.createChild(parentIssueId, {
      title: "Child helper",
      status: "todo",
      description: "Implement the helper.",
      acceptanceCriteria: ["Uses the parent issue as parentId", "Reuses the parent execution workspace"],
      blockParentUntilDone: true,
    });

    expect(parentBlockerAdded).toBe(true);
    expect(child.parentId).toBe(parentIssueId);
    expect(child.projectId).toBe(projectId);
    expect(child.goalId).toBe(goalId);
    expect(child.requestDepth).toBe(2);
    expect(child.description).toContain("## Acceptance Criteria");
    expect(child.description).toContain("- Uses the parent issue as parentId");
    expect(child.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(child.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(child.executionWorkspacePreference).toBe("reuse_existing");

    const parentRelations = await svc.getRelationSummaries(parentIssueId);
    expect(parentRelations.blockedBy).toEqual([
      expect.objectContaining({
        id: child.id,
        title: "Child helper",
      }),
    ]);
  });
});

describeEmbeddedPostgres("issueService blockers and dependency wake readiness", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-blockers-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  }, 90_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("persists blocked-by relations and exposes both blockedBy and blocks summaries", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const blockerId = randomUUID();
    const blockedId = randomUUID();
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Blocker",
        status: "todo",
        priority: "high",
      },
      {
        id: blockedId,
        companyId,
        title: "Blocked issue",
        status: "blocked",
        priority: "medium",
      },
    ]);

    await svc.update(blockedId, {
      blockedByIssueIds: [blockerId],
    });

    const blockerRelations = await svc.getRelationSummaries(blockerId);
    const blockedRelations = await svc.getRelationSummaries(blockedId);

    expect(blockerRelations.blocks.map((relation) => relation.id)).toEqual([blockedId]);
    expect(blockedRelations.blockedBy.map((relation) => relation.id)).toEqual([blockerId]);
  });

  it("adds terminal blockers to immediate blocked-by summaries", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const issueA = randomUUID();
    const issueB = randomUUID();
    const issueC = randomUUID();
    const issueD = randomUUID();
    await db.insert(issues).values([
      { id: issueA, companyId, identifier: "PAP-1", title: "Issue A", status: "blocked", priority: "medium" },
      { id: issueB, companyId, identifier: "PAP-2", title: "Issue B", status: "blocked", priority: "medium" },
      { id: issueC, companyId, identifier: "PAP-3", title: "Issue C", status: "blocked", priority: "medium" },
      { id: issueD, companyId, identifier: "PAP-4", title: "Issue D", status: "todo", priority: "high" },
    ]);

    await svc.update(issueC, { blockedByIssueIds: [issueD] });
    await svc.update(issueB, { blockedByIssueIds: [issueC] });
    await svc.update(issueA, { blockedByIssueIds: [issueB] });

    const relations = await svc.getRelationSummaries(issueA);

    expect(relations.blockedBy).toHaveLength(1);
    expect(relations.blockedBy[0]).toMatchObject({
      id: issueB,
      identifier: "PAP-2",
      title: "Issue B",
      terminalBlockers: [
        expect.objectContaining({
          id: issueD,
          identifier: "PAP-4",
          title: "Issue D",
          status: "todo",
          priority: "high",
        }),
      ],
    });
  });

  it("rejects blocking cycles", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const issueA = randomUUID();
    const issueB = randomUUID();
    await db.insert(issues).values([
      { id: issueA, companyId, title: "Issue A", status: "todo", priority: "medium" },
      { id: issueB, companyId, title: "Issue B", status: "todo", priority: "medium" },
    ]);

    await svc.update(issueA, { blockedByIssueIds: [issueB] });

    await expect(
      svc.update(issueB, { blockedByIssueIds: [issueA] }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("only returns dependents once every blocker is done", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
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

    const blockerA = randomUUID();
    const blockerB = randomUUID();
    const blockedIssueId = randomUUID();
    await db.insert(issues).values([
      { id: blockerA, companyId, title: "Blocker A", status: "done", priority: "medium" },
      { id: blockerB, companyId, title: "Blocker B", status: "todo", priority: "medium" },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked issue",
        status: "blocked",
        priority: "medium",
        assigneeAgentId,
      },
    ]);

    await svc.update(blockedIssueId, { blockedByIssueIds: [blockerA, blockerB] });

    expect(await svc.listWakeableBlockedDependents(blockerA)).toEqual([]);

    await svc.update(blockerB, { status: "done" });

    await expect(svc.listWakeableBlockedDependents(blockerA)).resolves.toEqual([
      expect.objectContaining({
        id: blockedIssueId,
        assigneeAgentId,
        blockerIssueIds: expect.arrayContaining([blockerA, blockerB]),
      }),
    ]);
  });

  it("reports dependency readiness for blocked issue chains", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const blockerId = randomUUID();
    const blockedId = randomUUID();
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Blocker", status: "todo", priority: "medium" },
      { id: blockedId, companyId, title: "Blocked", status: "todo", priority: "medium" },
    ]);
    await svc.update(blockedId, { blockedByIssueIds: [blockerId] });

    await expect(svc.getDependencyReadiness(blockedId)).resolves.toMatchObject({
      issueId: blockedId,
      blockerIssueIds: [blockerId],
      unresolvedBlockerIssueIds: [blockerId],
      unresolvedBlockerCount: 1,
      allBlockersDone: false,
      isDependencyReady: false,
    });

    await svc.update(blockerId, { status: "done" });

    await expect(svc.getDependencyReadiness(blockedId)).resolves.toMatchObject({
      issueId: blockedId,
      blockerIssueIds: [blockerId],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      allBlockersDone: true,
      isDependencyReady: true,
    });
  });

  it("rejects execution when unresolved blockers remain", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
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

    const blockerId = randomUUID();
    const blockedId = randomUUID();
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Blocker", status: "todo", priority: "medium" },
      {
        id: blockedId,
        companyId,
        title: "Blocked",
        status: "todo",
        priority: "medium",
        assigneeAgentId,
      },
    ]);
    await svc.update(blockedId, { blockedByIssueIds: [blockerId] });

    await expect(
      svc.update(blockedId, { status: "in_progress" }),
    ).rejects.toMatchObject({ status: 422 });

    await expect(
      svc.checkout(blockedId, assigneeAgentId, ["todo", "blocked"], null),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("wakes parents only when all direct children are terminal", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
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

    const parentId = randomUUID();
    const childA = randomUUID();
    const childB = randomUUID();
    await db.insert(issues).values([
      {
        id: parentId,
        companyId,
        title: "Parent issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId,
      },
      {
        id: childA,
        companyId,
        parentId,
        title: "Child A",
        status: "done",
        priority: "medium",
        issueNumber: 1,
      },
      {
        id: childB,
        companyId,
        parentId,
        title: "Child B",
        status: "blocked",
        priority: "medium",
        issueNumber: 2,
      },
    ]);

    expect(await svc.getWakeableParentAfterChildCompletion(parentId)).toBeNull();

    await svc.update(childB, { status: "cancelled" });

    expect(await svc.getWakeableParentAfterChildCompletion(parentId)).toMatchObject({
      id: parentId,
      assigneeAgentId,
      childIssueIds: [childA, childB],
      childIssueSummaries: [
        expect.objectContaining({ id: childA, title: "Child A", status: "done" }),
        expect.objectContaining({ id: childB, title: "Child B", status: "cancelled" }),
      ],
      childIssueSummaryTruncated: false,
    });
  });
});

describeEmbeddedPostgres("issueService.create workspace inheritance", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-create-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  }, 90_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("inherits the parent issue workspace linkage when child workspace fields are omitted", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const parentIssueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
      sharedWorkspaceKey: "workspace-key",
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Issue worktree",
      status: "active",
      providerType: "git_worktree",
      providerRef: `/tmp/${executionWorkspaceId}`,
    });

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        workspaceRuntime: { profile: "agent" },
      },
    });

    const child = await svc.create(companyId, {
      parentId: parentIssueId,
      projectId,
      title: "Child issue",
    });

    expect(child.parentId).toBe(parentIssueId);
    expect(child.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(child.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(child.executionWorkspacePreference).toBe("reuse_existing");
    expect(child.executionWorkspaceSettings).toEqual({
      mode: "isolated_workspace",
      workspaceRuntime: { profile: "agent" },
    });
  });

  it("keeps explicit workspace fields instead of inheriting the parent linkage", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const parentIssueId = randomUUID();
    const parentProjectWorkspaceId = randomUUID();
    const parentExecutionWorkspaceId = randomUUID();
    const explicitProjectWorkspaceId = randomUUID();
    const explicitExecutionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values([
      {
        id: parentProjectWorkspaceId,
        companyId,
        projectId,
        name: "Parent workspace",
      },
      {
        id: explicitProjectWorkspaceId,
        companyId,
        projectId,
        name: "Explicit workspace",
      },
    ]);

    await db.insert(executionWorkspaces).values([
      {
        id: parentExecutionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId: parentProjectWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Parent worktree",
        status: "active",
        providerType: "git_worktree",
      },
      {
        id: explicitExecutionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId: explicitProjectWorkspaceId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Explicit shared workspace",
        status: "active",
        providerType: "local_fs",
      },
    ]);

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId: parentProjectWorkspaceId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId: parentExecutionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
      },
    });

    const child = await svc.create(companyId, {
      parentId: parentIssueId,
      projectId,
      title: "Child issue",
      projectWorkspaceId: explicitProjectWorkspaceId,
      executionWorkspaceId: explicitExecutionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "shared_workspace",
      },
    });

    expect(child.projectWorkspaceId).toBe(explicitProjectWorkspaceId);
    expect(child.executionWorkspaceId).toBe(explicitExecutionWorkspaceId);
    expect(child.executionWorkspacePreference).toBe("reuse_existing");
    expect(child.executionWorkspaceSettings).toEqual({
      mode: "shared_workspace",
    });
  });

  it("inherits workspace linkage from an explicit source issue without creating a parent-child relationship", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const sourceIssueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "operator_branch",
      strategyType: "git_worktree",
      name: "Operator branch",
      status: "active",
      providerType: "git_worktree",
    });

    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Source issue",
      status: "todo",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "operator_branch",
      },
    });

    const followUp = await svc.create(companyId, {
      projectId,
      title: "Follow-up issue",
      inheritExecutionWorkspaceFromIssueId: sourceIssueId,
    });

    expect(followUp.parentId).toBeNull();
    expect(followUp.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(followUp.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(followUp.executionWorkspacePreference).toBe("reuse_existing");
    expect(followUp.executionWorkspaceSettings).toEqual({
      mode: "operator_branch",
    });
  });
});

describeEmbeddedPostgres("issueService.findMentionedProjectIds", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-mentioned-projects-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  }, 90_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("can skip comment-body scans for bounded issue detail reads", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const titleProjectId = randomUUID();
    const commentProjectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values([
      {
        id: titleProjectId,
        companyId,
        name: "Title project",
        status: "in_progress",
      },
      {
        id: commentProjectId,
        companyId,
        name: "Comment project",
        status: "in_progress",
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Link [Title](${buildProjectMentionHref(titleProjectId)})`,
      description: null,
      status: "todo",
      priority: "medium",
    });

    await db.insert(issueComments).values({
      companyId,
      issueId,
      body: `Comment link [Comment](${buildProjectMentionHref(commentProjectId)})`,
    });

    expect(await svc.findMentionedProjectIds(issueId, { includeCommentBodies: false })).toEqual([titleProjectId]);
    expect(await svc.findMentionedProjectIds(issueId)).toEqual([
      titleProjectId,
      commentProjectId,
    ]);
  });
});

describeEmbeddedPostgres("issueService.clearExecutionRunIfTerminal", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-execution-lock-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 90_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssueWithRun(status: string | null) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = status ? randomUUID() : null;

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
    if (runId) {
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status,
        invocationSource: "manual",
      });
    }
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Execution lock",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: runId,
      executionAgentNameKey: runId ? "codexcoder" : null,
      executionLockedAt: runId ? new Date() : null,
    });

    return { issueId, runId };
  }

  it("clears execution locks owned by terminal runs", async () => {
    const { issueId } = await seedIssueWithRun("failed");

    await expect(svc.clearExecutionRunIfTerminal(issueId)).resolves.toBe(true);

    const row = await db
      .select({
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });
  });

  it("does not clear execution locks owned by live runs", async () => {
    const { issueId, runId } = await seedIssueWithRun("running");

    await expect(svc.clearExecutionRunIfTerminal(issueId)).resolves.toBe(false);

    const row = await db
      .select({
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.executionRunId).toBe(runId);
    expect(row?.executionAgentNameKey).toBe("codexcoder");
    expect(row?.executionLockedAt).toBeInstanceOf(Date);
  });

  it("does not update issues without an execution lock", async () => {
    const { issueId } = await seedIssueWithRun(null);

    await expect(svc.clearExecutionRunIfTerminal(issueId)).resolves.toBe(false);

    const row = await db
      .select({ executionRunId: issues.executionRunId, executionLockedAt: issues.executionLockedAt })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ executionRunId: null, executionLockedAt: null });
  });
});

describeEmbeddedPostgres("issueService project and goal company checks", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-company-refs-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  }, 90_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const goalId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Project", status: "in_progress" });
    await db.insert(goals).values({ id: goalId, companyId, title: "Goal", level: "task", status: "active" });
    return { companyId, projectId, goalId };
  }

  it("rejects creating a task in another company's project or goal", async () => {
    const own = await seedCompany();
    const other = await seedCompany();

    await expect(svc.create(own.companyId, { title: "Probe", projectId: other.projectId }))
      .rejects.toMatchObject({ status: 422, message: "Project must belong to same company" });
    await expect(svc.create(own.companyId, { title: "Probe", goalId: other.goalId }))
      .rejects.toMatchObject({ status: 422, message: "Goal must belong to same company" });
    expect(await db.select().from(issues)).toHaveLength(0);
  });

  it("rejects moving a task into another company's project or goal", async () => {
    const own = await seedCompany();
    const other = await seedCompany();
    const issue = await svc.create(own.companyId, { title: "Task", projectId: own.projectId });

    await expect(svc.update(issue.id, { projectId: other.projectId }))
      .rejects.toMatchObject({ status: 422, message: "Project must belong to same company" });
    await expect(svc.update(issue.id, { goalId: other.goalId }))
      .rejects.toMatchObject({ status: 422, message: "Goal must belong to same company" });
    const row = await db.select().from(issues).where(eq(issues.id, issue.id)).then((rows) => rows[0]);
    expect(row?.projectId).toBe(own.projectId);
  });

  it("still accepts the task's own company's project and goal", async () => {
    const own = await seedCompany();

    const issue = await svc.create(own.companyId, { title: "Task", projectId: own.projectId, goalId: own.goalId });

    expect(issue.projectId).toBe(own.projectId);
    expect(issue.goalId).toBe(own.goalId);
  });
});
