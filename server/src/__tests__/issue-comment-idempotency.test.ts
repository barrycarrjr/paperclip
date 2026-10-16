import { randomUUID } from "node:crypto";
import os from "node:os";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, instanceSettings, issueComments, issueRelations, issues } from "@paperclipai/db";
import { deterministicActivityId } from "../services/activity-log.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping issue comment idempotency tests: ${support.reason}`);

describeDatabase("issue comment idempotency", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const issueId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-comment-idempotency-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Comment idempotency", issuePrefix: "CID" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Retrying agent" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Reply once", assigneeAgentId: agentId });
  });

  afterAll(async () => {
    await database?.cleanup();
  });

  it("returns one durable comment when concurrent requests use the same issue key", async () => {
    const service = issueService(db);
    const idempotencyKey = "ollama.mixed:v1_concurrent";
    const results = await Promise.all([
      service.addCommentIdempotent(issueId, "First generated answer", { agentId, idempotencyKey }),
      service.addCommentIdempotent(issueId, "Regenerated answer", { agentId, idempotencyKey }),
    ]);

    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(results[0].comment.id).toBe(results[1].comment.id);
    expect(results[0].comment.body).toBe(results[1].comment.body);
    const stored = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ idempotencyKey, authorAgentId: agentId });
  });

  it("does not let another actor reuse an existing issue comment key", async () => {
    const otherAgentId = randomUUID();
    await db.insert(agents).values({ id: otherAgentId, companyId, name: "Other agent" });
    await expect(issueService(db).addCommentIdempotent(issueId, "Different actor", {
      agentId: otherAgentId,
      idempotencyKey: "ollama.mixed:v1_concurrent",
    })).rejects.toMatchObject({ status: 409 });
  });

  it.each([true, false])(
    "rechecks a concurrent correction after locking when ownership changes (explicit target %s)",
    async (explicitTarget) => {
      const correctionIssueId = randomUUID();
      const nextAgentId = randomUUID();
      await db.insert(agents).values({ id: nextAgentId, companyId, name: "Concurrent assignee" });
      await db.insert(issues).values({
        id: correctionIssueId, companyId, title: "Concurrent correction", status: "in_progress", assigneeAgentId: agentId,
      });
      const input = {
        idempotencyKey: "board.correction:v1_lock-race", userId: "local-board", intent: "correction" as const,
        ...(explicitTarget ? { expectedAssigneeAgentId: agentId } : {}),
      };
      let signalLocked!: () => void;
      const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
      let releaseOriginal!: () => void;
      const release = new Promise<void>((resolve) => { releaseOriginal = resolve; });
      const original = db.transaction(async (tx) => {
        await tx.select().from(issues).where(eq(issues.id, correctionIssueId)).for("update");
        signalLocked();
        await release;
        const result = await issueService(tx as unknown as typeof db).addCommentIdempotent(correctionIssueId, "Check the source.", input);
        await tx.update(issues).set({ assigneeAgentId: nextAgentId }).where(eq(issues.id, correctionIssueId));
        return result;
      });
      await locked;
      const pending = issueService(db).addCommentIdempotent(correctionIssueId, "Check the source.", input);
      const responses = Promise.all([original, pending]);
      void responses.catch(() => {});
      let observationFailure: unknown;
      try {
        // Prove the competing request read an empty key and is waiting on the real issue row lock.
        await vi.waitFor(async () => {
          const waiting = await db.execute<{ waiting: number }>(sql`
            SELECT count(*)::int AS waiting FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%issues%'
          `);
          expect(waiting[0]?.waiting).toBeGreaterThan(0);
        }, { timeout: 5_000 });
      } catch (error) {
        observationFailure = error;
      } finally {
        releaseOriginal();
      }
      const [first, replay] = await responses;
      if (observationFailure) throw observationFailure;
      expect(first.created).toBe(true);
      expect(replay).toMatchObject({ created: false, comment: { id: first.comment.id, expectedAssigneeAgentId: agentId } });
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, correctionIssueId))).toHaveLength(1);
      expect(await db.select().from(issues).where(eq(issues.id, correctionIssueId))).toMatchObject([{ assigneeAgentId: nextAgentId }]);
    },
  );

  it("records the current assignee as the correction target when callers omit it", async () => {
    const comment = await issueService(db).addComment(issueId, "Verify the cited source.", {
      userId: "local-board",
      intent: "correction",
    });

    expect(comment.expectedAssigneeAgentId).toBe(agentId);
  });

  it("persists one immutable, company-scoped correction recipient set", async () => {
    const receiptIssueId = randomUUID();
    const mentionedAgentId = randomUUID();
    await db.insert(agents).values({ id: mentionedAgentId, companyId, name: "Original reviewer" });
    await db.insert(issues).values({
      id: receiptIssueId,
      companyId,
      title: "Receipt scope",
      assigneeAgentId: agentId,
    });
    const comment = await issueService(db).addComment(receiptIssueId, "Ask @reviewer to verify this.", {
      userId: "local-board",
      intent: "correction",
      correctionRecipientAgentIds: [mentionedAgentId, agentId, mentionedAgentId],
    });
    expect(comment.correctionRecipientAgentIds).toEqual([agentId, mentionedAgentId].sort());
    await expect(issueService(db).persistCorrectionRecipientAgentIds({
      companyId,
      issueId: receiptIssueId,
      commentId: comment.id,
      authorUserId: "local-board",
      recipientAgentIds: [agentId],
    })).resolves.toEqual([agentId, mentionedAgentId].sort());

    const otherCompanyId = randomUUID();
    const outsideAgentId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Outside recipients", issuePrefix: "OCR" });
    await db.insert(agents).values({ id: outsideAgentId, companyId: otherCompanyId, name: "Outside reviewer" });
    await expect(issueService(db).addComment(receiptIssueId, "Ask another reviewer.", {
      userId: "local-board",
      intent: "correction",
      correctionRecipientAgentIds: [agentId, outsideAgentId],
    })).rejects.toMatchObject({ status: 422 });
  });

  it("initializes a legacy correction recipient set once during an exact retry", async () => {
    const legacyIssueId = randomUUID();
    const originalMentionId = randomUUID();
    const reusedMentionId = randomUUID();
    await db.insert(agents).values([
      { id: originalMentionId, companyId, name: "Original legacy reviewer" },
      { id: reusedMentionId, companyId, name: "Replacement legacy reviewer" },
    ]);
    await db.insert(issues).values({ id: legacyIssueId, companyId, title: "Legacy correction", assigneeAgentId: agentId });
    const idempotencyKey = "board.correction:v1_legacy-recipients";
    const [legacyComment] = await db.insert(issueComments).values({
      companyId,
      issueId: legacyIssueId,
      authorUserId: "local-board",
      intent: "correction",
      idempotencyKey,
      expectedAssigneeAgentId: agentId,
      correctionRecipientAgentIds: null,
      body: "Ask @reviewer to verify this.",
    }).returning();
    const service = issueService(db);

    const initialized = await service.addCommentIdempotent(legacyIssueId, legacyComment.body, {
      userId: "local-board",
      intent: "correction",
      expectedAssigneeAgentId: agentId,
      correctionRecipientAgentIds: [agentId, originalMentionId],
      idempotencyKey,
    });
    expect(initialized).toMatchObject({
      created: false,
      comment: { id: legacyComment.id, correctionRecipientAgentIds: [agentId, originalMentionId].sort() },
    });

    const retry = await service.addCommentIdempotent(legacyIssueId, legacyComment.body, {
      userId: "local-board",
      intent: "correction",
      expectedAssigneeAgentId: agentId,
      correctionRecipientAgentIds: [agentId, reusedMentionId],
      idempotencyKey,
    });
    expect(retry.comment.correctionRecipientAgentIds).toEqual([agentId, originalMentionId].sort());
  });

  it("initializes a legacy atomic correction recipient set once during an exact retry", async () => {
    const legacyIssueId = randomUUID();
    const originalMentionId = randomUUID();
    const reusedMentionId = randomUUID();
    await db.insert(agents).values([
      { id: originalMentionId, companyId, name: "Original atomic reviewer" },
      { id: reusedMentionId, companyId, name: "Replacement atomic reviewer" },
    ]);
    await db.insert(issues).values({ id: legacyIssueId, companyId, title: "Legacy atomic correction", assigneeAgentId: agentId });
    const idempotencyKey = "board.correction:v1_legacy-atomic-recipients";
    const [legacyComment] = await db.insert(issueComments).values({
      companyId,
      issueId: legacyIssueId,
      authorUserId: "local-board",
      intent: "correction",
      idempotencyKey,
      expectedAssigneeAgentId: agentId,
      correctionRecipientAgentIds: null,
      body: "Ask @reviewer to verify this.",
    }).returning();
    const service = issueService(db);
    const submit = (recipientAgentIds: string[]) => service.addCorrectionIdempotent(
      legacyIssueId,
      legacyComment.body,
      {
        idempotencyKey,
        targetAgentId: agentId,
        correctionRecipientAgentIds: recipientAgentIds,
        reassign: false,
        reopen: false,
        userId: "local-board",
      },
    );

    const initialized = await submit([agentId, originalMentionId]);
    expect(initialized).toMatchObject({
      created: false,
      comment: { id: legacyComment.id, correctionRecipientAgentIds: [agentId, originalMentionId].sort() },
    });
    const retry = await submit([agentId, reusedMentionId]);
    expect(retry.comment.correctionRecipientAgentIds).toEqual([agentId, originalMentionId].sort());
  });

  it("does not resolve explicit agent mention IDs outside the issue company", async () => {
    const otherCompanyId = randomUUID();
    const outsideAgentId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Mention boundary", issuePrefix: "MBD" });
    await db.insert(agents).values({ id: outsideAgentId, companyId: otherCompanyId, name: "Outside mention" });

    await expect(issueService(db).findMentionedAgents(
      companyId,
      `[@Inside](agent://${agentId}) [@Outside](agent://${outsideAgentId})`,
    )).resolves.toEqual([agentId]);
  });

  it.each([
    ["atomic", true, false],
    ["atomic", false, true],
    ["comment", true, false],
    ["comment", false, true],
  ] as const)("keeps %s correction identity stable when username redaction changes from %s to %s", async (path, initial, next) => {
    const settings = instanceSettingsService(db);
    const correctionIssueId = randomUUID();
    const userName = os.userInfo().username;
    const body = `Review ${userName}'s source before filing.`;
    await db.insert(issues).values({
      id: correctionIssueId,
      companyId,
      title: "Redaction-stable correction",
      status: "in_progress",
      assigneeAgentId: agentId,
    });

    try {
      await settings.updateGeneral({ censorUsernameInLogs: initial });
      const service = issueService(db);
      const idempotencyKey = `board.correction:v1_redaction-${path}-${initial}-${next}`;
      const submit = (requestBody: string) => path === "atomic"
        ? service.addCorrectionIdempotent(correctionIssueId, requestBody, {
          idempotencyKey,
          targetAgentId: agentId,
          reassign: false,
          reopen: false,
          userId: "local-board",
        })
        : service.addCommentIdempotent(correctionIssueId, requestBody, {
          idempotencyKey,
          expectedAssigneeAgentId: agentId,
          intent: "correction",
          userId: "local-board",
        });
      const first = await submit(body);
      await settings.updateGeneral({ censorUsernameInLogs: next });
      const replay = await submit(body);

      expect(replay).toMatchObject({ created: false, comment: { id: first.comment.id } });
      await expect(submit(`${body} This is a different request.`)).rejects.toMatchObject({ status: 409 });
    } finally {
      await db.delete(instanceSettings);
    }
  });

  it("keeps correction retries stable and allows an explicit prior assignee target", async () => {
    const service = issueService(db);
    const idempotencyKey = "handoff.review:v1_correction";
    const body = "Always verify the source before recording the result.";
    const first = await service.addCommentIdempotent(issueId, body, {
      userId: "local-board",
      intent: "correction",
      expectedAssigneeAgentId: agentId,
      correctionRecipientAgentIds: [agentId],
      idempotencyKey,
    });
    expect(first.comment.correctionRecipientAgentIds).toEqual([agentId]);
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, issueId));

    const retry = await service.addCommentIdempotent(issueId, body, {
      userId: "local-board",
      intent: "correction",
      expectedAssigneeAgentId: agentId,
      idempotencyKey,
    });

    expect(first.created).toBe(true);
    expect(retry).toMatchObject({ created: false, comment: { id: first.comment.id } });
    await expect(service.addCommentIdempotent(issueId, "A different correction", {
      userId: "local-board",
      intent: "correction",
      expectedAssigneeAgentId: agentId,
      idempotencyKey,
    })).rejects.toMatchObject({ status: 409 });
    const otherTargetId = randomUUID();
    await db.insert(agents).values({ id: otherTargetId, companyId, name: "Other correction target" });
    await expect(service.addCommentIdempotent(issueId, body, {
      userId: "local-board",
      intent: "correction",
      expectedAssigneeAgentId: otherTargetId,
      idempotencyKey,
    })).rejects.toMatchObject({ status: 409 });
    await expect(service.addCommentIdempotent(issueId, "New correction", {
      userId: "local-board",
      intent: "correction",
      expectedAssigneeAgentId: agentId,
      idempotencyKey: "handoff.review:v1_stale-target",
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "correction_assignee_conflict" },
    });
    const later = await service.addCommentIdempotent(issueId, "New correction", {
      userId: "local-board",
      intent: "correction",
      expectedAssigneeAgentId: agentId,
      allowPriorAssigneeTarget: true,
      idempotencyKey: "handoff.review:v1_new-correction",
    });
    expect(later).toMatchObject({ created: true, comment: { expectedAssigneeAgentId: agentId } });
    const stored = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(stored.filter((comment) => comment.intent === "correction")).toHaveLength(3);
    expect(stored.find((comment) => comment.id === first.comment.id)?.expectedAssigneeAgentId).toBe(agentId);
  });

  it("rejects an explicit correction target from another company", async () => {
    const otherCompanyId = randomUUID();
    const outsideAgentId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Outside", issuePrefix: "OUT" });
    await db.insert(agents).values({ id: outsideAgentId, companyId: otherCompanyId, name: "Outside agent" });

    await expect(issueService(db).addCommentIdempotent(issueId, "Wrong company", {
      userId: "local-board",
      intent: "correction",
      expectedAssigneeAgentId: outsideAgentId,
      idempotencyKey: "handoff.review:v1_outside-target",
    })).rejects.toMatchObject({ status: 422 });
  });

  it("atomically creates a correction with reassignment and never reapplies state on retry", async () => {
    const service = issueService(db);
    const correctionIssueId = randomUUID();
    const targetAgentId = randomUUID();
    const newerAgentId = randomUUID();
    await db.insert(agents).values([
      { id: targetAgentId, companyId, name: "Correction target" },
      { id: newerAgentId, companyId, name: "Newer assignee" },
    ]);
    await db.insert(issues).values({
      id: correctionIssueId,
      companyId,
      title: "Correct and reassign",
      status: "done",
      assigneeAgentId: agentId,
      completedAt: new Date(),
    });
    const request = {
      idempotencyKey: "board.correction:v1_atomic-service",
      targetAgentId,
      correctionRecipientAgentIds: [newerAgentId, targetAgentId],
      reassign: true,
      reopen: true,
      userId: "local-board",
    };

    const first = await service.addCorrectionIdempotent(
      correctionIssueId,
      "Check the source before filing.",
      request,
    );
    expect(first).toMatchObject({
      created: true,
      previousStatus: "done",
      assigneeChanged: true,
      issue: { status: "todo", assigneeAgentId: targetAgentId },
      comment: {
        intent: "correction",
        expectedAssigneeAgentId: targetAgentId,
        correctionRecipientAgentIds: [newerAgentId, targetAgentId].sort(),
      },
    });
    const storedAfterFirst = await db.select().from(issueComments).where(eq(issueComments.issueId, correctionIssueId));
    expect(storedAfterFirst).toHaveLength(1);

    await db.update(issues).set({
      status: "in_progress",
      assigneeAgentId: newerAgentId,
      updatedAt: new Date(),
    }).where(eq(issues.id, correctionIssueId));
    const retry = await service.addCorrectionIdempotent(
      correctionIssueId,
      "Check the source before filing.",
      request,
    );

    expect(retry).toMatchObject({
      created: false,
      previousStatus: null,
      assigneeChanged: false,
      issue: { status: "in_progress", assigneeAgentId: newerAgentId },
      comment: { id: first.comment.id },
    });
    const storedIssue = await db.select().from(issues).where(eq(issues.id, correctionIssueId)).then((rows) => rows[0]);
    expect(storedIssue).toMatchObject({ status: "in_progress", assigneeAgentId: newerAgentId });
    const storedAfterRetry = await db.select().from(issueComments).where(eq(issueComments.issueId, correctionIssueId));
    expect(storedAfterRetry).toHaveLength(1);
  });

  it("reopens a concurrently closed issue after acquiring the correction lock", async () => {
    const correctionIssueId = randomUUID();
    await db.insert(issues).values({
      id: correctionIssueId,
      companyId,
      title: "Concurrent close correction",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    let releaseCloser!: () => void;
    const release = new Promise<void>((resolve) => { releaseCloser = resolve; });
    const closer = db.transaction(async (tx) => {
      await tx.select().from(issues).where(eq(issues.id, correctionIssueId)).for("update");
      signalLocked();
      await release;
      await tx.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, correctionIssueId));
    });
    await locked;
    const correction = issueService(db).addCorrectionIdempotent(correctionIssueId, "Check the source.", {
      idempotencyKey: "board.correction:v1_concurrent-close",
      targetAgentId: agentId,
      reassign: false,
      reopen: true,
      userId: "local-board",
    });
    const settled = Promise.all([closer, correction]);
    void settled.catch(() => {});
    let observationFailure: unknown;
    try {
      await vi.waitFor(async () => {
        const waiting = await db.execute<{ waiting: number }>(sql`
          SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%issues%'
        `);
        expect(waiting[0]?.waiting).toBeGreaterThan(0);
      }, { timeout: 5_000 });
    } catch (error) {
      observationFailure = error;
    } finally {
      releaseCloser();
    }
    const [, result] = await settled;
    if (observationFailure) throw observationFailure;

    expect(result).toMatchObject({ created: true, previousStatus: "done", issue: { status: "todo" } });
    expect(await db.select().from(issues).where(eq(issues.id, correctionIssueId))).toMatchObject([{
      status: "todo",
      completedAt: null,
    }]);
  });

  it.each(["done", "cancelled", "blocked"] as const)(
    "atomically reopens a %s issue for a same-assignee correction and preserves newer state on retry",
    async (status) => {
      const service = issueService(db);
      const correctionIssueId = randomUUID();
      await db.insert(issues).values({
        id: correctionIssueId, companyId, title: "Correct the assigned agent", status, assigneeAgentId: agentId,
        completedAt: status === "done" ? new Date() : null,
        cancelledAt: status === "cancelled" ? new Date() : null,
      });
      const input = { idempotencyKey: "board.correction:v1_same-assignee", targetAgentId: agentId, reassign: false, reopen: true, userId: "local-board" };
      const first = await service.addCorrectionIdempotent(correctionIssueId, "Check the source.", input);
      expect(first).toMatchObject({
        created: true, previousStatus: status, assigneeChanged: false,
        issue: { status: "todo", assigneeAgentId: agentId, completedAt: null, cancelledAt: null },
        comment: { intent: "correction", expectedAssigneeAgentId: agentId },
      });
      const transitionActivityId = deterministicActivityId("issue-correction-reopen", first.comment.id);
      expect(await db.select().from(activityLog).where(eq(activityLog.id, transitionActivityId))).toMatchObject([{
        action: "issue.updated", details: { status: "todo", reopened: true, reopenedFrom: status, correctionCommentId: first.comment.id },
      }]);
      await db.update(issues).set({ status: "done", assigneeAgentId: null }).where(eq(issues.id, correctionIssueId));
      const retry = await service.addCorrectionIdempotent(correctionIssueId, "Check the source.", input);
      expect(retry).toMatchObject({
        created: false, previousStatus: null, assigneeChanged: false,
        issue: { status: "done", assigneeAgentId: null }, comment: { id: first.comment.id },
      });
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, correctionIssueId))).toHaveLength(1);
      expect(await db.select().from(issues).where(eq(issues.id, correctionIssueId))).toMatchObject([{ status: "done", assigneeAgentId: null }]);
      expect(await db.select().from(activityLog).where(eq(activityLog.entityId, correctionIssueId))).toHaveLength(1);
    },
  );

  it("rolls back both state and comment on failure and permits the same correction request to retry", async () => {
    const service = issueService(db);
    const correctionIssueId = randomUUID();
    await db.insert(issues).values({
      id: correctionIssueId, companyId, title: "Rollback correction", status: "done", assigneeAgentId: agentId,
    });
    const input = { idempotencyKey: "board.correction:v1_rollback", targetAgentId: agentId, reassign: false, reopen: true, userId: "local-board" };
    // Fail the comment insertion after the issue update, inside the real transaction.
    await db.execute(sql`ALTER TABLE issue_comments ADD CONSTRAINT correction_atomic_failure CHECK (body <> 'Rollback correction')`);
    try {
      await expect(service.addCorrectionIdempotent(correctionIssueId, "Rollback correction", input)).rejects.toThrow();
    } finally {
      await db.execute(sql`ALTER TABLE issue_comments DROP CONSTRAINT correction_atomic_failure`);
    }
    expect(await db.select().from(issues).where(eq(issues.id, correctionIssueId))).toMatchObject([{ status: "done", assigneeAgentId: agentId }]);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, correctionIssueId))).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, correctionIssueId))).toHaveLength(0);

    const retry = await service.addCorrectionIdempotent(correctionIssueId, "Rollback correction", input);
    expect(retry).toMatchObject({ created: true, previousStatus: "done", issue: { status: "todo", assigneeAgentId: agentId } });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, correctionIssueId))).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, correctionIssueId))).toHaveLength(1);
  });

  it("rolls back the correction if transition activity fails and stores exactly one event on retry", async () => {
    const service = issueService(db);
    const correctionIssueId = randomUUID();
    await db.insert(issues).values({ id: correctionIssueId, companyId, title: "Audit rollback", status: "done", assigneeAgentId: agentId });
    const input = { idempotencyKey: "board.correction:v1_activity-failure", targetAgentId: agentId, reassign: false, reopen: true, userId: "activity-failure-board" };
    await db.execute(sql`ALTER TABLE activity_log ADD CONSTRAINT correction_activity_failure CHECK (actor_id <> 'activity-failure-board')`);
    try {
      await expect(service.addCorrectionIdempotent(correctionIssueId, "Check the source.", input)).rejects.toThrow();
    } finally {
      await db.execute(sql`ALTER TABLE activity_log DROP CONSTRAINT correction_activity_failure`);
    }
    expect(await db.select().from(issues).where(eq(issues.id, correctionIssueId))).toMatchObject([{ status: "done" }]);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, correctionIssueId))).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, correctionIssueId))).toHaveLength(0);

    const retry = await service.addCorrectionIdempotent(correctionIssueId, "Check the source.", input);
    expect(retry).toMatchObject({ created: true, issue: { status: "todo" } });
    const duplicate = await service.addCorrectionIdempotent(correctionIssueId, "Check the source.", input);
    expect(duplicate).toMatchObject({ created: false, comment: { id: retry.comment.id } });
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, correctionIssueId))).toMatchObject([{
      id: deterministicActivityId("issue-correction-reopen", retry.comment.id), action: "issue.updated", details: { reopenedFrom: "done" },
    }]);
  });

  it("rejects a stale correction target without restoring ownership or reopening the issue", async () => {
    const correctionIssueId = randomUUID();
    await db.insert(issues).values({ id: correctionIssueId, companyId, title: "Ownership changed", status: "done", assigneeAgentId: null });
    await expect(issueService(db).addCorrectionIdempotent(correctionIssueId, "Check the source.", {
      idempotencyKey: "board.correction:v1_stale-reopen", targetAgentId: agentId, reassign: false, reopen: true, userId: "local-board",
    })).rejects.toMatchObject({ status: 409, details: { code: "correction_assignee_conflict" } });
    expect(await db.select().from(issues).where(eq(issues.id, correctionIssueId))).toMatchObject([{ status: "done", assigneeAgentId: null }]);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, correctionIssueId))).toHaveLength(0);
  });

  it("keeps unresolved dependencies blocked and does not retry reopening after they finish", async () => {
    const service = issueService(db);
    const correctionIssueId = randomUUID();
    const blockerId = randomUUID();
    await db.insert(issues).values([
      { id: correctionIssueId, companyId, title: "Blocked correction", status: "blocked", assigneeAgentId: agentId },
      { id: blockerId, companyId, title: "Unfinished dependency", status: "todo" },
    ]);
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: correctionIssueId, type: "blocks" });
    const input = { idempotencyKey: "board.correction:v1_dependency", targetAgentId: agentId, reassign: false, reopen: true, userId: "local-board" };
    const first = await service.addCorrectionIdempotent(correctionIssueId, "Check the source.", input);
    expect(first).toMatchObject({ created: true, previousStatus: null, issue: { status: "blocked" } });

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerId));
    const retry = await service.addCorrectionIdempotent(correctionIssueId, "Check the source.", input);
    expect(retry).toMatchObject({ created: false, previousStatus: null, issue: { status: "blocked" }, comment: { id: first.comment.id } });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, correctionIssueId))).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, correctionIssueId))).toHaveLength(0);
  });

  it.each(["done", "cancelled", "blocked"] as const)(
    "never reopens a %s issue for a prior-assignee correction without reassignment",
    async (status) => {
      const currentAgentId = randomUUID();
      await db.insert(agents).values({ id: currentAgentId, companyId, name: "Current owner" });
      for (const reopen of [false, true]) {
        const correctionIssueId = randomUUID();
        await db.insert(issues).values({
          id: correctionIssueId, companyId, title: "Prior assignee correction", status, assigneeAgentId: currentAgentId,
        });
        const input = {
          idempotencyKey: "handoff.review:v1_prior-owner", targetAgentId: agentId, reassign: false,
          allowPriorAssigneeTarget: true, reopen, userId: "local-board",
        };
        const service = issueService(db);
        const first = await service.addCorrectionIdempotent(correctionIssueId, "Check your earlier source.", input);
        expect(first).toMatchObject({
          created: true, previousStatus: null, assigneeChanged: false,
          issue: { status, assigneeAgentId: currentAgentId }, comment: { expectedAssigneeAgentId: agentId },
        });
        const retry = await service.addCorrectionIdempotent(correctionIssueId, "Check your earlier source.", input);
        expect(retry).toMatchObject({ created: false, issue: { status, assigneeAgentId: currentAgentId }, comment: { id: first.comment.id } });
        expect(await db.select().from(issues).where(eq(issues.id, correctionIssueId))).toMatchObject([{ status, assigneeAgentId: currentAgentId }]);
        expect(await db.select().from(activityLog).where(eq(activityLog.entityId, correctionIssueId))).toHaveLength(0);
      }
    },
  );
});
