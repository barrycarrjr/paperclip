/**
 * Redacting text out of a comment and out of every copy Paperclip keeps of
 * it, on a real (embedded) Postgres. Made-up account numbers only.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  authUsers,
  companyMemberships,
  commentRedactionAuthorizations,
  agentWakeupRequests,
  agentRuntimeState,
  agentTaskSessions,
  agents,
  chatMessages,
  chatSessions,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { authorizeCommentRedaction, redactIssueCommentEverywhere as executeRedaction, redactCommentJson, previewCommentRedaction as previewForUser, redactLog, redactRunLogFiles, logResidualMatches } from "../services/comment-redaction.ts";
import { createLocalFileRunLogStore } from "../services/run-log-store.js";
import { agentService } from "../services/agents.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import * as currentUserText from "../log-redaction.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { withRunLogFileLock } from "../services/run-log-lock.js";
import { boundHeartbeatRunEventPayloadForStorage, compactRunLogChunk } from "../services/heartbeat.js";
import { prepareCommentRedaction, redactOperationalJson, redactOperationalText } from "../services/comment-redaction-text.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

const ACCT = "9000001234"; // made up
const previewCommentRedaction = (db: Parameters<typeof previewForUser>[0], input: Omit<Parameters<typeof previewForUser>[1], "requestedByUserId"> & { requestedByUserId?: string }) => previewForUser(db, { requestedByUserId: "board-test", ...input });

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
      status: "succeeded",
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
    const [session] = await db.insert(chatSessions).values({ companyId, boardUserId: "board-test", pageContext: body }).returning();
    await db.insert(chatMessages).values({ sessionId: session!.id, role: "tool", content: { text: body } });
    await db.insert(agentRuntimeState).values({ agentId, companyId, adapterType: "process", stateJson: { summary: body }, lastError: body });
    await db.insert(agentTaskSessions).values({ agentId, companyId, adapterType: "process", taskKey: issueId, sessionParamsJson: { cwd: "/synthetic/project" }, lastError: body });
    await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "ask_user_questions", title: body,
      payload: { version: 1, title: body, questions: [] }, result: { version: 1, answers: [], summaryMarkdown: body } });
    const logFile = path.join(logDir, companyId, agentId, `${runId}.ndjson`);
    await fs.mkdir(path.dirname(logFile), { recursive: true });
    await fs.writeFile(logFile, `${JSON.stringify({ ts: "t", stream: "stdout", chunk: `loan ${ACCT}` })}\n`);
    return { companyId, issueId, commentId, otherCommentId, runId, agentId, logFile, sessionId: session!.id };
  }

  async function redactIssueCommentEverywhere(_db: typeof db, input: {
    companyId: string; commentId: string; targets: string[]; keepLast4: boolean; runLogBaseDir: string | null;
  }) {
    const [comment] = await db.select().from(issueComments).where(eq(issueComments.id, input.commentId));
    const selection = { targets: input.targets, keepLast4: input.keepLast4, expectedBody: comment!.body };
    const impact = await previewCommentRedaction(db, { ...input, ...selection, issueId: comment!.issueId });
    return executeRedaction(db, { ...input, issueId: comment!.issueId,
      selection: { ...selection, impactToken: impact.impactToken },
      actor: { actorType: "user", actorId: "board-test" } });
  }


  it("releases exact rows, source and company locks before observing thousands of cut-off rows", async () => {
    const a = await seedCompany();
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, a.runId));
    await db.update(issueComments).set({ body: "second manual value" }).where(eq(issueComments.id, a.otherCommentId));
    for (let start = 0; start < 3000; start += 500) await db.insert(heartbeatRunEvents).values(Array.from({ length: 500 }, (_, i) => ({
      companyId: a.companyId, agentId: a.agentId, runId: a.runId, seq: 100 + start + i, eventType: "log", message: "processed 1234 rows",
    })));
    const selection = { targets: [ACCT], keepLast4: false, expectedBody: (await db.select().from(issueComments).where(eq(issueComments.id, a.commentId)))[0]!.body };
    const firstPreview = await previewCommentRedaction(db, { ...a, ...selection });
    const secondSelection = { targets: ["second manual value"], keepLast4: false, expectedBody: "second manual value" };
    const secondPreview = await previewCommentRedaction(db, { ...a, commentId: a.otherCommentId, ...secondSelection });
    let release!: () => void;
    const pause = new Promise<void>((resolve) => { release = resolve; });
    let arrived!: () => void;
    const observing = new Promise<void>((resolve) => { arrived = resolve; });
    const queries: string[] = [];
    const tracked = drizzle(db.$client, { logger: { logQuery(query) { queries.push(query); } } }) as typeof db;
    const transaction = tracked.transaction.bind(tracked);
    let transactionCount = 0;
    const intercept = vi.spyOn(tracked, "transaction").mockImplementation((callback: any, config?: any) => transaction(async (tx) => {
      if (++transactionCount === 2) {
        const execute = tx.execute.bind(tx);
        // Pause inside the actual read-only observation transaction. The source
        // transaction has returned to the pool, not merely released a savepoint.
        tx.execute = (async (statement: any) => {
          const result = await execute(statement);
          const state = await execute(sql`select current_setting('transaction_read_only') as value`);
          if (state[0]?.value === "on") { arrived(); await pause; }
          return result;
        }) as typeof tx.execute;
      }
      return callback(tx);
    }, config));
    const first = executeRedaction(tracked, { ...a, selection: { ...selection, impactToken: firstPreview.impactToken }, actor: { actorType: "user", actorId: "board-test" }, runLogBaseDir: null });
    try {
      await Promise.race([observing, new Promise((_, reject) => setTimeout(() => reject(new Error("Observer did not start")), 5000))]);
      const [pending] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, a.companyId), eq(activityLog.action, "issue.comment_redacted")));
      expect(pending!.details).toMatchObject({ fileCleanup: "pending", cutoffCheck: "pending", cutoffCheckComplete: false });
      expect((await db.select().from(issueComments).where(eq(issueComments.id, a.commentId)))[0]!.body).not.toContain(ACCT);
      const started = performance.now();
      await db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '750ms'`);
        await tx.update(heartbeatRuns).set({ stdoutExcerpt: "synthetic progress after commit" }).where(eq(heartbeatRuns.id, a.runId));
      });
      expect(performance.now() - started).toBeLessThan(1500);
      console.log(`R6 running-row update while observation paused: ${(performance.now() - started).toFixed(1)}ms`);
      const secondStarted = performance.now();
      const second = await executeRedaction(db, { ...a, commentId: a.otherCommentId, selection: { ...secondSelection, impactToken: secondPreview.impactToken }, actor: { actorType: "user", actorId: "board-test" }, runLogBaseDir: null });
      expect(second.comment.body).toBe("[redacted]");
      expect(performance.now() - secondStarted).toBeLessThan(2000);
    } finally { release(); intercept.mockRestore(); }
    const result = await first;
    expect(result).toMatchObject({ cutoffCheckComplete: true, auditFinalized: true });
    const edgeIdQueries = queries.filter((query) => query.includes("is not true") && query.includes('from "heartbeat_run_events"'));
    expect(edgeIdQueries).toHaveLength(1);
    expect(edgeIdQueries[0]!.replace(/\s+/g, " ")).toMatch(/^select .*Id.*::text.*order by.*limit/);
    expect(edgeIdQueries[0]).not.toContain('"message" as');
  }, 60_000);

  it.each([false, true])("keeps committed source and honest audit after observer failure (finalization failure %s)", async (failFinalization) => {
    const a = await seedCompany();
    const selection = { targets: [ACCT], keepLast4: false, expectedBody: (await db.select().from(issueComments).where(eq(issueComments.id, a.commentId)))[0]!.body };
    const preview = await previewCommentRedaction(db, { ...a, ...selection });
    const transaction = db.transaction.bind(db);
    let calls = 0;
    const intercepted = new Proxy(db, { get(target, key) {
      if (key !== "transaction") return Reflect.get(target, key);
      return async (...args: Parameters<typeof transaction>) => {
        if (++calls === 2 || (failFinalization && calls === 3)) throw new Error("Synthetic post-commit failure");
        return transaction(...args);
      };
    } });
    const result = await executeRedaction(intercepted, { ...a, selection: { ...selection, impactToken: preview.impactToken }, actor: { actorType: "user", actorId: "board-test" }, runLogBaseDir: null });
    expect(result).toMatchObject({ cutoffCheckComplete: false, auditFinalized: !failFinalization, cleanupStatus: "incomplete" });
    expect(result.comment.body).not.toContain(ACCT);
    const [audit] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, a.companyId), eq(activityLog.action, "issue.comment_redacted")));
    expect(audit!.details).toMatchObject({ cutoffCheckComplete: false, cutoffCheck: failFinalization ? "pending" : "incomplete", fileCleanup: failFinalization ? "pending" : "incomplete" });
    expect(JSON.stringify(audit)).not.toContain(ACCT);
  });

  it("keeps a delegated permit consumed after an actual post-commit PostgreSQL timeout", async () => {
    const a = await seedCompany();
    const selection = { targets: [ACCT], keepLast4: false, expectedBody: (await db.select().from(issueComments).where(eq(issueComments.id, a.commentId)))[0]!.body };
    const preview = await previewCommentRedaction(db, { ...a, ...selection });
    const permit = await authorizeCommentRedaction(db, { ...a, ...selection, impactToken: preview.impactToken, agentId: a.agentId, requestedByUserId: "board-test", requestedByLocalBoard: true });
    const transaction = db.transaction.bind(db);
    let calls = 0;
    let timedOut = false;
    const intercepted = new Proxy(db, { get(target, key) {
      if (key !== "transaction") return Reflect.get(target, key);
      return async (...args: Parameters<typeof transaction>) => {
        if (++calls !== 2) return transaction(...args);
        return transaction(async (tx) => {
          await tx.execute(sql`set transaction read only`);
          await tx.execute(sql`set local statement_timeout = '20ms'`);
          try { await tx.execute(sql`select pg_sleep(0.1)`); }
          catch (error) { timedOut = (error as { code?: string }).code === "57014"; throw error; }
          throw new Error("Synthetic timeout did not fire");
        });
      };
    } });
    const input = { ...a, authorizationId: permit.authorizationId, actor: { actorType: "agent" as const, actorId: a.agentId, agentId: a.agentId }, runLogBaseDir: null };
    const result = await executeRedaction(intercepted, input);
    expect(timedOut).toBe(true);
    expect(result).toMatchObject({ cutoffCheckComplete: false, auditFinalized: true });
    expect(result.comment.body).not.toContain(ACCT);
    await expect(executeRedaction(db, input)).rejects.toMatchObject({ status: 403 });
    const [audit] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, a.companyId), eq(activityLog.action, "issue.comment_redacted")));
    expect(audit!.details).toMatchObject({ cutoffCheckComplete: false, cutoffCheck: "incomplete", permitId: permit.authorizationId });
  });

  it("does not count a modified exact row again as a post-commit cut-off candidate", async () => {
    const a = await seedCompany();
    await db.update(heartbeatRuns).set({ contextSnapshot: null, stdoutExcerpt: ACCT + " tail " + ACCT.slice(0, 6) }).where(eq(heartbeatRuns.id, a.runId));
    const selection = { targets: [ACCT], keepLast4: false, expectedBody: (await db.select().from(issueComments).where(eq(issueComments.id, a.commentId)))[0]!.body };
    const preview = await previewCommentRedaction(db, { ...a, ...selection });
    expect(preview.residualMatches).toBe(1);
    const result = await executeRedaction(db, { ...a, selection: { ...selection, impactToken: preview.impactToken }, actor: { actorType: "user", actorId: "board-test" }, runLogBaseDir: null });
    expect(result).toMatchObject({ residualMatches: 1, cutoffCheckComplete: true });
  });

  it("previews and confirms a 1,000,500-character source while preserving version checks", async () => {
    const a = await seedCompany();
    const body = "x".repeat(1_000_490) + ACCT;
    await db.update(issueComments).set({ body }).where(eq(issueComments.id, a.commentId));
    const selection = { targets: [ACCT], keepLast4: false, expectedBody: body };
    const preview = await previewCommentRedaction(db, { ...a, ...selection });
    await expect(executeRedaction(db, { ...a, selection: { ...selection, expectedBody: body + "stale", impactToken: preview.impactToken }, actor: { actorType: "user", actorId: "board-test" }, runLogBaseDir: null })).rejects.toMatchObject({ status: 409 });
    const result = await executeRedaction(db, { ...a, selection: { ...selection, impactToken: preview.impactToken }, actor: { actorType: "user", actorId: "board-test" }, runLogBaseDir: null });
    expect(result.comment.body).toBe("x".repeat(1_000_490) + "[redacted]");
  });

  it.each(["process", "claude"])("cleans other log lines around a deep %s frame without rewriting metadata", async (provider) => {
    const a = await seedCompany();
    let deep = JSON.stringify({ text: ACCT });
    for (let i = 0; i < 135; i++) deep = '{"type":' + deep + '}';
    const deepLine = provider === "claude" ? '{"type":"assistant","session_id":"' + ACCT + '","message":' + deep + '}' : '{"type":"synthetic-process-output","payload":' + deep + '}';
    const ordinary = provider === "claude" ? JSON.stringify({ type: "user", session_id: ACCT, tool_use_result: { stdout: ACCT } }) : `loan ${ACCT}`;
    const log = [ordinary, deepLine, ordinary].map((chunk) => JSON.stringify({ stream: "stdout", chunk: chunk + "\n", runId: ACCT })).join("\n") + "\n";
    const expectedOrdinary = provider === "claude" ? JSON.stringify({ type: "user", session_id: ACCT, tool_use_result: { stdout: "[redacted]" } }) : "loan [redacted]";
    const cleaned = redactLog(log, [ACCT], false);
    const chunks = cleaned.trim().split("\n").map((line) => JSON.parse(line));
    expect(chunks.map((row) => row.chunk)).toEqual([expectedOrdinary + "\n", deepLine + "\n", expectedOrdinary + "\n"]);
    expect(chunks.every((row) => row.runId === ACCT)).toBe(true);
    await fs.writeFile(a.logFile, log);
    const result = await redactRunLogFiles(db, logDir, a.companyId, [ACCT], false);
    expect(result).toMatchObject({ changed: 1, complete: false });
    expect(await fs.readFile(a.logFile, "utf8")).toBe(cleaned);
  });

  it("finishes completed malformed 250/500 KiB files containing no selection", async () => {
    const a = await seedCompany();
    await db.update(heartbeatRuns).set({ logRef: path.relative(logDir, a.logFile), finishedAt: new Date() }).where(eq(heartbeatRuns.id, a.runId));
    for (const pairs of [64_000, 128_000]) {
      const log = JSON.stringify({ stream: "stdout", chunk: 'progress "' + '\\"'.repeat(pairs) }) + "\n";
      await fs.writeFile(a.logFile, log);
      const start = performance.now();
      const result = await redactRunLogFiles(db, logDir, a.companyId, [ACCT], false);
      const elapsed = performance.now() - start;
      expect(result).toMatchObject({ changed: 0, complete: true, residualMatches: 0 });
      expect(await fs.readFile(a.logFile, "utf8")).toBe(log);
      expect(elapsed).toBeLessThan(1500);
      console.log(`completed malformed ${Buffer.byteLength(log)} byte log: ${elapsed.toFixed(1)}ms`);
    }
  });

  it("observes marked partial copies read-only without changing the impact fingerprint or bodies", async () => {
    const a = await seedCompany();
    const secret = "example-pass-Zq7Rt5WmQ2xY";
    await db.update(issueComments).set({ body: secret }).where(eq(issueComments.id, a.commentId));
    const selection = { targets: [secret], keepLast4: false, expectedBody: secret };
    const before = await previewCommentRedaction(db, { ...a, ...selection });
    const payload = boundHeartbeatRunEventPayloadForStorage({ prompt: "x".repeat(16384 - 12) + secret + " tail".repeat(100) });
    const excerpt = compactRunLogChunk("a".repeat(Math.floor(65536 * 0.6) - 9) + secret + "b".repeat(70000));
    const [event] = await db.insert(heartbeatRunEvents).values({ companyId: a.companyId, agentId: a.agentId, runId: a.runId, seq: 100, eventType: "adapter.invoke", payload }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: a.companyId, agentId: a.agentId, status: "succeeded", stdoutExcerpt: excerpt }).returning();
    const preview = await previewCommentRedaction(db, { ...a, ...selection });
    expect(preview.impactToken).toBe(before.impactToken);
    expect(preview.residualMatches).toBe(before.residualMatches + 2);
    expect(preview.counts).toEqual(before.counts);
    expect(preview.cutoffCheckComplete).toBe(true);
    const result = await executeRedaction(db, { ...a, selection: { ...selection, impactToken: before.impactToken }, actor: { actorType: "user", actorId: "board-test" }, runLogBaseDir: null });
    expect(result.comment.body).toBe("[redacted]");
    expect(result.residualMatches).toBe(preview.residualMatches);
    expect((await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.id, event!.id)))[0]!.payload).toEqual(payload);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)))[0]!.stdoutExcerpt).toBe(excerpt);
  });

  it("authorizes without observing 5001 edge-only rows, while rejecting a new exact copy", async () => {
    const a = await seedCompany();
    const selection = { targets: [ACCT], keepLast4: true, expectedBody: (await db.select().from(issueComments).where(eq(issueComments.id, a.commentId)))[0]!.body };
    const preview = await previewCommentRedaction(db, { ...a, ...selection });
    for (let start = 0; start < 5001; start += 500) await db.insert(heartbeatRunEvents).values(Array.from({ length: Math.min(500, 5001 - start) }, (_, i) => ({
      companyId: a.companyId, agentId: a.agentId, runId: a.runId, seq: 100 + start + i, eventType: "log", message: "processed 1234 rows",
    })));
    const queries: string[] = [];
    const observedDb = drizzle(db.$client, { logger: { logQuery(query) { queries.push(query); } } }) as typeof db;
    const input = { ...a, ...selection, impactToken: preview.impactToken, requestedByUserId: "board-test", requestedByLocalBoard: true };
    const [exact] = await db.insert(heartbeatRunEvents).values({ companyId: a.companyId, agentId: a.agentId, runId: a.runId, seq: 9999, eventType: "log", message: ACCT }).returning();
    await expect(authorizeCommentRedaction(observedDb, input)).rejects.toMatchObject({ status: 409 });
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.id, exact!.id));
    queries.length = 0;
    const permit = await authorizeCommentRedaction(observedDb, input);
    expect(permit.authorizationId).toBeTruthy();
    expect(queries.some((query) => query.includes("is not true"))).toBe(false);
    expect(queries.some((query) => query.includes("savepoint"))).toBe(false);
    expect(queries.some((query) => query.includes('"issue_comments"') && query.endsWith("for update"))).toBe(true);
    // Preview still performs the bounded read-only observation for its visible warning.
    queries.length = 0;
    expect((await previewForUser(observedDb, { ...a, ...selection, requestedByUserId: "board-test" })).cutoffCheckComplete).toBe(false);
    expect(queries.some((query) => query.includes("is not true"))).toBe(true);
  }, 60_000);

  it.each(["PIN 4821", "CVV 123"])("keeps short labelled selection %s fully hidden through permit replay", async (body) => {
    const a = await seedCompany();
    await db.update(issueComments).set({ body }).where(eq(issueComments.id, a.commentId));
    const selection = { targets: [body], keepLast4: true, expectedBody: body };
    const preview = await previewCommentRedaction(db, { ...a, ...selection });
    const permit = await authorizeCommentRedaction(db, { ...a, ...selection, impactToken: preview.impactToken, requestedByUserId: "board-test", requestedByLocalBoard: true });
    const result = await delegated(a, permit.authorizationId);
    expect(result.comment.body).toBe("[redacted]");
    await expect(delegated(a, permit.authorizationId)).rejects.toMatchObject({ status: 403 });
  });

  it("does not refuse a private-key selection for 5001 unrelated markdown-table events", async () => {
    const a = await seedCompany();
    const key = ["-----BEGIN EXAMPLE PRIVATE KEY-----", "EXAMPLEnotARealKey".repeat(80), "-----END EXAMPLE PRIVATE KEY-----"].join("\n");
    await db.update(issueComments).set({ body: key }).where(eq(issueComments.id, a.commentId));
    for (let start = 0; start < 5001; start += 500) {
      await db.insert(heartbeatRunEvents).values(Array.from({ length: Math.min(500, 5001 - start) }, (_, i) => ({
        companyId: a.companyId, agentId: a.agentId, runId: a.runId, seq: 100 + start + i, eventType: "log", message: "| ---- |",
      })));
    }
    const selection = { targets: [key], keepLast4: false, expectedBody: key };
    const preview = await previewCommentRedaction(db, { ...a, ...selection });
    expect(preview).toMatchObject({ counts: { runEvents: 0 }, cutoffCheckComplete: false });
    const result = await executeRedaction(db, { ...a, selection: { ...selection, impactToken: preview.impactToken }, actor: { actorType: "user", actorId: "board-test" }, runLogBaseDir: null });
    expect(result).toMatchObject({ comment: { body: "[redacted]" }, cutoffCheckComplete: false, counts: { runEvents: 0 } });
    const [audit] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, a.companyId), eq(activityLog.action, "issue.comment_redacted")));
    expect(audit!.details!.cutoffCheckComplete).toBe(false);
  }, 60_000);

  it("does not refuse an accented selection for 5001 unrelated escaped-colour excerpts", async () => {
    const a = await seedCompany();
    const target = "Caf\u00e9 account 9000001234";
    await db.update(issueComments).set({ body: target }).where(eq(issueComments.id, a.commentId));
    const excerpt = JSON.stringify({ type: "user", tool_use_result: { stdout: "\u001b[32mtests passed\u001b[0m" } });
    for (let start = 0; start < 5001; start += 500) {
      await db.insert(heartbeatRuns).values(Array.from({ length: Math.min(500, 5001 - start) }, () => ({ companyId: a.companyId, agentId: a.agentId, status: "succeeded", stdoutExcerpt: excerpt })));
    }
    const selection = { targets: [target], keepLast4: false, expectedBody: target };
    const preview = await previewCommentRedaction(db, { ...a, ...selection });
    expect(preview).toMatchObject({ counts: { runExcerpts: 0 }, cutoffCheckComplete: true });
    expect(await executeRedaction(db, { ...a, selection: { ...selection, impactToken: preview.impactToken }, actor: { actorType: "user", actorId: "board-test" }, runLogBaseDir: null })).toMatchObject({ comment: { body: "[redacted]" } });
  }, 60_000);

  it("keeps edge-only history out of the impact token and row locks", async () => {
    const a = await seedCompany();
    const target = "ACCT 9000001234";
    await db.update(issueComments).set({ body: target }).where(eq(issueComments.id, a.commentId));
    const selection = { targets: [target], keepLast4: false, expectedBody: target };
    const preview = await previewCommentRedaction(db, { ...a, ...selection });
    const [event] = await db.insert(heartbeatRunEvents).values({ companyId: a.companyId, agentId: a.agentId, runId: a.runId, seq: 100, eventType: "log", message: "processed 1234 rows" }).returning();
    // Also report a genuine edge piece without adding it to the fingerprint.
    await db.insert(heartbeatRunEvents).values({ companyId: a.companyId, agentId: a.agentId, runId: a.runId, seq: 101, eventType: "log", message: "prefix ACCT 900" });
    const later = await previewCommentRedaction(db, { ...a, ...selection });
    expect(later.impactToken).toBe(preview.impactToken);
    expect(later.residualMatches).toBeGreaterThan(preview.residualMatches);
    let unlock!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    const holding = db.transaction(async (tx) => {
      await tx.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.id, event!.id)).for("update");
      locked();
      await new Promise<void>((resolve) => { unlock = resolve; });
    });
    await ready;
    try {
      const result = await executeRedaction(db, { ...a, selection: { ...selection, impactToken: preview.impactToken }, actor: { actorType: "user", actorId: "board-test" }, runLogBaseDir: null });
      expect(result.comment.body).toBe("[redacted]");
      expect(result.residualMatches).toBe(later.residualMatches);
    } finally { unlock(); await holding; }
  });

  it("still rejects confirmation when a new exact mutable copy appears", async () => {
    const a = await seedCompany();
    const selection = { targets: [ACCT], keepLast4: false, expectedBody: (await db.select().from(issueComments).where(eq(issueComments.id, a.commentId)))[0]!.body };
    const preview = await previewCommentRedaction(db, { ...a, ...selection });
    await db.insert(heartbeatRunEvents).values({ companyId: a.companyId, agentId: a.agentId, runId: a.runId, seq: 100, eventType: "log", message: ACCT });
    await expect(executeRedaction(db, { ...a, selection: { ...selection, impactToken: preview.impactToken }, actor: { actorType: "user", actorId: "board-test" }, runLogBaseDir: null })).rejects.toMatchObject({ status: 409 });
  });

  it.each([120, 4000])("rebuilds a %i-unit snippet without splitting an emoji in PostgreSQL", async (bound) => {
    const a = await seedCompany();
    const target = "SECRET-ACCOUNT-9000001234";
    const shift = target.length - HIDDEN.length;
    const body = target + " " + "x".repeat(bound - 1 + shift - target.length - 1) + "\u{1f680} tail after emoji";
    const expected = body.replace(target, HIDDEN);
    await db.update(issueComments).set({ body }).where(eq(issueComments.id, a.commentId));
    if (bound === 120) {
      await db.update(activityLog).set({ details: { commentId: a.commentId, bodySnippet: body.slice(0, bound) } }).where(eq(activityLog.companyId, a.companyId));
    } else {
      await db.update(heartbeatRuns).set({ contextSnapshot: { paperclipWake: { comments: [{ id: a.commentId, body: body.slice(0, bound) }] } } }).where(eq(heartbeatRuns.id, a.runId));
    }
    const result = await redactIssueCommentEverywhere(db, { ...a, targets: [target], keepLast4: true, runLogBaseDir: null });
    expect(result.comment.body).toBe(expected);
    const snippet = bound === 120
      ? (await db.select().from(activityLog).where(and(eq(activityLog.companyId, a.companyId), eq(activityLog.action, "issue.comment_added"))))[0]!.details!.bodySnippet
      : ((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, a.runId)))[0]!.contextSnapshot as any).paperclipWake.comments[0].body;
    expect(snippet).toBe(expected.slice(0, bound - 1));
    expect((snippet as string).length).toBeLessThanOrEqual(bound);
    expect(snippet).not.toMatch(/[\ud800-\udbff]$/);
  });

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
      chatSessions: 1,
      runtimeState: 1,
      taskSessions: 1,
      threadInteractions: 1,
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
        await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.companyId, companyId)),
        await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.companyId, companyId)),
        await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, companyId)),
        await db.select().from(chatSessions).where(eq(chatSessions.companyId, companyId)),
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

    await expect(redactIssueCommentEverywhere(db, {
      companyId: a.companyId,
      commentId: a.commentId,
      targets: ["1111222233"],
      keepLast4: true,
      runLogBaseDir: null,
    })).rejects.toMatchObject({ status: 422 });
  });

  it("does not find a comment through another company", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    await expect(redactIssueCommentEverywhere(db, {
      companyId: b.companyId,
      commentId: a.commentId,
      targets: [ACCT],
      keepLast4: true,
      runLogBaseDir: null,
    })).rejects.toMatchObject({ status: 404 });
    const [comment] = await db.select().from(issueComments).where(eq(issueComments.id, a.commentId));
    expect(comment!.body).toContain(ACCT);
  });

  async function grant(a: Awaited<ReturnType<typeof seedCompany>>) {
    const [comment] = await db.select().from(issueComments).where(eq(issueComments.id, a.commentId));
    return authorizeCommentRedaction(db, { companyId: a.companyId, issueId: a.issueId, commentId: a.commentId,
      targets: [ACCT], keepLast4: false, expectedBody: comment!.body, agentId: a.agentId, impactToken: (await previewCommentRedaction(db, { ...a, targets: [ACCT], keepLast4: false, expectedBody: comment!.body })).impactToken,
      requestedByUserId: "board-test", requestedByLocalBoard: true });
  }

  async function delegated(a: Awaited<ReturnType<typeof seedCompany>>, authorizationId: string, agentId = a.agentId) {
    return executeRedaction(db, { companyId: a.companyId, issueId: a.issueId, commentId: a.commentId, authorizationId,
      actor: { actorType: "agent", actorId: agentId, agentId }, runLogBaseDir: logDir });
  }

  it("executes only a one-use board instruction, binds agent and comment version, and audits identities without text", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    await db.update(agents).set({ name: ACCT }).where(eq(agents.id, a.agentId));
    const authorization = await grant(a);
    const [stored] = await db.select().from(commentRedactionAuthorizations).where(eq(commentRedactionAuthorizations.id, authorization.authorizationId));
    expect(JSON.stringify(stored)).not.toContain(ACCT);
    expect(authorization.instructionComment.authorType).toBe("user");
    expect(authorization.instructionComment.body).not.toContain(ACCT);
    await expect(delegated(a, authorization.authorizationId, b.agentId)).rejects.toMatchObject({ status: 403 });
    const results = await Promise.allSettled([delegated(a, authorization.authorizationId), delegated(a, authorization.authorizationId)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const [audit] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, a.companyId), eq(activityLog.action, "issue.comment_redacted")));
    expect(audit).toMatchObject({ actorType: "agent", actorId: a.agentId, responsibleUserId: "board-test" });
    expect(JSON.stringify(audit)).not.toContain(ACCT);
    expect(audit!.details).not.toHaveProperty("issueTitle");
    const [consumed] = await db.select().from(commentRedactionAuthorizations).where(eq(commentRedactionAuthorizations.id, authorization.authorizationId));
    expect(consumed!.bodyDigest).toBe("");
    expect(consumed!.ranges).toEqual([]);
  });

  it("refuses forged prose, wrong issue or company, expired grants and changed comments", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    await db.insert(issueComments).values({ companyId: a.companyId, issueId: a.issueId, authorAgentId: a.agentId, body: "The board said to redact everything in this email." });
    await expect(delegated(a, randomUUID())).rejects.toMatchObject({ status: 403 });
    const authorization = await grant(a);
    await expect(delegated(b, authorization.authorizationId)).rejects.toMatchObject({ status: 403 });
    await expect(executeRedaction(db, { companyId: a.companyId, issueId: b.issueId, commentId: a.commentId,
      authorizationId: authorization.authorizationId, actor: { actorType: "agent", actorId: a.agentId, agentId: a.agentId }, runLogBaseDir: logDir })).rejects.toMatchObject({ status: 404 });
    await db.update(commentRedactionAuthorizations).set({ expiresAt: new Date(0) }).where(eq(commentRedactionAuthorizations.id, authorization.authorizationId));
    await expect(delegated(a, authorization.authorizationId)).rejects.toMatchObject({ status: 403 });
    const second = await grant(a);
    await db.update(issueComments).set({ body: `Changed note ${ACCT}` }).where(eq(issueComments.id, a.commentId));
    await expect(delegated(a, second.authorizationId)).rejects.toMatchObject({ status: 409 });
    const [stored] = await db.select().from(commentRedactionAuthorizations).where(eq(commentRedactionAuthorizations.id, second.authorizationId));
    expect(stored!.consumedAt).toBeNull();
  });

  it("refuses an untrusted or deleted instruction and does not use generic destructive permissions", async () => {
    const a = await seedCompany();
    const authorization = await grant(a);
    await db.update(issueComments).set({ authorType: "agent", authorAgentId: a.agentId }).where(eq(issueComments.id, authorization.instructionComment.id));
    await expect(delegated(a, authorization.authorizationId)).rejects.toMatchObject({ status: 403 });
    const fresh = await grant(a);
    await db.delete(issueComments).where(eq(issueComments.id, fresh.instructionComment.id));
    await expect(delegated(a, fresh.authorizationId)).rejects.toMatchObject({ status: 403 });
    const [comment] = await db.select().from(issueComments).where(eq(issueComments.id, a.commentId));
    await expect(executeRedaction(db, { companyId: a.companyId, issueId: a.issueId, commentId: a.commentId,
      selection: { targets: [ACCT], keepLast4: false, expectedBody: comment!.body },
      actor: { actorType: "agent", actorId: a.agentId, agentId: a.agentId }, runLogBaseDir: logDir })).rejects.toMatchObject({ status: 403 });
  });

  it("handles escaped JSON, Unicode and split log chunks without damaging JSON", async () => {
    const a = await seedCompany();
    const target = 'example "private"\\value\n第二行';
    await db.update(issueComments).set({ body: `Exact ${target}` }).where(eq(issueComments.id, a.commentId));
    await db.update(heartbeatRuns).set({ contextSnapshot: { nested: [{ [target]: target, body: target }] }, resultJson: { result: target } }).where(eq(heartbeatRuns.id, a.runId));
    await fs.writeFile(a.logFile, [
      { stream: "stdout", chunk: target.slice(0, 10) },
      { stream: "stderr", chunk: "unrelated" },
      { stream: "stdout", chunk: target.slice(10) },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    await redactIssueCommentEverywhere(db, { companyId: a.companyId, commentId: a.commentId, targets: [target], keepLast4: false, runLogBaseDir: logDir });
    const rows = (await fs.readFile(a.logFile, "utf8")).trim().split("\n").map((s) => JSON.parse(s));
    expect(rows.map((r) => r.chunk)).toEqual(["[redacted]", "unrelated", ""]);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, a.runId));
    expect(run!.contextSnapshot).toEqual({ nested: [{ [target]: "[redacted]", body: "[redacted]" }] });
    expect(run!.resultJson).toEqual({ result: "[redacted]" });
  });

  it("reports partial file cleanup honestly and leaves a durable counts-only audit", async () => {
    const a = await seedCompany();
    await fs.writeFile(a.logFile, "not valid log JSON");
    const result = await redactIssueCommentEverywhere(db, { companyId: a.companyId, commentId: a.commentId, targets: [ACCT], keepLast4: false, runLogBaseDir: logDir });
    expect(result.fileCleanup).toBe("incomplete");
    expect(result.comment.body).not.toContain(ACCT);
    const [audit] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, a.companyId), eq(activityLog.action, "issue.comment_redacted")));
    expect(audit!.details).toMatchObject({ fileCleanup: "incomplete" });
    expect(JSON.stringify(audit)).not.toContain(ACCT);
  });

  it("serializes local append with redaction instead of losing concurrent output", async () => {
    const a = await seedCompany();
    const store = createLocalFileRunLogStore(logDir);
    const handle = { store: "local_file" as const, logRef: path.relative(logDir, a.logFile) };
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const proceed = new Promise<void>((resolve) => { release = resolve; });
    const locked = withRunLogFileLock(logDir, path.relative(logDir, a.logFile), async () => { entered(); await proceed; });
    await started;
    const redaction = redactIssueCommentEverywhere(db, { companyId: a.companyId, commentId: a.commentId, targets: [ACCT], keepLast4: false, runLogBaseDir: logDir });
    const append = store.append(handle, { stream: "stdout", chunk: "concurrent harmless output", ts: "test" });
    release();
    await Promise.all([locked, redaction, append]);
    const log = await fs.readFile(a.logFile, "utf8");
    expect(log).not.toContain(ACCT);
    expect(log).toContain("concurrent harmless output");
  });

  it("rejects a stale direct preview and leaves colliding JSON keys unchanged", async () => {
    const a = await seedCompany();
    await expect(executeRedaction(db, { companyId: a.companyId, issueId: a.issueId, commentId: a.commentId,
      actor: { actorType: "user", actorId: "board-test" }, runLogBaseDir: logDir,
      selection: { expectedBody: `Old ${ACCT}`, targets: [ACCT], keepLast4: false } })).rejects.toMatchObject({ status: 409 });
    await db.update(heartbeatRuns).set({ contextSnapshot: { [ACCT]: 1, "[redacted]": 2 } }).where(eq(heartbeatRuns.id, a.runId));
    await redactIssueCommentEverywhere(db, { companyId: a.companyId, commentId: a.commentId, targets: [ACCT], keepLast4: false, runLogBaseDir: logDir });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, a.runId));
    expect(run!.contextSnapshot).toEqual({ [ACCT]: 1, "[redacted]": 2 });
  });

  it("invalidates pending previews and erases fingerprints when the board redacts directly", async () => {
    const a = await seedCompany();
    const authorization = await grant(a);
    await redactIssueCommentEverywhere(db, { companyId: a.companyId, commentId: a.commentId, targets: [ACCT], keepLast4: false, runLogBaseDir: logDir });
    const [stored] = await db.select().from(commentRedactionAuthorizations).where(eq(commentRedactionAuthorizations.id, authorization.authorizationId));
    expect(stored).toMatchObject({ bodyDigest: "", ranges: [] });
    expect(stored!.consumedAt).not.toBeNull();
    await expect(delegated(a, authorization.authorizationId)).rejects.toMatchObject({ status: 403 });
  });

  it("does not overwrite a concurrent run-context update with a stale snapshot", async () => {
    const a = await seedCompany();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const proceed = new Promise<void>((resolve) => { release = resolve; });
    const writer = db.transaction(async (tx) => {
      await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, a.runId)).for("update");
      entered();
      await proceed;
      await tx.update(heartbeatRuns).set({ contextSnapshot: { body: ACCT, addedConcurrently: "keep this" } }).where(eq(heartbeatRuns.id, a.runId));
    });
    await started;
    const redaction = redactIssueCommentEverywhere(db, { companyId: a.companyId, commentId: a.commentId, targets: [ACCT], keepLast4: false, runLogBaseDir: logDir });
    release();
    await Promise.all([writer, redaction]);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, a.runId));
    expect(run!.contextSnapshot).toEqual({ body: "[redacted]", addedConcurrently: "keep this" });
  });

  it("rechecks the requesting board user's access before delegated execution", async () => {
    const a = await seedCompany();
    const userId = `test-board-${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: "Test Board", email: `${randomUUID()}@example.com`, approvalStatus: "approved", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId: a.companyId, principalType: "user", principalId: userId, membershipRole: "operator" });
    const [comment] = await db.select().from(issueComments).where(eq(issueComments.id, a.commentId));
    const authorization = await authorizeCommentRedaction(db, { companyId: a.companyId, issueId: a.issueId, commentId: a.commentId,
      targets: [ACCT], keepLast4: false, expectedBody: comment!.body, agentId: a.agentId, impactToken: (await previewCommentRedaction(db, { ...a, targets: [ACCT], keepLast4: false, expectedBody: comment!.body, requestedByUserId: userId })).impactToken,
      requestedByUserId: userId, requestedByLocalBoard: false });
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(and(eq(companyMemberships.companyId, a.companyId), eq(companyMemberships.principalId, userId)));
    await expect(delegated(a, authorization.authorizationId)).rejects.toMatchObject({ status: 403 });
    await db.update(companyMemberships).set({ membershipRole: "operator" }).where(and(eq(companyMemberships.companyId, a.companyId), eq(companyMemberships.principalId, userId)));
    expect((await delegated(a, authorization.authorizationId)).comment.body).not.toContain(ACCT);
  });

  it("does not change linked files in another company and reports them as uncleaned", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    await fs.symlink(path.dirname(b.logFile), path.join(path.dirname(a.logFile), "linked-logs"), "junction");
    const hardLink = path.join(path.dirname(a.logFile), "linked.ndjson");
    await fs.link(b.logFile, hardLink);
    const result = await redactIssueCommentEverywhere(db, { companyId: a.companyId, commentId: a.commentId, targets: [ACCT], keepLast4: false, runLogBaseDir: logDir });
    expect(result.fileCleanup).toBe("incomplete");
    expect(await fs.readFile(b.logFile, "utf8")).toContain(ACCT);
    expect(await fs.readFile(hardLink, "utf8")).toContain(ACCT);
  });

  it("previews counts, refuses changed covered records and processes multiple candidate batches", async () => {
    const a = await seedCompany();
    await db.insert(heartbeatRunEvents).values(Array.from({ length: 40 }, (_, i) => ({
      companyId: a.companyId, agentId: a.agentId, runId: a.runId, seq: i + 2, eventType: "stdout", message: `Example ${ACCT}`,
    })));
    const [comment] = await db.select().from(issueComments).where(eq(issueComments.id, a.commentId));
    const selection = { targets: [ACCT], keepLast4: false, expectedBody: comment!.body };
    const preview = await previewCommentRedaction(db, { ...a, ...selection });
    expect(preview).toMatchObject({ estimated: true, counts: { comment: 1, runEvents: 41 } });
    await db.update(heartbeatRuns).set({ stdoutExcerpt: `Changed ${ACCT}` }).where(eq(heartbeatRuns.id, a.runId));
    await expect(executeRedaction(db, { ...a, selection: { ...selection, impactToken: preview.impactToken },
      actor: { actorType: "user", actorId: "board-test" }, runLogBaseDir: logDir })).rejects.toMatchObject({ status: 409 });
    const result = await redactIssueCommentEverywhere(db, { ...a, targets: [ACCT], keepLast4: false, runLogBaseDir: logDir });
    expect(result.counts.runEvents).toBe(41);
    expect(JSON.stringify(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, a.companyId)))).not.toContain(ACCT);
  });

  it("preserves structural JSON and exact large integers in actual stored columns", async () => {
    const a = await seedCompany();
    const raw = JSON.stringify({ body: ACCT, [ACCT]: ACCT, status: ACCT, cwd: ACCT, sessionParams: { body: ACCT }, n: "large-number-placeholder" })
      .replace('"large-number-placeholder"', "9007199254740993123456");
    await db.execute(sql`update heartbeat_runs set context_snapshot = ${raw}::jsonb where id = ${a.runId}`);
    await db.execute(sql`insert into heartbeat_run_events (id, company_id, run_id, agent_id, seq, event_type, message) values (9007199254740993, ${a.companyId}, ${a.runId}, ${a.agentId}, 99, 'synthetic', ${ACCT})`);
    await redactIssueCommentEverywhere(db, { ...a, targets: [ACCT], keepLast4: false, runLogBaseDir: logDir });
    const [stored] = await db.select({ value: sql<string>`${heartbeatRuns.contextSnapshot}::text` }).from(heartbeatRuns).where(eq(heartbeatRuns.id, a.runId));
    expect(stored!.value).toContain("9007199254740993123456");
    const [event] = await db.select({ body: heartbeatRunEvents.message }).from(heartbeatRunEvents).where(sql`${heartbeatRunEvents.id} = 9007199254740993`);
    expect(event!.body).toBe("[redacted]");
    expect(JSON.parse(stored!.value)).toMatchObject({ body: "[redacted]", [ACCT]: "[redacted]", status: ACCT, cwd: ACCT, sessionParams: { body: ACCT } });
  });

  it("refuses an over-broad candidate scan before saving a redaction", async () => {
    const a = await seedCompany();
    await db.execute(sql`insert into heartbeat_run_events (company_id, run_id, agent_id, seq, event_type, message)
      select ${a.companyId}::uuid, ${a.runId}::uuid, ${a.agentId}::uuid, n + 10, 'synthetic', ${ACCT}
      from generate_series(1, 5001) n`);
    const [comment] = await db.select().from(issueComments).where(eq(issueComments.id, a.commentId));
    await expect(previewCommentRedaction(db, { ...a, targets: [ACCT], keepLast4: false, expectedBody: comment!.body })).rejects.toMatchObject({ status: 422 });
    const [current] = await db.select().from(issueComments).where(eq(issueComments.id, a.commentId));
    expect(current!.body).toBe(comment!.body);
    expect(await fs.readFile(a.logFile, "utf8")).toContain(ACCT);
  });

  it("supports a masked displayed body and refuses ambiguous masked targets without leaking responses", async () => {
    const original = currentUserText.redactCurrentUserText;
    const mock = vi.spyOn(currentUserText, "redactCurrentUserText").mockImplementation((text, opts) =>
      original(text, { ...opts, userNames: ["synthetic-user"], homeDirs: ["/home/synthetic-user"] }));
    await instanceSettingsService(db).updateGeneral({ censorUsernameInLogs: true });
    try {
      const a = await seedCompany();
      const body = `Example /home/synthetic-user, ${ACCT}`;
      await db.update(issueComments).set({ body }).where(eq(issueComments.id, a.commentId));
      const selection = { targets: [ACCT], keepLast4: false, expectedBody: redactCurrentUserText(body) };
      const preview = await previewCommentRedaction(db, { ...a, ...selection });
      const result = await executeRedaction(db, { ...a, selection: { ...selection, impactToken: preview.impactToken },
        actor: { actorType: "user", actorId: "board-test" }, runLogBaseDir: logDir });
      expect(result.comment.body).not.toContain("synthetic-user");
      const masked = redactCurrentUserText("/home/synthetic-user");
      await db.update(issueComments).set({ body: `Example /home/synthetic-user and literal ${masked}` }).where(eq(issueComments.id, a.commentId));
      const [comment] = await db.select().from(issueComments).where(eq(issueComments.id, a.commentId));
      await expect(previewCommentRedaction(db, { ...a, targets: [masked], keepLast4: false, expectedBody: redactCurrentUserText(comment!.body) })).rejects.toMatchObject({ status: 422 });
      await expect(previewCommentRedaction(db, { ...a, targets: ["/home/synthetic-user"], keepLast4: false, expectedBody: redactCurrentUserText(comment!.body) })).rejects.toMatchObject({ status: 422 });
    } finally {
      mock.mockRestore();
      await instanceSettingsService(db).updateGeneral({ censorUsernameInLogs: false });
    }
  });

  it("stores each overlapping selection and keeps the permit id in counts-only audits", async () => {
    const a = await seedCompany();
    const body = "Example card 1234";
    await db.update(issueComments).set({ body }).where(eq(issueComments.id, a.commentId));
    await db.update(heartbeatRuns).set({ stdoutExcerpt: "Other reference 1234" }).where(eq(heartbeatRuns.id, a.runId));
    const selection = { targets: ["card 1234", "1234"], keepLast4: false, expectedBody: body };
    const impact = await previewCommentRedaction(db, { ...a, ...selection });
    const permit = await authorizeCommentRedaction(db, { ...a, ...selection, impactToken: impact.impactToken,
      requestedByUserId: "board-test", requestedByLocalBoard: true });
    const [stored] = await db.select().from(commentRedactionAuthorizations).where(eq(commentRedactionAuthorizations.id, permit.authorizationId));
    expect(stored!.ranges.map((r) => body.slice(r.start, r.start + r.length))).toEqual(selection.targets);
    const result = await delegated(a, permit.authorizationId);
    expect(result.cleanupStatus).toBe("incomplete");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, a.runId));
    expect(run!.stdoutExcerpt).toBe("Other reference [redacted]");
    const audits = await db.select().from(activityLog).where(and(eq(activityLog.companyId, a.companyId), sql`${activityLog.action} like 'issue.comment_redact%'`));
    expect(audits).toHaveLength(2);
    for (const audit of audits) expect(audit.details?.permitId).toBe(permit.authorizationId);
    expect(audits.find((r) => r.action === "issue.comment_redacted")!.details?.cleanupStatus).toBe("incomplete");
  });

  it("deletes an agent with a used permit while retaining its redaction audit", async () => {
    const a = await seedCompany();
    await db.update(issueComments).set({ authorAgentId: null, authorUserId: "board-test", authorType: "user" }).where(eq(issueComments.id, a.commentId));
    const permit = await grant(a);
    await delegated(a, permit.authorizationId);
    const [before] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, a.companyId), eq(activityLog.action, "issue.comment_redacted")));
    await agentService(db).remove(a.agentId);
    expect(await db.select().from(commentRedactionAuthorizations).where(eq(commentRedactionAuthorizations.id, permit.authorizationId))).toHaveLength(0);
    const [audit] = await db.select().from(activityLog).where(eq(activityLog.id, before!.id));
    expect(audit).toMatchObject({ actorId: a.agentId, agentId: null, runId: null, details: { permitId: permit.authorizationId } });
  });

  it("preserves already-consumed timestamps when invalidating other permits", async () => {
    const a = await seedCompany();
    const permit = await grant(a);
    const usedAt = new Date("2026-01-01T00:00:00.000Z");
    await db.update(commentRedactionAuthorizations).set({ consumedAt: usedAt, ranges: [], bodyDigest: "" }).where(eq(commentRedactionAuthorizations.id, permit.authorizationId));
    await redactIssueCommentEverywhere(db, { ...a, targets: [ACCT], keepLast4: false, runLogBaseDir: logDir });
    const [stored] = await db.select().from(commentRedactionAuthorizations).where(eq(commentRedactionAuthorizations.id, permit.authorizationId));
    expect(stored!.consumedAt).toEqual(usedAt);
  });

  it("times out a contended row without blocking company log appends or saving partial changes", async () => {
    const a = await seedCompany();
    const [comment] = await db.select().from(issueComments).where(eq(issueComments.id, a.commentId));
    const selection = { targets: [ACCT], keepLast4: false, expectedBody: comment!.body };
    const impact = await previewCommentRedaction(db, { ...a, ...selection });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((r) => { entered = r; });
    const proceed = new Promise<void>((r) => { release = r; });
    const writer = db.transaction(async (tx) => {
      await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, a.runId)).for("update");
      entered(); await proceed;
    });
    await started;
    try {
      const start = Date.now();
      const redaction = executeRedaction(db, { ...a, selection: { ...selection, impactToken: impact.impactToken },
        actor: { actorType: "user", actorId: "board-test" }, runLogBaseDir: logDir });
      const rejected = expect(redaction).rejects.toThrow();
      const store = createLocalFileRunLogStore(logDir);
      const handle = await store.begin({ companyId: a.companyId, agentId: a.agentId, runId: randomUUID() });
      await store.append(handle, { stream: "stdout", chunk: "harmless concurrent output", ts: "synthetic" });
      expect(Date.now() - start).toBeLessThan(1500);
      await rejected;
      expect(Date.now() - start).toBeGreaterThan(1500);
      expect(Date.now() - start).toBeLessThan(8000);
      const [current] = await db.select().from(issueComments).where(eq(issueComments.id, a.commentId));
      expect(current!.body).toBe(comment!.body);
    } finally { release(); await writer; }
  });

  it("keeps another file writable while one file is locked for cleanup", async () => {
    const a = await seedCompany();
    const store = createLocalFileRunLogStore(logDir);
    const other = await store.begin({ companyId: a.companyId, agentId: a.agentId, runId: randomUUID() });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((r) => { entered = r; });
    const proceed = new Promise<void>((r) => { release = r; });
    const writer = withRunLogFileLock(logDir, path.relative(logDir, a.logFile), async () => { entered(); await proceed; });
    await started;
    try {
      await store.append(other, { stream: "stdout", chunk: "another file remains writable", ts: "synthetic" });
      expect((await store.finalize(other)).bytes).toBeGreaterThan(0);
    } finally { release(); await writer; }
  });

  it("reports active delegated completion copies as incomplete without installing a future filter", async () => {
    const a = await seedCompany();
    const permit = await grant(a);
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, a.runId));
    const result = await delegated(a, permit.authorizationId);
    expect(result).toMatchObject({ cleanupStatus: "incomplete", activeRunCount: 1, fileCleanup: "incomplete" });
    expect(await fs.readFile(a.logFile, "utf8")).toContain(ACCT);
    // A run may still hold its original excerpt. Completion is deliberately
    // unfiltered, and the manual action has already reported that limitation.
    await db.update(heartbeatRuns).set({ status: "succeeded", stdoutExcerpt: `retained in-memory ${ACCT}` }).where(eq(heartbeatRuns.id, a.runId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, a.runId));
    expect(run!.stdoutExcerpt).toContain(ACCT);
    const [audit] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, a.companyId), eq(activityLog.action, "issue.comment_redacted")));
    expect(audit!.details).toMatchObject({ cleanupStatus: "incomplete", activeRunCount: 1 });
  });

  it("bounds fields, reports oversized content and refreshes completed file metadata", async () => {
    const a = await seedCompany();
    await db.update(heartbeatRuns).set({ status: "succeeded", logRef: path.relative(logDir, a.logFile), stdoutExcerpt: "x".repeat(256 * 1024) + ACCT }).where(eq(heartbeatRuns.id, a.runId));
    const result = await redactIssueCommentEverywhere(db, { ...a, targets: [ACCT], keepLast4: false, runLogBaseDir: logDir });
    expect(result.cleanupStatus).toBe("incomplete");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, a.runId));
    expect(run!.stdoutExcerpt).toContain(ACCT);
    expect(run!.logBytes).toBe((await fs.stat(a.logFile)).size);
    const { createHash } = await import("node:crypto");
    expect(run!.logSha256).toBe(createHash("sha256").update(await fs.readFile(a.logFile)).digest("hex"));
    const [audit] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, a.companyId), eq(activityLog.action, "issue.comment_redacted")));
    expect(audit!.details).toMatchObject({ oversizedFields: 1, cleanupStatus: "incomplete" });
  });

  it("cleans actual comment-wake task markdown, invoke context, JSON-shaped text and provider excerpts", async () => {
    const a = await seedCompany();
    const target = JSON.stringify({ service: "example", token: 'example-not-a-credential\n"quoted"' }, null, 2);
    await db.update(issueComments).set({ body: target }).where(eq(issueComments.id, a.commentId));
    await db.update(activityLog).set({ details: { bodySnippet: target } }).where(eq(activityLog.companyId, a.companyId));
    const frames = [
      { type: "item.completed", item: { id: "synthetic-item", aggregated_output: target } },
      { type: "assistant", thinking: target, input: { command: target } },
      { type: "user", tool_use_result: { stdout: target }, content: target },
    ].map((frame) => JSON.stringify(frame)).join("\n") + "\n";
    await db.update(heartbeatRuns).set({ contextSnapshot: { paperclipTaskMarkdown: target }, stdoutExcerpt: frames, stderrExcerpt: target }).where(eq(heartbeatRuns.id, a.runId));
    await db.update(heartbeatRunEvents).set({ payload: { context: { paperclipTaskMarkdown: target } } }).where(eq(heartbeatRunEvents.runId, a.runId));
    await fs.writeFile(a.logFile, JSON.stringify({ stream: "stdout", chunk: frames }) + "\n");
    const result = await redactIssueCommentEverywhere(db, { ...a, targets: [target], keepLast4: false, runLogBaseDir: logDir });
    expect(result).toMatchObject({ cleanupStatus: "incomplete", residualMatches: 0, counts: { activityLog: 1, runContexts: 1, runEvents: 1, runExcerpts: 1, runLogFiles: 1 } });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, a.runId));
    expect(run!.contextSnapshot).toEqual({ paperclipTaskMarkdown: "[redacted]" });
    expect(run!.stderrExcerpt).toBe("[redacted]");
    expect(JSON.parse(run!.stdoutExcerpt!.split("\n")[0]!).item.aggregated_output).toBe("[redacted]");
    const [event] = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, a.runId));
    expect(event!.payload).toEqual({ context: { paperclipTaskMarkdown: "[redacted]" } });
    expect(logResidualMatches(await fs.readFile(a.logFile, "utf8"), [target], false)).toBe(0);
  });

  it("previews preserved matches and reports residual database and transport copies as incomplete", async () => {
    const a = await seedCompany();
    await db.update(heartbeatRuns).set({ contextSnapshot: { sessionId: ACCT, cwd: `/example/${ACCT}`, paperclipTaskMarkdown: ACCT } }).where(eq(heartbeatRuns.id, a.runId));
    await fs.writeFile(a.logFile, JSON.stringify({ stream: "stdout", id: ACCT, chunk: JSON.stringify({ type: "item.completed", item: { id: ACCT, aggregated_output: ACCT } }) + "\n" }) + "\n");
    const [comment] = await db.select().from(issueComments).where(eq(issueComments.id, a.commentId));
    const preview = await previewCommentRedaction(db, { ...a, targets: [ACCT], keepLast4: false, expectedBody: comment!.body });
    expect(preview.residualMatches).toBe(2);
    const result = await redactIssueCommentEverywhere(db, { ...a, targets: [ACCT], keepLast4: false, runLogBaseDir: logDir });
    expect(result).toMatchObject({ cleanupStatus: "incomplete", fileCleanup: "incomplete", residualMatches: 4 });
    const [audit] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, a.companyId), eq(activityLog.action, "issue.comment_redacted")));
    expect(audit!.details).toMatchObject({ residualMatches: 4, cleanupStatus: "incomplete" });
    expect(JSON.stringify(audit!.details)).not.toContain(ACCT);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, a.runId));
    expect(run!.contextSnapshot).toEqual({ sessionId: ACCT, cwd: `/example/${ACCT}`, paperclipTaskMarkdown: "[redacted]" });
  });

  it("keeps other users private chat counts, changes, skips and residuals out of every public observation", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const [privateSession] = await db.insert(chatSessions).values({ companyId: a.companyId, boardUserId: "other-board", title: ACCT }).returning();
    await db.insert(chatMessages).values({ sessionId: privateSession!.id, role: "tool", content: { text: ACCT } });
    const [comment] = await db.select().from(issueComments).where(eq(issueComments.id, a.commentId));
    const selection = { targets: [ACCT], keepLast4: false, expectedBody: comment!.body };
    const before = await previewCommentRedaction(db, { ...a, ...selection });
    await db.update(chatSessions).set({ pageContext: "x".repeat(256 * 1024) + ACCT }).where(eq(chatSessions.id, privateSession!.id));
    await db.insert(chatMessages).values([
      { sessionId: privateSession!.id, role: "tool", content: { text: `${ACCT} ${ACCT}`, id: ACCT } },
      { sessionId: privateSession!.id, role: "tool", content: { text: ACCT } },
    ]);
    expect(await previewCommentRedaction(db, { ...a, ...selection })).toEqual(before);
    await db.update(chatMessages).set({ content: { text: `own changed ${ACCT}` } }).where(eq(chatMessages.sessionId, a.sessionId));
    await expect(executeRedaction(db, { ...a, selection: { ...selection, impactToken: before.impactToken }, actor: { actorType: "user", actorId: "board-test" }, runLogBaseDir: logDir })).rejects.toMatchObject({ status: 409 });
    const result = await redactIssueCommentEverywhere(db, { ...a, targets: [ACCT], keepLast4: false, runLogBaseDir: logDir });
    expect(result).toMatchObject({ counts: { chatMessages: 1, chatSessions: 1 }, residualMatches: 0, cleanupStatus: "incomplete" });
    const messages = await db.select().from(chatMessages).where(eq(chatMessages.sessionId, privateSession!.id));
    expect(messages.map((message) => (message.content as any).text)).toEqual(["[redacted]", "[redacted] [redacted]", "[redacted]"]);
    const [audit] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, a.companyId), eq(activityLog.action, "issue.comment_redacted")));
    expect(audit!.details).toMatchObject({ placesChanged: { chatMessages: 1, chatSessions: 1 }, oversizedFields: 0, residualMatches: 0, cleanupStatus: "incomplete" });
    expect(JSON.stringify(await db.select().from(chatMessages).where(eq(chatMessages.sessionId, b.sessionId)))).toContain(ACCT);
  });

  it.each(["overflow", "timeout"])("keeps hidden discovery %s private and commits the delegated source and permit", async (failure) => {
    const a = await seedCompany();
    const selection = { targets: [ACCT], keepLast4: false, expectedBody: (await db.select().from(issueComments).where(eq(issueComments.id, a.commentId)))[0]!.body };
    const preview = await previewCommentRedaction(db, { ...a, ...selection });
    const [hidden] = await db.insert(chatSessions).values({ companyId: a.companyId, boardUserId: "other-board", title: ACCT }).returning();
    await db.execute(sql`insert into chat_messages (session_id, role, content) select ${hidden!.id}::uuid, 'tool', jsonb_build_object('output', ${ACCT}::text) from generate_series(1, ${failure === "overflow" ? 5001 : 1}::integer)`);
    expect(await previewCommentRedaction(db, { ...a, ...selection })).toEqual(preview);
    const permit = await authorizeCommentRedaction(db, { ...a, ...selection, impactToken: preview.impactToken,
      agentId: a.agentId, requestedByUserId: "board-test", requestedByLocalBoard: true });
    const tracked = drizzle(db.$client) as typeof db;
    const transaction = tracked.transaction.bind(tracked);
    const dialect = new PgDialect();
    let timedOut = false, calls = 0;
    const intercept = vi.spyOn(tracked, "transaction").mockImplementation((callback: any, config?: any) => transaction(async (tx) => {
      if (++calls === 1 && failure === "timeout") {
        const nested = tx.transaction.bind(tx);
        tx.transaction = ((child: any) => nested(async (privateTx) => {
          const execute = privateTx.execute.bind(privateTx);
          privateTx.execute = (async (statement: any) => {
            const query = dialect.sqlToQuery(statement).sql;
            if (!timedOut && query.includes("offset 0") && query.includes('"board_user_id" <>')) {
              await execute(sql`set local statement_timeout = '20ms'`);
              try { await execute(sql`select pg_sleep(0.1)`); }
              catch (error) { timedOut = (error as { code?: string }).code === "57014"; throw error; }
              throw new Error("Expected private statement timeout");
            }
            return execute(statement);
          }) as typeof privateTx.execute;
          return child(privateTx);
        })) as typeof tx.transaction;
      }
      return callback(tx);
    }, config));
    let result: Awaited<ReturnType<typeof executeRedaction>>;
    try { result = await executeRedaction(tracked, { ...a, authorizationId: permit.authorizationId, actor: { actorType: "agent", actorId: a.agentId, agentId: a.agentId }, runLogBaseDir: null }); }
    finally { intercept.mockRestore(); }
    expect(timedOut).toBe(failure === "timeout");
    expect(result!).toMatchObject({ counts: preview.counts, cleanupStatus: "incomplete", auditFinalized: true });
    expect(result!.comment.body).not.toContain(ACCT);
    expect(JSON.stringify(result!)).not.toContain(ACCT);
    expect((await db.select().from(commentRedactionAuthorizations).where(eq(commentRedactionAuthorizations.id, permit.authorizationId)))[0]!.consumedAt).toBeInstanceOf(Date);
    expect((await db.select().from(chatSessions).where(eq(chatSessions.id, hidden!.id)))[0]!.title).toBe(ACCT);
    const [remaining] = await db.execute(sql`select count(*)::int as count from chat_messages where session_id = ${hidden!.id}::uuid and content->>'output' = ${ACCT}`);
    expect(remaining!.count).toBe(failure === "overflow" ? 5001 : 1);
  }, 60_000);

  it("uses the board requester's chat visibility for delegated execution", async () => {
    const a = await seedCompany();
    for (const owner of [a.agentId, "other-board"]) {
      const [session] = await db.insert(chatSessions).values({ companyId: a.companyId, boardUserId: owner, title: ACCT }).returning();
      await db.insert(chatMessages).values(Array.from({ length: 3 }, () => ({ sessionId: session!.id, role: "tool", content: { text: ACCT } })));
    }
    const permit = await grant(a);
    const result = await delegated(a, permit.authorizationId);
    expect(result.counts).toMatchObject({ chatMessages: 1, chatSessions: 1 });
    const all = await db.select().from(chatMessages).where(sql`${chatMessages.sessionId} in (select id from chat_sessions where company_id = ${a.companyId})`);
    expect(JSON.stringify(all)).not.toContain(ACCT);
  });

  it("bounds incremental file cleanup by file count, entries and a controllable deadline", async () => {
    const a = await seedCompany();
    for (let i = 0; i < 3; i++) await fs.writeFile(path.join(path.dirname(a.logFile), `extra-${i}.ndjson`), JSON.stringify({ stream: "stdout", chunk: ACCT }) + "\n");
    const limited = await redactRunLogFiles(db, logDir, a.companyId, [ACCT], false, { maxFiles: 1 });
    expect(limited).toMatchObject({ changed: 1, complete: false });
    expect(await redactRunLogFiles(db, logDir, a.companyId, [ACCT], false, { maxEntries: 1 })).toMatchObject({ complete: false, changed: 0 });
    let tick = 0;
    expect(await redactRunLogFiles(db, logDir, a.companyId, [ACCT], false, { budgetMs: 3, now: () => tick++ })).toMatchObject({ complete: false, changed: 0 });
  });

  it("lets unrelated append progress while its bounded file pass waits, without breaking waiter order", async () => {
    const a = await seedCompany();
    const store = createLocalFileRunLogStore(logDir);
    const other = await store.begin({ companyId: a.companyId, agentId: a.agentId, runId: randomUUID() });
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const held = withRunLogFileLock(logDir, path.relative(logDir, a.logFile), async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); });
    await ready;
    try {
      const pass = redactRunLogFiles(db, logDir, a.companyId, [ACCT], false, { budgetMs: 50 });
      await store.append(other, { stream: "stdout", chunk: "unrelated request progressed", ts: "synthetic" });
      expect((await pass).complete).toBe(false);
      let sameFileCompleted = false;
      const queued = store.append({ store: "local_file", logRef: path.relative(logDir, a.logFile) }, { stream: "stdout", chunk: "ordered append", ts: "synthetic" }).then(() => { sameFileCompleted = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(sameFileCompleted).toBe(false);
      release();
      await Promise.all([held, queued]);
      expect(await fs.readFile(a.logFile, "utf8")).toContain("ordered append");
      expect((await store.finalize(other)).bytes).toBeGreaterThan(0);
    } finally { release(); await held; }
  });


  it("prioritizes completed recent refs over historical directory order within the file cap", async () => {
    const a = await seedCompany();
    const relevantAgent = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await db.insert(agents).values({ id: relevantAgent, companyId: a.companyId, name: "Synthetic reader", adapterType: "process" });
    const relevant = path.join(logDir, a.companyId, relevantAgent, `${a.runId}.ndjson`);
    await fs.mkdir(path.dirname(relevant), { recursive: true });
    await fs.writeFile(relevant, JSON.stringify({ stream: "stdout", chunk: ACCT }) + "\n");
    await db.update(heartbeatRuns).set({ agentId: relevantAgent, logRef: path.relative(logDir, relevant), finishedAt: new Date() }).where(eq(heartbeatRuns.id, a.runId));
    const historicalAgent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await db.insert(agents).values({ id: historicalAgent, companyId: a.companyId, name: "Synthetic history", adapterType: "process" });
    for (let n = 0; n < 5; n++) {
      const id = randomUUID();
      const file = path.join(logDir, a.companyId, historicalAgent, `${id}.ndjson`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify({ stream: "stdout", chunk: "unrelated historical output" }) + "\n");
      await db.insert(heartbeatRuns).values({ id, companyId: a.companyId, agentId: historicalAgent, status: "succeeded", logRef: path.relative(logDir, file), finishedAt: n === 0 ? null : new Date("2020-01-01"), createdAt: new Date("2020-01-01") });
    }
    const result = await redactRunLogFiles(db, logDir, a.companyId, [ACCT], false, { maxFiles: 1, commentCreatedAt: new Date("2026-01-01") });
    expect(result).toMatchObject({ changed: 1, complete: false });
    expect(JSON.parse(await fs.readFile(relevant, "utf8")).chunk).toBe("[redacted]");
    expect(result.summaries.map((item) => item.runId)).toEqual([a.runId]);
  });

  it("rejects escaped refs and skips active candidate files without reopening prioritized paths", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    await db.update(heartbeatRuns).set({ logRef: path.relative(logDir, a.logFile), status: "running" }).where(eq(heartbeatRuns.id, a.runId));
    const escapedId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: escapedId, companyId: a.companyId, agentId: a.agentId, status: "succeeded", logRef: path.relative(logDir, b.logFile) });
    expect(await redactRunLogFiles(db, logDir, a.companyId, [ACCT], false)).toMatchObject({ complete: false, changed: 0 });
    expect(await fs.readFile(a.logFile, "utf8")).toContain(ACCT);
    expect(await fs.readFile(b.logFile, "utf8")).toContain(ACCT);
    for (const logRef of [b.logFile, path.join("..", path.basename(logDir), path.relative(logDir, b.logFile))]) {
      await db.update(heartbeatRuns).set({ logRef }).where(eq(heartbeatRuns.id, escapedId));
      expect(await redactRunLogFiles(db, logDir, a.companyId, [ACCT], false, { maxEntries: 0 })).toMatchObject({ complete: false, changed: 0 });
      expect(await fs.readFile(b.logFile, "utf8")).toContain(ACCT);
    }
    await db.update(heartbeatRuns).set({ status: "succeeded", logRef: path.relative(logDir, a.logFile) }).where(eq(heartbeatRuns.id, a.runId));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, escapedId));
    // Exactly one budget slot proves the fallback does not count the ref twice.
    expect(await redactRunLogFiles(db, logDir, a.companyId, [ACCT], false, { maxFiles: 1 })).toMatchObject({ changed: 1, complete: true });
  });

  it("previews and rebuilds clipped activity and nested wake copies by exact comment identity", async () => {
    const a = await seedCompany();
    const secret = "example-pass-Zq7Rt5WmQ2";
    const lead = "x".repeat(113) + secret;
    const body = lead + "x".repeat(3993 - lead.length) + secret + " tail";
    const redacted = body.replaceAll(secret, "[redacted]");
    await db.update(issueComments).set({ body }).where(eq(issueComments.id, a.commentId));
    await db.update(activityLog).set({ details: { commentId: a.commentId, bodySnippet: body.slice(0, 120) } }).where(eq(activityLog.companyId, a.companyId));
    const wake = { paperclipWake: { comments: [{ id: a.commentId, body: body.slice(0, 4000), bodyTruncated: true }, { id: a.otherCommentId, body: body.slice(0, 120) }] }, paperclipWakeComment: { id: a.commentId, body: body.slice(0, 118) } };
    await db.update(heartbeatRuns).set({ contextSnapshot: wake }).where(eq(heartbeatRuns.id, a.runId));
    await db.update(heartbeatRunEvents).set({ payload: { context: wake } }).where(eq(heartbeatRunEvents.runId, a.runId));
    await db.update(agentWakeupRequests).set({ payload: { context: wake } }).where(eq(agentWakeupRequests.companyId, a.companyId));
    const selection = { targets: [secret], keepLast4: false, expectedBody: body };
    const preview = await previewCommentRedaction(db, { ...a, ...selection });
    expect(preview.counts).toMatchObject({ activityLog: 1, runContexts: 1, runEvents: 1, wakeupRequests: 1 });
    await db.update(activityLog).set({ details: { commentId: a.commentId, bodySnippet: body.slice(0, 119) } }).where(eq(activityLog.companyId, a.companyId));
    await expect(executeRedaction(db, { ...a, selection: { ...selection, impactToken: preview.impactToken }, actor: { actorType: "user", actorId: "board-test" }, runLogBaseDir: null })).rejects.toMatchObject({ status: 409 });
    const result = await redactIssueCommentEverywhere(db, { ...a, targets: [secret], keepLast4: false, runLogBaseDir: null });
    expect(result.counts).toMatchObject({ activityLog: 1, runContexts: 1, runEvents: 1, wakeupRequests: 1 });
    const [activity] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, a.companyId), eq(activityLog.action, "issue.comment_added")));
    expect(activity!.details!.bodySnippet).toBe(redacted.slice(0, 119));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, a.runId));
    const next = run!.contextSnapshot as any;
    expect(next.paperclipWake.comments[0].body).toBe(redacted.slice(0, 4000));
    expect(next.paperclipWake.comments[1]).toEqual(wake.paperclipWake.comments[1]);
    expect(next.paperclipWakeComment.body).toBe(redacted.slice(0, 118));
    const [event] = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, a.runId));
    const [request] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, a.companyId));
    expect((event!.payload as any).context).toEqual(next);
    expect((request!.payload as any).context).toEqual(next);
    const [other] = await db.select().from(issueComments).where(eq(issueComments.id, a.otherCommentId));
    expect(other!.body).toContain(ACCT);
  });

  it("includes unidentified clipped candidates in SQL and reports them without destructive guesses", async () => {
    const a = await seedCompany();
    const secret = "example-pass-Zq7Rt5WmQ2";
    await db.update(issueComments).set({ body: secret }).where(eq(issueComments.id, a.commentId));
    const excerpt = secret.slice(8) + " excerpt tail";
    const payload = { summary: "Wake prefix " + secret.slice(0, 10) };
    await db.update(heartbeatRuns).set({ stdoutExcerpt: excerpt }).where(eq(heartbeatRuns.id, a.runId));
    await db.update(agentWakeupRequests).set({ payload }).where(eq(agentWakeupRequests.companyId, a.companyId));
    const preview = await previewCommentRedaction(db, { ...a, targets: [secret], keepLast4: false, expectedBody: secret });
    expect(preview).toMatchObject({ residualMatches: 2, counts: { runExcerpts: 0, wakeupRequests: 0 } });
    const result = await redactIssueCommentEverywhere(db, { ...a, targets: [secret], keepLast4: false, runLogBaseDir: null });
    expect(result.residualMatches).toBe(2);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, a.runId));
    const [request] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, a.companyId));
    expect(run!.stdoutExcerpt).toBe(excerpt);
    expect(request!.payload).toEqual(payload);
    const [audit] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, a.companyId), eq(activityLog.action, "issue.comment_redacted")));
    expect(audit!.details!.residualMatches).toBe(2);
    expect(JSON.stringify(audit!.details)).not.toContain(secret.slice(0, 10));
  });

  it("finds Unicode-escaped provider content through SQL even when no raw target fragment exists", async () => {
    const a = await seedCompany();
    const secret = "\u00e9\u03bb\ud83d\ude80\u00f4"; // Synthetic Unicode selection. secret-scan: allow
    const escaped = String.raw`\u00E9\u03BB\uD83D\uDE80\u00F4`;
    await db.update(issueComments).set({ body: secret }).where(eq(issueComments.id, a.commentId));
    await db.update(heartbeatRuns).set({ stdoutExcerpt: escaped, contextSnapshot: { sessionId: escaped, text: escaped } }).where(eq(heartbeatRuns.id, a.runId));
    const preview = await previewCommentRedaction(db, { ...a, targets: [secret], keepLast4: false, expectedBody: secret });
    expect(preview).toMatchObject({ residualMatches: 1, counts: { runContexts: 1, runExcerpts: 1 } });
    const result = await redactIssueCommentEverywhere(db, { ...a, targets: [secret], keepLast4: false, runLogBaseDir: null });
    expect(result.residualMatches).toBe(1);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, a.runId));
    expect(run!.stdoutExcerpt).toBe("[redacted]");
    expect(run!.contextSnapshot).toEqual({ sessionId: escaped, text: "[redacted]" });
  });

  it("does not fingerprint, lock or refuse 5001 unrelated escaped rows in the selection's own script", async () => {
    const a = await seedCompany();
    const target = "Synthetic \u0421\u0447\u0451\u0442 9000001111 \u0432\u043b\u0430\u0434\u0435\u043b\u0435\u0446 \u043f\u0440\u0438\u043c\u0435\u0440";
    const unrelated = "\u041e\u0442\u0447\u0451\u0442 \u0433\u043e\u0442\u043e\u0432, \u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0430 \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043d\u0430".replace(/[^\x00-\x7f]/g, (unit) => "\\u" + unit.charCodeAt(0).toString(16).padStart(4, "0"));
    await db.update(issueComments).set({ body: target }).where(eq(issueComments.id, a.commentId));
    const selection = { targets: [target], keepLast4: false, expectedBody: target };
    const before = await previewCommentRedaction(db, { ...a, ...selection });
    await db.execute(sql`insert into heartbeat_runs (company_id, agent_id, status, stdout_excerpt)
      select ${a.companyId}::uuid, ${a.agentId}::uuid, 'succeeded', ${unrelated} from generate_series(1, 5001)`);
    expect(await previewCommentRedaction(db, { ...a, ...selection })).toEqual(before);
    const result = await executeRedaction(db, { ...a, selection: { ...selection, impactToken: before.impactToken }, actor: { actorType: "user", actorId: "board-test" }, runLogBaseDir: null });
    expect(result).toMatchObject({ comment: { body: "[redacted]" }, counts: { runExcerpts: 0 } });
    const [remaining] = await db.execute(sql`select count(*)::int as count from heartbeat_runs where company_id = ${a.companyId}::uuid and stdout_excerpt = ${unrelated}`);
    expect(remaining!.count).toBe(5001);
  }, 60_000);

  it("uses one Unicode candidate discovery over thousands of runs, then only bounded id loads while rows are locked", async () => {
    const a = await seedCompany();
    const target = "Synthetic.[" + Array.from({ length: 32 }, (_, i) => String.fromCharCode(0x4e00 + i)).join("") + "]\n\u00e9\ud83d\ude80";
    const runningId = "00000000-0000-4000-8000-" + randomUUID().replace(/-/g, "").slice(0, 12);
    await db.update(issueComments).set({ body: target }).where(eq(issueComments.id, a.commentId));
    await db.update(issueComments).set({ body: "second manual value" }).where(eq(issueComments.id, a.otherCommentId));
    await db.insert(heartbeatRuns).values({ id: runningId, companyId: a.companyId, agentId: a.agentId, status: "running", stdoutExcerpt: target, contextSnapshot: { paperclipWakeComment: { id: a.commentId, body: target } } });
    await db.execute(sql`insert into heartbeat_runs (company_id, agent_id, status, stdout_excerpt, result_json)
      select ${a.companyId}::uuid, ${a.agentId}::uuid, 'succeeded',
        (select string_agg('{"type":"tool_result","content":"\\u001b[32mPASS\\u001b[0m C:\\\\ui\\\\src ' || md5(g::text || ':' || s::text) || '"}', ' ') from generate_series(1, 260) s),
        jsonb_build_object('output', chr(27) || '[32m' || md5(g::text) || chr(27) || '[0m')
      from generate_series(1, 3000) g`);
    const copies = Array.from({ length: 33 }, (_, i) => {
      let value = target.replace(/[^\x00-\x7f]/g, (unit, index) => unit.charCodeAt(0) >= 0xd800 || index % 3
        ? "\\u" + unit.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase() : unit);
      for (let level = 0; level < i % 3; level++) value = JSON.stringify(value).slice(1, -1);
      return { companyId: a.companyId, agentId: a.agentId, status: "succeeded", stdoutExcerpt: value };
    });
    await db.insert(heartbeatRuns).values(copies);
    const selection = { targets: [target], keepLast4: false, expectedBody: target };
    const started = performance.now();
    const preview = await previewCommentRedaction(db, { ...a, ...selection });
    const previewMs = performance.now() - started;
    expect(preview.counts).toMatchObject({ runExcerpts: 34, runContexts: 1 });
    const secondSelection = { targets: ["second manual value"], keepLast4: false, expectedBody: "second manual value" };
    const secondPreview = await previewCommentRedaction(db, { ...a, commentId: a.otherCommentId, ...secondSelection });
    let release!: () => void;
    const pause = new Promise<void>((resolve) => { release = resolve; });
    let arrived!: () => void;
    const locked = new Promise<void>((resolve) => { arrived = resolve; });
    const queries: string[] = [];
    let updatedRun = false, paused = false;
    let discoveryQuery: { query: string; params: unknown[] } | undefined;
    const tracked = drizzle(db.$client, { logger: { logQuery(query, params) {
      queries.push(query);
      if (!discoveryQuery && query.includes('from "heartbeat_runs"') && query.includes("offset 0")) discoveryQuery = { query, params };
      if (query.startsWith('update "heartbeat_runs"')) updatedRun = true;
    } } }) as typeof db;
    const transaction = tracked.transaction.bind(tracked);
    const intercept = vi.spyOn(tracked, "transaction").mockImplementation((callback: any, config?: any) => transaction(async (tx) => {
      const execute = tx.execute.bind(tx);
      tx.execute = (async (statement: any) => {
        if (updatedRun && !paused) { paused = true; arrived(); await pause; }
        return execute(statement);
      }) as typeof tx.execute;
      return callback(tx);
    }, config));
    const confirmStarted = performance.now();
    const confirm = executeRedaction(tracked, { ...a, selection: { ...selection, impactToken: preview.impactToken }, actor: { actorType: "user", actorId: "board-test" }, runLogBaseDir: null });
    try {
      await Promise.race([locked, confirm.then(() => { throw new Error("Expected a locked-row pause"); }), new Promise((_, reject) => setTimeout(() => reject(new Error("Missing locked-row pause")), 10_000))]);
      await expect(db.transaction((tx) => tx.execute(sql`select id from heartbeat_runs where id = ${runningId}::uuid for update nowait`))).rejects.toMatchObject({ code: "55P03" });
      const progressStarted = performance.now();
      const progress = db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.update(heartbeatRuns).set({ lastOutputAt: new Date() }).where(eq(heartbeatRuns.id, runningId));
      });
      const secondStarted = performance.now();
      const second = executeRedaction(db, { ...a, commentId: a.otherCommentId, selection: { ...secondSelection, impactToken: secondPreview.impactToken }, actor: { actorType: "user", actorId: "board-test" }, runLogBaseDir: null });
      release();
      await progress;
      const progressMs = performance.now() - progressStarted;
      expect((await second).comment.body).toBe("[redacted]");
      console.log(`R7 3000 x 28KiB: preview ${previewMs.toFixed(1)}ms; progress ${progressMs.toFixed(1)}ms; second redaction ${(performance.now() - secondStarted).toFixed(1)}ms`);
      expect((await confirm).counts).toMatchObject({ runExcerpts: 34, runContexts: 1 });
    } finally { release(); await confirm; intercept.mockRestore(); }
    console.log(`R7 first confirmation ${(performance.now() - confirmStarted).toFixed(1)}ms`);
    const history = queries.filter((query) => query.includes('from "heartbeat_runs"') && query.includes("strpos("));
    expect(history.filter((query) => !query.includes("is not true"))).toHaveLength(1);
    expect(history.filter((query) => query.includes("is not true"))).toHaveLength(1);
    expect(history.every((query) => !query.includes("case when octet_length"))).toBe(true);
    expect(history.every((query) => !query.includes("lower("))).toBe(true);
    expect(history[0]!.match(/ ~ /g)).toHaveLength(16); // Own-unit precheck and one combined spelling per field.
    expect(history[0]).toContain("offset 0");
    expect(history[0]!.match(/"stdout_excerpt"::text/g)).toHaveLength(1);
    expect(history[0]!.match(/"result_json"::text/g)).toHaveLength(1);
    const planRows = await db.$client.unsafe(`explain (format json, verbose) ${discoveryQuery!.query}`, discoveryQuery!.params as any[]);
    const nodes: any[] = [];
    const visit = (node: any) => { nodes.push(node); for (const child of node.Plans ?? []) visit(child); };
    visit(planRows[0]!["QUERY PLAN"][0].Plan);
    // A real PostgreSQL plan retains the projection boundary. Each text value
    // is detached/decompressed once below the predicate's Subquery Scan.
    expect(nodes.some((node) => node["Node Type"] === "Subquery Scan")).toBe(true);
    expect(nodes.some((node) => node.Output?.some((output: string) => output.includes("stdout_excerpt || ''::text")))).toBe(true);
    const loads = queries.filter((query) => query.includes('from "heartbeat_runs"') && query.includes("case when octet_length"));
    expect(loads).toHaveLength(6);
    expect(loads.every((query) => query.includes('"id" in (') && !query.includes("strpos("))).toBe(true);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runningId));
    expect(run!.stdoutExcerpt).toBe("[redacted]");
    expect(run!.lastOutputAt).toBeInstanceOf(Date);
  }, 60_000);

  it.each(["user", "agent"] as const)("discovers main and hidden ids before the first operational lock for %s execution", async (actorType) => {
    const a = await seedCompany();
    const target = "Synthetic.[\u4e00\u4e01\u4e02\u4e03\u4e04\u4e05\n\u65e5\u672c\u8a9e\u00e9\ud83d\ude80]";
    await db.update(issueComments).set({ body: target }).where(eq(issueComments.id, a.commentId));
    await db.update(issueComments).set({ body: "second manual value" }).where(eq(issueComments.id, a.otherCommentId));
    await db.update(heartbeatRuns).set({ status: "running", stdoutExcerpt: target, contextSnapshot: null }).where(eq(heartbeatRuns.id, a.runId));
    await db.execute(sql`insert into heartbeat_run_events (company_id, run_id, agent_id, seq, event_type, message, payload)
      select ${a.companyId}::uuid, ${a.runId}::uuid, ${a.agentId}::uuid, g + 100, 'log',
        'synthetic progress ' || md5(g::text), jsonb_build_object('output', chr(27) || '[32m' || md5(g::text) || chr(27) || '[0m')
      from generate_series(1, 5000) g`);
    await db.insert(heartbeatRunEvents).values({ companyId: a.companyId, runId: a.runId, agentId: a.agentId, seq: 6000, eventType: "log", message: target });
    const selection = { targets: [target], keepLast4: false, expectedBody: target };
    const preview = await previewCommentRedaction(db, { ...a, ...selection });
    const [privateSession] = await db.insert(chatSessions).values({ companyId: a.companyId, boardUserId: "other-board", title: target }).returning();
    await db.execute(sql`insert into chat_messages (session_id, role, content)
      select ${privateSession!.id}::uuid, 'tool', jsonb_build_object('output', '\\u001b[32m C:\\\\ui\\\\src ' || md5(g::text))
      from generate_series(1, 1000) g`);
    const [privateMessage] = await db.insert(chatMessages).values({ sessionId: privateSession!.id, role: "tool", content: { output: target } }).returning();
    expect(await previewCommentRedaction(db, { ...a, ...selection })).toEqual(preview);
    const permit = actorType === "agent" ? await authorizeCommentRedaction(db, { ...a, ...selection, impactToken: preview.impactToken,
      agentId: a.agentId, requestedByUserId: "board-test", requestedByLocalBoard: true }) : undefined;
    const secondSelection = { targets: ["second manual value"], keepLast4: false, expectedBody: "second manual value" };
    const secondPreview = await previewCommentRedaction(db, { ...a, commentId: a.otherCommentId, ...secondSelection });
    const queries: string[] = [];
    let release!: () => void, arrive!: () => void;
    const pause = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { arrive = resolve; });
    let firstTransaction = true, updated = false, paused = false;
    const tracked = drizzle(db.$client, { logger: { logQuery(query) { if (firstTransaction) queries.push(query); if (query.startsWith('update "heartbeat_runs"')) updated = true; } } }) as typeof db;
    const transaction = tracked.transaction.bind(tracked);
    let transactionCalls = 0;
    const intercept = vi.spyOn(tracked, "transaction").mockImplementation((callback: any, config?: any) => transaction(async (tx) => {
      const main = ++transactionCalls === 1;
      firstTransaction = main;
      const execute = tx.execute.bind(tx);
      tx.execute = (async (statement: any) => {
        if (main && updated && !paused) { paused = true; arrive(); await pause; }
        return execute(statement);
      }) as typeof tx.execute;
      try { return await callback(tx); } finally { firstTransaction = false; }
    }, config));
    const first = executeRedaction(tracked, { ...a, runLogBaseDir: null, ...(actorType === "agent"
      ? { authorizationId: permit!.authorizationId, actor: { actorType, actorId: a.agentId, agentId: a.agentId } }
      : { selection: { ...selection, impactToken: preview.impactToken }, actor: { actorType, actorId: "board-test" } }) });
    try {
      await Promise.race([locked, first.then(() => { throw new Error("Expected actual locked-run pause"); }), new Promise((_, reject) => setTimeout(() => reject(new Error("Missing locked-run pause")), 10_000))]);
      await expect(db.transaction((tx) => tx.execute(sql`select id from heartbeat_runs where id = ${a.runId}::uuid for update nowait`))).rejects.toMatchObject({ code: "55P03" });
      const started = performance.now();
      const progress = db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.update(heartbeatRuns).set({ lastOutputAt: new Date() }).where(eq(heartbeatRuns.id, a.runId));
      });
      const second = executeRedaction(db, { ...a, commentId: a.otherCommentId, selection: { ...secondSelection, impactToken: secondPreview.impactToken }, actor: { actorType: "user", actorId: "board-test" }, runLogBaseDir: null });
      release();
      await progress;
      console.log(`R8 ${actorType} progress after locked-run pause ${(performance.now() - started).toFixed(1)}ms`);
      expect((await second).comment.body).toBe("[redacted]");
      expect(await first).toMatchObject({ comment: { body: "[redacted]" }, counts: { runExcerpts: 1, chatMessages: 0 }, cleanupStatus: "incomplete" });
    } finally { release(); await first; intercept.mockRestore(); }
    const firstRunLock = queries.findIndex((query) => query.includes('from "heartbeat_runs"') && query.endsWith("for update"));
    expect(firstRunLock).toBeGreaterThan(0);
    expect(queries.slice(firstRunLock).filter((query) => query.includes("strpos(") || query.includes(" ~ "))).toEqual([]);
    const discoveries = queries.filter((query) => query.includes("offset 0"));
    expect(discoveries).toHaveLength(12); // Ten requester-visible tables, two hidden-chat tables.
    expect(discoveries.filter((query) => query.includes('from "heartbeat_run_events"'))).toHaveLength(1);
    expect(discoveries.filter((query) => query.includes('from "chat_messages"'))).toHaveLength(2);
    expect((await db.select().from(chatMessages).where(eq(chatMessages.id, privateMessage!.id)))[0]!.content).toEqual({ output: "[redacted]" });
    if (permit) expect((await db.select().from(commentRedactionAuthorizations).where(eq(commentRedactionAuthorizations.id, permit.authorizationId)))[0]!.consumedAt).toBeInstanceOf(Date);
  }, 60_000);

  it("matches a maximum-length Unicode selection without exceeding PostgreSQL regex program limits", async () => {
    const a = await seedCompany();
    const target = Array.from({ length: 2000 }, (_, i) => String.fromCharCode(0x4e00 + i)).join("");
    const encoded = target.replace(/./g, (unit) => "\\u" + unit.charCodeAt(0).toString(16).toUpperCase());
    await db.update(issueComments).set({ body: target }).where(eq(issueComments.id, a.commentId));
    await db.update(heartbeatRuns).set({ stdoutExcerpt: encoded }).where(eq(heartbeatRuns.id, a.runId));
    const selection = { targets: [target], keepLast4: false, expectedBody: target };
    const preview = await previewCommentRedaction(db, { ...a, ...selection });
    expect(preview.counts.runExcerpts).toBe(1);
    expect((await executeRedaction(db, { ...a, selection: { ...selection, impactToken: preview.impactToken }, actor: { actorType: "user", actorId: "board-test" }, runLogBaseDir: null })).comment.body).toBe("[redacted]");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, a.runId)))[0]!.stdoutExcerpt).toBe("[redacted]");
  }, 60_000);

  it.each([1, 8])("observes mixed and uppercase escaped Unicode cut-off pieces with %s decoded backslashes", async (slashes) => {
    const a = await seedCompany();
    const target = Array.from({ length: 12 }, (_, i) => String.fromCharCode(0x4e00 + i)).join("");
    await db.update(issueComments).set({ body: target }).where(eq(issueComments.id, a.commentId));
    const selection = { targets: [target], keepLast4: false, expectedBody: target };
    const before = await previewCommentRedaction(db, { ...a, ...selection });
    const head = "synthetic prefix " + target.slice(0, 5).replace(/./g, (unit) => "\\".repeat(slashes) + "u" + unit.charCodeAt(0).toString(16).toUpperCase());
    const tail = target.slice(-5).replace(/./g, (unit, i) => i % 2 ? unit : "\\".repeat(slashes) + "u" + unit.charCodeAt(0).toString(16).toUpperCase()) + " synthetic suffix";
    await db.insert(heartbeatRuns).values([head, tail].map((text) => ({ companyId: a.companyId, agentId: a.agentId, status: "succeeded", resultJson: { text } })));
    const after = await previewCommentRedaction(db, { ...a, ...selection });
    expect(after).toMatchObject({ impactToken: before.impactToken, counts: { runExcerpts: 0 }, residualMatches: 2, cutoffCheckComplete: true });
    const result = await executeRedaction(db, { ...a, selection: { ...selection, impactToken: before.impactToken }, actor: { actorType: "user", actorId: "board-test" }, runLogBaseDir: null });
    expect(result).toMatchObject({ residualMatches: 2, counts: { runExcerpts: 0 } });
    const rows = await db.select({ value: heartbeatRuns.resultJson }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, a.companyId));
    expect(rows.map((row) => row.value)).toEqual(expect.arrayContaining([{ text: head }, { text: tail }]));
  });

  it("keeps SQL discovery a superset of lossless JS matching through four JSON encoding levels", async () => {
    for (const target of ["Caf\u00e9 account 9000001234", 'Case.["\\\n\u042f\u0436\u4e00\u4e01\ud83d\ude80\t end']) {
      const a = await seedCompany();
      await db.update(issueComments).set({ body: target }).where(eq(issueComments.id, a.commentId));
      const [hidden] = await db.insert(chatSessions).values({ companyId: a.companyId, boardUserId: "other-board", title: "Synthetic private chat" }).returning();
      const prepared = prepareCommentRedaction([target], false);
      const copies: Array<{ id: string; before: string; expected: string; json: boolean }> = [];
      const chats: Array<{ id: string; before: string; expected: string; hidden: boolean }> = [];
      for (const mixed of [false, true]) for (let level = 0; level <= 4; level++) {
        let value = target.replace(/[^\x00-\x7f]/g, (unit, index) => mixed && index % 2 && unit.charCodeAt(0) < 0xd800 ? unit
          : "\\u" + unit.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase());
        for (let n = 1; n < level; n++) value = JSON.stringify(value).slice(1, -1);
        if (level === 0) value = target;
        for (const json of [false, true]) {
          const [run] = await db.insert(heartbeatRuns).values({ companyId: a.companyId, agentId: a.agentId, status: "succeeded",
            ...(json ? { resultJson: { output: value, sessionId: value } } : { stdoutExcerpt: value }) }).returning();
          const [stored] = await db.execute(sql`select ${json ? sql`result_json::text` : sql`stdout_excerpt`} as text from heartbeat_runs where id = ${run!.id}::uuid`);
          const before = stored!.text as string;
          copies.push({ id: run!.id, before, expected: json ? redactOperationalJson(before, [target], false, undefined, prepared)
            : redactOperationalText(before, [target], false, prepared), json });
        }
        for (const [sessionId, isHidden] of [[a.sessionId, false], [hidden!.id, true]] as const) {
          const [message] = await db.insert(chatMessages).values({ sessionId, role: "tool", content: { output: value, sessionId: value } }).returning();
          // Include exact large numbers in PostgreSQL, never round them in JS.
          await db.execute(sql`update chat_messages set content = content || '{"numeric":900719925474099312345}'::jsonb where id = ${message!.id}::uuid`);
          const [stored] = await db.execute(sql`select content::text as text from chat_messages where id = ${message!.id}::uuid`);
          const before = stored!.text as string;
          chats.push({ id: message!.id, before, expected: redactOperationalJson(before, [target], false, undefined, prepared), hidden: isHidden });
        }
      }
      const selection = { targets: [target], keepLast4: false, expectedBody: target };
      const preview = await previewCommentRedaction(db, { ...a, ...selection });
      expect(preview.counts).toMatchObject({ runExcerpts: copies.filter((copy) => !copy.json && copy.expected !== copy.before).length,
        runContexts: copies.filter((copy) => copy.json && copy.expected !== copy.before).length,
        chatMessages: chats.filter((copy) => !copy.hidden && copy.expected !== copy.before).length });
      const result = await executeRedaction(db, { ...a, selection: { ...selection, impactToken: preview.impactToken }, actor: { actorType: "user", actorId: "board-test" }, runLogBaseDir: null });
      expect(result.counts).toEqual({ ...preview.counts, comment: 1 });
      expect(result.cleanupStatus).toBe("incomplete");
      for (const copy of copies) {
        const [stored] = await db.execute(sql`select ${copy.json ? sql`result_json::text` : sql`stdout_excerpt`} as text from heartbeat_runs where id = ${copy.id}::uuid`);
        expect(stored!.text).toBe(copy.expected);
      }
      for (const copy of chats) {
        const [stored] = await db.execute(sql`select content::text as text from chat_messages where id = ${copy.id}::uuid`);
        expect(stored!.text).toBe(copy.expected);
        expect(stored!.text).toContain("900719925474099312345");
      }
    }
  }, 60_000);

  it("skips a deep wake field per field, redacts the source and keeps private skips invisible", async () => {
    const a = await seedCompany();
    let deep: Record<string, unknown> = { text: ACCT };
    for (let i = 0; i < 131; i++) deep = { nested: deep };
    await db.update(agentWakeupRequests).set({ payload: deep }).where(eq(agentWakeupRequests.companyId, a.companyId));
    const selection = { targets: [ACCT], keepLast4: false, expectedBody: (await db.select().from(issueComments).where(eq(issueComments.id, a.commentId)))[0]!.body };
    const before = await previewCommentRedaction(db, { ...a, ...selection });
    expect(before).toMatchObject({ skippedFields: 1, oversizedFields: 0 });
    const [hidden] = await db.insert(chatSessions).values({ companyId: a.companyId, boardUserId: "other-board", title: "Synthetic chat" }).returning();
    await db.insert(chatMessages).values([{ sessionId: hidden!.id, role: "tool", content: deep }, { sessionId: hidden!.id, role: "tool", content: { text: ACCT } }]);
    expect(await previewCommentRedaction(db, { ...a, ...selection })).toEqual(before);
    const result = await executeRedaction(db, { ...a, selection: { ...selection, impactToken: before.impactToken }, actor: { actorType: "user", actorId: "board-test" }, runLogBaseDir: null });
    expect(result).toMatchObject({ skippedFields: 1, oversizedFields: 0, cleanupStatus: "incomplete" });
    expect(result.comment.body).not.toContain(ACCT);
    expect(JSON.stringify(result)).not.toContain(ACCT);
    const [request] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, a.companyId));
    expect(request!.payload).toEqual(deep);
    const hiddenMessages = await db.select().from(chatMessages).where(eq(chatMessages.sessionId, hidden!.id));
    expect(hiddenMessages.some((message) => JSON.stringify(message.content) === JSON.stringify({ text: "[redacted]" }))).toBe(true);
    const [audit] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, a.companyId), eq(activityLog.action, "issue.comment_redacted")));
    expect(audit!.details).toMatchObject({ skippedFields: 1, oversizedFields: 0 });
    expect(JSON.stringify(audit!.details)).not.toContain(ACCT);
  });

  it("can retry migration 0123 twice after a partially installed constraint set", async () => {
    const migration = await fs.readFile(new URL("../../../packages/db/src/migrations/0123_outstanding_tiger_shark.sql", import.meta.url), "utf8");
    await db.execute(sql`alter table comment_redaction_authorizations drop constraint comment_redaction_authorizations_agent_id_agents_id_fk`);
    for (let round = 0; round < 2; round++) {
      for (const statement of migration.split("--> statement-breakpoint")) if (statement.trim()) await db.execute(sql.raw(statement));
    }
    const result = await db.execute(sql`select confdeltype from pg_constraint where conname = 'comment_redaction_authorizations_agent_id_agents_id_fk'`);
    expect(result[0]?.confdeltype).toBe("c");
  });

  it("does not save an unaudited database redaction when the audit insert fails", async () => {
    const a = await seedCompany();
    // A named function is needed because pooled connections can vary.
    await db.execute(sql`create function test_reject_redaction_audit() returns trigger language plpgsql as $$
      begin if NEW.action = 'issue.comment_redacted' then raise exception 'example audit failure'; end if; return NEW; end $$`);
    await db.execute(sql`create trigger test_redaction_audit_failure before insert on activity_log for each row execute function test_reject_redaction_audit()`);
    try {
      await expect(redactIssueCommentEverywhere(db, { companyId: a.companyId, commentId: a.commentId, targets: [ACCT], keepLast4: false, runLogBaseDir: logDir })).rejects.toThrow();
      const [comment] = await db.select().from(issueComments).where(eq(issueComments.id, a.commentId));
      expect(comment!.body).toContain(ACCT);
      expect(await fs.readFile(a.logFile, "utf8")).toContain(ACCT);
    } finally {
      await db.execute(sql`drop trigger test_redaction_audit_failure on activity_log`);
      await db.execute(sql`drop function test_reject_redaction_audit()`);
    }
  });
});

describe("manual JSON replacement", () => {
  it("preserves keys and structural values while replacing human text", () => {
    expect(redactCommentJson({ example: 1, "[redacted]": 2, body: "example", sessionParams: { body: "example" } }, ["example"], false)).toEqual({ example: 1, "[redacted]": 2, body: "[redacted]", sessionParams: { body: "example" } });
  });
});
