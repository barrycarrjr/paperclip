/**
 * Redacting text out of a comment and out of every copy Paperclip keeps of
 * it, on a real (embedded) Postgres. Made-up account numbers only.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  chatMessages,
  chatSessions,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { redactIssueCommentEverywhere } from "../services/comment-redaction.ts";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

const ACCT = "9000001234"; // made up
const HIDDEN = "[redacted …1234]";

describeDb("redactIssueCommentEverywhere", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let logDir = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-comment-redaction-");
    db = createDb(tempDb.connectionString);
    logDir = await fs.mkdtemp(path.join(os.tmpdir(), "redact-logs-"));
  }, 90_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    await fs.rm(logDir, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const commentId = randomUUID();
    const otherCommentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Clerk",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({ id: issueId, companyId, title: "File the policy" });
    const body = `Filed the renewal. Loan ${ACCT} at Example Bank; account ${ACCT} confirmed.`;
    await db.insert(issueComments).values([
      { id: commentId, companyId, issueId, authorAgentId: agentId, body },
      { id: otherCommentId, companyId, issueId, authorAgentId: agentId, body: `Earlier note mentioning ${ACCT}.` },
    ]);
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issueId,
      details: { commentId, bodySnippet: body.slice(0, 120) },
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      contextSnapshot: { paperclipWakeComment: { id: commentId, body } },
      stdoutExcerpt: `agent saw loan ${ACCT}`,
    });
    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId,
      agentId,
      seq: 1,
      eventType: "adapter.invoke",
      payload: { prompt: `Comment: ${body}` },
    });
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", payload: { summary: body } });
    await db.insert(issueExecutionDecisions).values({
      companyId,
      issueId,
      stageId: randomUUID(),
      stageType: "review",
      outcome: "approved",
      body,
    });
    const [session] = await db.insert(chatSessions).values({ companyId, boardUserId: "board-1" }).returning();
    await db.insert(chatMessages).values({ sessionId: session!.id, role: "tool", content: { text: body } });
    const logFile = path.join(logDir, companyId, agentId, `${runId}.ndjson`);
    await fs.mkdir(path.dirname(logFile), { recursive: true });
    await fs.writeFile(logFile, `${JSON.stringify({ ts: "t", stream: "stdout", chunk: `loan ${ACCT}` })}\n`);
    return { companyId, issueId, commentId, otherCommentId, runId, logFile, sessionId: session!.id };
  }

  it("hides the text in the comment and in every copy in its company, keeping the last 4", async () => {
    const a = await seedCompany();
    const b = await seedCompany(); // another company with the same number: untouched

    const r = await redactIssueCommentEverywhere(db, {
      companyId: a.companyId,
      commentId: a.commentId,
      targets: [ACCT],
      keepLast4: true,
      runLogBaseDir: logDir,
    });
    expect(r).not.toBeNull();
    expect(r!.replaced).toBe(2);
    expect(r!.comment.body).toBe(`Filed the renewal. Loan ${HIDDEN} at Example Bank; account ${HIDDEN} confirmed.`);
    expect(r!.counts).toEqual({
      comment: 1,
      activityLog: 1,
      runContexts: 1,
      runExcerpts: 1,
      runEvents: 1,
      wakeupRequests: 1,
      reviewDecisions: 1,
      chatMessages: 1,
      runLogFiles: 1,
    });
    expect(r!.otherCommentsWithText).toBe(1);

    const dump = async (companyId: string) =>
      JSON.stringify([
        await db.select().from(activityLog).where(eq(activityLog.companyId, companyId)),
        await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)),
        await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, companyId)),
        await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)),
        await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.companyId, companyId)),
      ]);
    expect(await dump(a.companyId)).not.toContain(ACCT);
    expect(JSON.stringify(await db.select().from(chatMessages).where(eq(chatMessages.sessionId, a.sessionId)))).not.toContain(ACCT);
    expect(await fs.readFile(a.logFile, "utf8")).not.toContain(ACCT);
    // The other comment is only reported, not changed.
    const [other] = await db.select().from(issueComments).where(eq(issueComments.id, a.otherCommentId));
    expect(other!.body).toContain(ACCT);

    // The other company keeps its own copies untouched.
    expect(await dump(b.companyId)).toContain(ACCT);
    expect(await fs.readFile(b.logFile, "utf8")).toContain(ACCT);
  });

  it("hides everything when asked, and reports nothing changed when the text is not in the comment", async () => {
    const a = await seedCompany();
    const full = await redactIssueCommentEverywhere(db, {
      companyId: a.companyId,
      commentId: a.commentId,
      targets: [ACCT],
      keepLast4: false,
      runLogBaseDir: null,
    });
    expect(full!.comment.body).toContain("Loan [redacted] at Example Bank");

    const none = await redactIssueCommentEverywhere(db, {
      companyId: a.companyId,
      commentId: a.commentId,
      targets: ["1111222233"],
      keepLast4: true,
      runLogBaseDir: null,
    });
    expect(none!.replaced).toBe(0);
  });

  it("does not find a comment through another company", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const r = await redactIssueCommentEverywhere(db, {
      companyId: b.companyId,
      commentId: a.commentId,
      targets: [ACCT],
      keepLast4: true,
      runLogBaseDir: null,
    });
    expect(r).toBeNull();
    const [comment] = await db.select().from(issueComments).where(eq(issueComments.id, a.commentId));
    expect(comment!.body).toContain(ACCT);
  });
});
