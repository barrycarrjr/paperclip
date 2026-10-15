import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issueRelations, issues } from "@paperclipai/db";
import { formatRunCountsFooter } from "@paperclipai/adapter-utils/run-counts";
import { getTestDatabaseSupport, startTestDatabase } from "./helpers/test-postgres.js";
import { waitForHeartbeatRunsToFinish } from "./helpers/heartbeat-runs.js";
import {
  finalizeIssueCommentCorrectionAttribution,
  heartbeatService,
  patchPendingRunCountPolicy,
} from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", async () => ({
  ...await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js"),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute }),
}));

const support = await getTestDatabaseSupport();
const describeDatabase = support.supported ? describe : describe.skip;
type ExecuteInput = {
  runId: string;
  agent: { id: string; companyId: string };
  context: Record<string, unknown>;
};
const completed = (summary: string, resultJson?: Record<string, unknown>) => ({ exitCode: 0, signal: null, timedOut: false, summary, resultJson, provider: "test", model: "test-model" });
const failed = (summary: string) => ({ exitCode: 1, signal: null, timedOut: false, summary, errorMessage: "provider failed", provider: "test", model: "test-model" });
const transientFailed = (summary: string) => ({
  ...failed(summary),
  errorCode: "adapter_failed",
  errorFamily: "transient_upstream",
  resultJson: { errorFamily: "transient_upstream" },
});
const isReportingCorrection = (run: typeof heartbeatRuns.$inferSelect) =>
  ["missing_issue_comment", "missing_run_counts", "invalid_run_counts"].includes(
    String((run.contextSnapshot as Record<string, unknown> | null)?.retryReason ?? ""),
  );

describeDatabase("issue-bound unattended run count reporting", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startTestDatabase>>;
  let home: string;
  const oldHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    database = await startTestDatabase("paperclip-run-counts-"); db = createDb(database.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-counts-home-")); process.env.PAPERCLIP_HOME = home;
  }, 90_000);
  beforeEach(async () => { await waitForHeartbeatRunsToFinish(db); execute.mockReset(); });
  afterAll(async () => {
    await waitForHeartbeatRunsToFinish(db); await new Promise((resolve) => setTimeout(resolve, 100));
    await db.$client.end({ timeout: 0 }); await database.cleanup();
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
    await fs.rm(home, { recursive: true, force: true });
  });

  async function start(
    source: "assignment" | "automation" | "on_demand" = "assignment",
    bindIssue = true,
    adapterType = "codex_local",
  ) {
    const companyId = randomUUID(); const agentId = randomUUID(); const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Counts Company", issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 8)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Counts Agent", role: "engineer", status: "idle", adapterType, adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    if (bindIssue) await db.insert(issues).values({ id: issueId, companyId, title: "Read assigned notes", status: "todo", priority: "medium", assigneeAgentId: agentId });
    const heartbeat = heartbeatService(db);
    await heartbeat.wakeup(agentId, { source, triggerDetail: source === "on_demand" ? "manual" : "system", reason: "issue_assigned", payload: bindIssue ? { issueId } : {}, contextSnapshot: bindIssue ? { issueId, taskId: issueId, wakeReason: "issue_assigned" } : {}, requestedByActorType: "system" });
    return { companyId, agentId, issueId, heartbeat };
  }

  async function finish(agentId: string, predicate: (runs: typeof heartbeatRuns.$inferSelect[]) => boolean) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)).orderBy(asc(heartbeatRuns.createdAt));
      if (predicate(runs)) { await waitForHeartbeatRunsToFinish(db); return runs; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Count reporting did not finish");
  }

  async function postRunComment(input: ExecuteInput, body: string) {
    const issueId = typeof input.context.issueId === "string" ? input.context.issueId : null;
    if (!issueId) throw new Error("Expected an issue-bound run");
    await db.insert(issueComments).values({
      companyId: input.agent.companyId,
      issueId,
      authorAgentId: input.agent.id,
      createdByRunId: input.runId,
      body,
    });
  }

  it("captures mandatory prompt guidance and stores explicit zero from the final comment", async () => {
    execute.mockResolvedValue(completed(`Read the relevant notes; no entries or proposals were needed.\n${formatRunCountsFooter({ itemsRead: 0, entriesAdded: 0, changesProposed: 0 })}`, { runCounts: { itemsRead: 999, entriesAdded: 999, changesProposed: 999 } }));
    const { agentId, issueId } = await start();
    const runs = await finish(agentId, (rows) => rows.length === 1 && rows[0]?.issueCommentStatus === "satisfied");
    expect(execute.mock.calls[0]![0].context.paperclipTaskMarkdown).not.toContain("Run count reporting:");
    expect(execute.mock.calls[0]![0].context.paperclipWake).toMatchObject({ runCountsRequired: true, runCountsRetryReason: null, issue: { id: issueId } });
    expect(runs[0]!.resultJson).toMatchObject({ runCounts: { itemsRead: 0, entriesAdded: 0, changesProposed: 0 }, runCountsReporting: { status: "reported", source: "issue_comment" } });
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("Counts: items read 0");
  });

  it("keeps a valid task footer when a later workspace status comment belongs to the same run", async () => {
    execute.mockImplementationOnce(async (input: ExecuteInput) => {
      await postRunComment(
        input,
        `Completed the task.\n${formatRunCountsFooter({ itemsRead: 3, entriesAdded: 1, changesProposed: 0 })}`,
      );
      return {
        ...completed("Completed the task."),
        runtimeServices: [{ id: randomUUID(), serviceName: "Preview", url: "http://127.0.0.1:4100" }],
      };
    });

    const { agentId, issueId } = await start("automation");
    const runs = await finish(agentId, (rows) => rows.length === 1 && rows[0]?.issueCommentStatus === "satisfied");

    expect(runs[0]?.resultJson).toMatchObject({
      runCounts: { itemsRead: 3, entriesAdded: 1, changesProposed: 0 },
      runCountsReporting: { status: "reported", source: "issue_comment" },
    });
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)).orderBy(asc(issueComments.createdAt));
    expect(comments).toHaveLength(2);
    expect(comments[1]?.authorType).toBe("system");
    expect(comments[1]?.body).toContain("Workspace Ready");
  }, 15_000);

  it.each(["missing", "invalid"])("corrects a %s footer once and attributes it solely to the original run", async (kind) => {
    execute.mockResolvedValueOnce(completed(kind === "missing" ? "Read source notes." : "Read source notes.\nCounts: items read -1; entries added 0; changes proposed 0."));
    execute.mockResolvedValue(completed(`Corrected report from the preceding run's retained evidence.\n${formatRunCountsFooter({ itemsRead: 7, entriesAdded: 0, changesProposed: 2 })}`));
    const { agentId } = await start("automation");
    const runs = await finish(agentId, (rows) => rows.length === 2 && rows.every((row) => row.issueCommentStatus === "satisfied"));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]![0].context.paperclipTaskMarkdown).not.toContain("Run count reporting:");
    expect(execute.mock.calls[1]![0].context.paperclipWake).toMatchObject({ runCountsRequired: true, runCountsRetryReason: kind === "missing" ? "missing_run_counts" : "invalid_run_counts" });
    expect(runs[1]!.contextSnapshot).toMatchObject({ retryReason: kind === "missing" ? "missing_run_counts" : "invalid_run_counts" });
    expect(runs[0]!.resultJson).toMatchObject({ runCounts: { itemsRead: 7, entriesAdded: 0, changesProposed: 2 }, runCountsReporting: { reportedByRunId: runs[1]!.id } });
    expect(runs[0]!.issueCommentSatisfiedByCommentId).toBe(runs[1]!.issueCommentSatisfiedByCommentId);
    expect(runs[1]!.resultJson).toMatchObject({ runCounts: null, runCountsReporting: { status: "report_only", reportedForRunId: runs[0]!.id } });
    expect(runs.map((run) => (run.resultJson as any)?.runCounts).filter(Boolean)).toHaveLength(1);
  });

  it("records a process reporting correction without invoking the configured process again", async () => {
    execute.mockResolvedValueOnce(completed("Finished external work without a count footer."));
    const { agentId } = await start("automation", true, "process");

    const runs = await finish(
      agentId,
      (rows) => rows.length === 2 && rows.every((row) => row.issueCommentStatus === "retry_exhausted"),
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(runs[1]?.resultJson).toMatchObject({
      reportingCorrectionSkipped: true,
      retryReason: "missing_run_counts",
    });
  });

  it("exhausts a reporting correction cancelled before it can be claimed", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const originalRunId = randomUUID();
    const correctionRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Cancelled Correction Company",
      issuePrefix: `X${companyId.replace(/-/g, "").slice(0, 8)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cancelled Correction Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cancel queued correction",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values([
      {
        id: originalRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        status: "succeeded",
        contextSnapshot: { issueId, taskId: issueId },
        resultJson: { runCounts: null, runCountsReporting: { status: "missing" } },
        issueCommentStatus: "retry_queued",
      },
      {
        id: correctionRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        status: "queued",
        retryOfRunId: originalRunId,
        contextSnapshot: { issueId, taskId: issueId, retryReason: "missing_run_counts" },
        issueCommentStatus: "not_applicable",
      },
    ]);

    await heartbeatService(db).cancelRun(correctionRunId);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId))
      .orderBy(asc(heartbeatRuns.createdAt));
    expect(runs.find((run) => run.id === originalRunId)?.issueCommentStatus).toBe("retry_exhausted");
    expect(runs.find((run) => run.id === correctionRunId)).toMatchObject({
      status: "cancelled",
      retryOfRunId: originalRunId,
      issueCommentStatus: "retry_exhausted",
    });
  });

  it("corrects missing counts after the run marks its issue done", async () => {
    execute.mockImplementationOnce(async (input: ExecuteInput) => {
      await issueService(db).update(String(input.context.issueId), { status: "done" });
      return completed("Finished the assigned work without the count footer.");
    });
    execute.mockResolvedValueOnce(completed(
      `Corrected report from the completed run's retained evidence.\n${formatRunCountsFooter({ itemsRead: 4, entriesAdded: 1, changesProposed: 0 })}`,
    ));

    const { agentId, issueId } = await start("automation");
    const runs = await finish(agentId, (rows) => rows.length === 2 && rows.every((row) => row.issueCommentStatus === "satisfied"));

    expect(execute).toHaveBeenCalledTimes(2);
    expect(runs[0]?.resultJson).toMatchObject({ runCounts: { itemsRead: 4, entriesAdded: 1, changesProposed: 0 } });
    expect(runs[1]?.contextSnapshot).toMatchObject({ retryReason: "missing_run_counts" });
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue?.status).toBe("done");
  });

  it("posts the missing final report after the run marks its issue done", async () => {
    execute.mockImplementationOnce(async (input: ExecuteInput) => {
      await issueService(db).update(String(input.context.issueId), { status: "done" });
      return completed("");
    });
    execute.mockResolvedValueOnce(completed(
      `Recovered the completed run's report.\n${formatRunCountsFooter({ itemsRead: 2, entriesAdded: 0, changesProposed: 1 })}`,
    ));

    const { agentId, issueId } = await start("automation");
    const runs = await finish(agentId, (rows) => rows.length === 2 && rows.every((row) => row.issueCommentStatus === "satisfied"));

    expect(execute).toHaveBeenCalledTimes(2);
    expect(runs[0]?.resultJson).toMatchObject({ runCounts: { itemsRead: 2, entriesAdded: 0, changesProposed: 1 } });
    expect(runs[1]?.contextSnapshot).toMatchObject({ retryReason: "missing_issue_comment" });
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue?.status).toBe("done");
  });

  it("does not reopen a blocked issue while correcting its counts", async () => {
    execute.mockImplementationOnce(async (input: ExecuteInput) => {
      const issueId = String(input.context.issueId);
      const blockerId = randomUUID();
      await db.insert(issues).values({
        id: blockerId,
        companyId: input.agent.companyId,
        title: "Unresolved source request",
        status: "todo",
        priority: "medium",
      });
      await db.insert(issueRelations).values({
        companyId: input.agent.companyId,
        issueId: blockerId,
        relatedIssueId: issueId,
        type: "blocks",
      });
      await issueService(db).update(issueId, { status: "blocked" });
      return completed("Blocked after reviewing the available evidence.");
    });
    execute.mockResolvedValueOnce(completed(
      `Corrected report from the blocked run's retained evidence.\n${formatRunCountsFooter({ itemsRead: 3, entriesAdded: 0, changesProposed: 1 })}`,
    ));

    const { agentId, issueId } = await start("automation");
    const runs = await finish(agentId, (rows) => rows.length === 2 && rows.every((row) => row.issueCommentStatus === "satisfied"));

    expect(runs[1]?.contextSnapshot).toMatchObject({ retryReason: "missing_run_counts" });
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue).toMatchObject({ status: "blocked", checkoutRunId: null, executionRunId: null });
  });

  it("preserves validated counts when downstream finalization fails", async () => {
    execute.mockImplementationOnce(async (input: ExecuteInput) => {
      await db.execute(sql.raw(`
        create sequence paperclip_test_runtime_finalize_fail_seq start 1;
        create function paperclip_test_fail_runtime_finalization() returns trigger
        language plpgsql as $$
        begin
          if new.agent_id = '${input.agent.id}'::uuid
             and new.last_run_id is not null
             and nextval('paperclip_test_runtime_finalize_fail_seq') = 1 then
            raise exception 'injected runtime finalization failure';
          end if;
          return new;
        end;
        $$;
        create trigger paperclip_test_fail_runtime_finalization
        before update on agent_runtime_state
        for each row execute function paperclip_test_fail_runtime_finalization();
      `));
      return completed(`Finished with a valid report.\n${formatRunCountsFooter({ itemsRead: 5, entriesAdded: 1, changesProposed: 2 })}`);
    });
    execute.mockResolvedValue(completed(`Recovery finished.\n${formatRunCountsFooter({ itemsRead: 0, entriesAdded: 0, changesProposed: 0 })}`));

    const { agentId } = await start("automation");
    let runs: typeof heartbeatRuns.$inferSelect[] = [];
    try {
      runs = await finish(agentId, (rows) => rows.some((row) => (
        row.retryOfRunId === null
          && row.status === "failed"
          && row.issueCommentStatus === "satisfied"
      )));
    } finally {
      await db.execute(sql.raw("drop trigger if exists paperclip_test_fail_runtime_finalization on agent_runtime_state"));
      await db.execute(sql.raw("drop function if exists paperclip_test_fail_runtime_finalization()"));
      await db.execute(sql.raw("drop sequence if exists paperclip_test_runtime_finalize_fail_seq"));
    }

    const originalRun = runs.find((row) => row.retryOfRunId === null);
    expect(originalRun?.resultJson).toMatchObject({
      runCounts: { itemsRead: 5, entriesAdded: 1, changesProposed: 2 },
      runCountsReporting: { status: "reported" },
    });
  });

  it.each(["pending", "missing", "invalid"] as const)(
    "reconciles a terminal run left with %s count reporting by process shutdown",
    async (reportingStatus) => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Pending Report Company",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 8)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Pending Report Agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Recover pending counts",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "succeeded",
      contextSnapshot: { issueId, taskId: issueId },
      resultJson: { runCounts: null, runCountsReporting: { status: reportingStatus } },
      issueCommentStatus: "not_applicable",
    });
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: agentId,
      createdByRunId: runId,
      body: `Recovered after restart.\n${formatRunCountsFooter({ itemsRead: 6, entriesAdded: 2, changesProposed: 1 })}`,
    });

    const result = await heartbeatService(db).reconcileTerminalRunCountReports();

    expect(result).toMatchObject({ checked: 1, satisfied: 1, retryQueued: 0, retryExhausted: 0 });
    const [reconciled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(reconciled?.issueCommentStatus).toBe("satisfied");
    expect(reconciled?.resultJson).toMatchObject({
      runCounts: { itemsRead: 6, entriesAdded: 2, changesProposed: 1 },
      runCountsReporting: { status: "reported" },
    });
    },
  );

  it("waits for a fresh terminal finalizer before startup recovery takes over", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Finalizing Counts Company",
      issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 8)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Finalizing Counts Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Finish count reporting",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "succeeded",
      contextSnapshot: { issueId, taskId: issueId },
      resultJson: { runCounts: null, runCountsReporting: { status: "finalizing" } },
      issueCommentStatus: "not_applicable",
      updatedAt: new Date(),
    });
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: agentId,
      createdByRunId: runId,
      body: `Recovered after restart.\n${formatRunCountsFooter({ itemsRead: 2, entriesAdded: 1, changesProposed: 0 })}`,
    });

    const heartbeat = heartbeatService(db);
    await expect(heartbeat.reconcileTerminalRunCountReports()).resolves.toMatchObject({ checked: 0 });

    await db
      .update(heartbeatRuns)
      .set({ updatedAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(heartbeatRuns.id, runId));
    await expect(heartbeat.reconcileTerminalRunCountReports()).resolves.toMatchObject({ checked: 1, satisfied: 1 });
  });

  it("rolls back both sides when correction attribution fails between the two run updates", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const originalRunId = randomUUID();
    const correctionRunId = randomUUID();
    const commentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Atomic Counts Company",
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 8)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Atomic Counts Agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Attribute corrected counts",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values([
      {
        id: originalRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        status: "succeeded",
        contextSnapshot: { issueId },
        resultJson: { runCounts: null, runCountsReporting: { status: "missing" } },
        issueCommentStatus: "retry_queued",
        issueCommentRetryQueuedAt: new Date(),
      },
      {
        id: correctionRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        status: "succeeded",
        retryOfRunId: originalRunId,
        contextSnapshot: { issueId, retryReason: "missing_run_counts" },
        resultJson: { runCounts: null, runCountsReporting: { status: "pending" } },
        issueCommentStatus: "not_applicable",
      },
    ]);
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorAgentId: agentId,
      createdByRunId: correctionRunId,
      body: `Corrected report.\n${formatRunCountsFooter({ itemsRead: 4, entriesAdded: 1, changesProposed: 2 })}`,
    });

    await db.execute(sql.raw(`
      create function paperclip_test_fail_count_target_update() returns trigger
      language plpgsql as $$
      begin
        if old.issue_comment_status = 'retry_queued' and new.issue_comment_status = 'satisfied' then
          raise exception 'injected correction target failure';
        end if;
        return new;
      end;
      $$;
      create trigger paperclip_test_fail_count_target_update
      before update on heartbeat_runs
      for each row execute function paperclip_test_fail_count_target_update();
    `));
    try {
      await expect(finalizeIssueCommentCorrectionAttribution(db, {
        correctionRunId,
        targetRunId: originalRunId,
        companyId,
        agentId,
        issueId,
        commentId,
        counts: { itemsRead: 4, entriesAdded: 1, changesProposed: 2 },
      })).rejects.toThrow("injected correction target failure");
    } finally {
      await db.execute(sql.raw("drop trigger if exists paperclip_test_fail_count_target_update on heartbeat_runs"));
      await db.execute(sql.raw("drop function if exists paperclip_test_fail_count_target_update()"));
    }

    const rolledBack = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)).orderBy(asc(heartbeatRuns.createdAt));
    expect(rolledBack).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: originalRunId, issueCommentStatus: "retry_queued", issueCommentSatisfiedByCommentId: null }),
      expect.objectContaining({ id: correctionRunId, issueCommentStatus: "not_applicable", issueCommentSatisfiedByCommentId: null }),
    ]));
    expect(rolledBack.find((run) => run.id === originalRunId)?.resultJson).toMatchObject({ runCounts: null, runCountsReporting: { status: "missing" } });
    expect(rolledBack.find((run) => run.id === correctionRunId)?.resultJson).toMatchObject({ runCounts: null, runCountsReporting: { status: "pending" } });

    await expect(finalizeIssueCommentCorrectionAttribution(db, {
      correctionRunId,
      targetRunId: originalRunId,
      companyId,
      agentId,
      issueId,
      commentId,
      counts: { itemsRead: 4, entriesAdded: 1, changesProposed: 2 },
    })).resolves.toBe(true);
    await expect(finalizeIssueCommentCorrectionAttribution(db, {
      correctionRunId,
      targetRunId: originalRunId,
      companyId,
      agentId,
      issueId,
      commentId,
      counts: { itemsRead: 4, entriesAdded: 1, changesProposed: 2 },
    })).resolves.toBe(true);
    const committed = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(committed).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: originalRunId, issueCommentStatus: "satisfied", issueCommentSatisfiedByCommentId: commentId }),
      expect.objectContaining({ id: correctionRunId, issueCommentStatus: "satisfied", issueCommentSatisfiedByCommentId: commentId }),
    ]));

    await expect(patchPendingRunCountPolicy(db, {
      runId: originalRunId,
      companyId,
      patch: {
        resultJson: { runCounts: null, runCountsReporting: { status: "missing" } },
        issueCommentStatus: "retry_exhausted",
        issueCommentSatisfiedByCommentId: null,
      },
    })).resolves.toBeNull();
    const [preserved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, originalRunId));
    expect(preserved).toMatchObject({
      issueCommentStatus: "satisfied",
      issueCommentSatisfiedByCommentId: commentId,
      resultJson: {
        runCounts: { itemsRead: 4, entriesAdded: 1, changesProposed: 2 },
        runCountsReporting: { status: "reported", reportedByRunId: correctionRunId },
      },
    });
  });

  it("exhausts one unsuccessful correction without inventing counts or another retry", async () => {
    execute.mockResolvedValue(completed("Read notes but did not report counts."));
    const { agentId } = await start();
    const runs = await finish(agentId, (rows) => rows.length === 2 && rows[1]?.issueCommentStatus === "retry_exhausted");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(runs.every((run) => (run.resultJson as any)?.runCounts === null)).toBe(true);
    expect(runs[0]!.issueCommentStatus).toBe("retry_exhausted");
    expect(runs[1]!.retryOfRunId).toBe(runs[0]!.id);
  });

  it.each(["missing", "invalid"])(
    "keeps a failed %s correction out of transient work recovery",
    async (kind) => {
      execute.mockImplementationOnce(async (input: ExecuteInput) => {
        const body = kind === "missing"
          ? "The provider failed after reading notes."
          : "The provider failed.\nCounts: items read -1; entries added 0; changes proposed 0.";
        await postRunComment(input, body);
        return transientFailed(body);
      });
      execute.mockImplementationOnce(async (input: ExecuteInput) => {
        const body = kind === "missing"
          ? "The reporting correction also failed before posting counts."
          : "The reporting correction failed.\nCounts: items read -1; entries added 0; changes proposed 0.";
        if (kind === "invalid") await postRunComment(input, body);
        return transientFailed(body);
      });

      const { agentId } = await start("automation");
      await finish(
        agentId,
        (rows) => rows.length >= 3 && rows.some((row) =>
          isReportingCorrection(row) &&
          row.status === "failed" &&
          row.issueCommentStatus === "retry_exhausted"
        ),
      );
      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId))
        .orderBy(asc(heartbeatRuns.createdAt));
      const original = runs.find((row) => row.retryOfRunId === null);
      const correction = runs.find(isReportingCorrection);
      const scheduledRetries = runs.filter((row) => row.status === "scheduled_retry");

      expect(runs).toHaveLength(3);
      expect(original?.issueCommentStatus).toBe("retry_exhausted");
      expect(correction?.issueCommentStatus).toBe("retry_exhausted");
      expect(correction?.retryOfRunId).toBe(original?.id);
      expect(scheduledRetries).toHaveLength(1);
      expect(scheduledRetries[0]?.retryOfRunId).toBe(original?.id);
      expect(scheduledRetries[0]?.contextSnapshot).toMatchObject({
        retryReason: "transient_failure",
        retryOfRunId: original?.id,
      });
      expect(runs.some((row) => row.retryOfRunId === correction?.id)).toBe(false);
    },
  );

  it.each(["missing", "invalid"])("repairs %s counts after a failed unattended run", async (kind) => {
    execute.mockImplementationOnce(async (input: ExecuteInput) => {
      const body = kind === "missing"
        ? "The provider failed after reading notes."
        : "The provider failed.\nCounts: items read -1; entries added 0; changes proposed 0.";
      await postRunComment(input, body);
      return failed(body);
    });
    execute.mockResolvedValueOnce(completed(`Recovered the failed run's report.\n${formatRunCountsFooter({ itemsRead: 2, entriesAdded: 0, changesProposed: 0 })}`));
    execute.mockResolvedValueOnce(completed(`Continued the interrupted work.\n${formatRunCountsFooter({ itemsRead: 0, entriesAdded: 0, changesProposed: 0 })}`));
    const { agentId } = await start("automation");
    const runs = await finish(agentId, (rows) => rows.length === 3 && rows.every((row) => row.issueCommentStatus === "satisfied"));
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.resultJson).toMatchObject({ runCounts: { itemsRead: 2, entriesAdded: 0, changesProposed: 0 } });
    expect(runs[1]?.retryOfRunId).toBe(runs[0]?.id);
    expect(runs[1]?.contextSnapshot).toMatchObject({ retryReason: kind === "missing" ? "missing_run_counts" : "invalid_run_counts" });
    expect(runs[2]?.retryOfRunId).toBe(runs[0]?.id);
    expect(runs[2]?.contextSnapshot).toMatchObject({ retryReason: "issue_continuation_needed" });
  });

  it("accepts valid counts from a failed unattended run before resuming its work", async () => {
    execute.mockImplementationOnce(async (input: ExecuteInput) => {
      const body = `The provider failed after the work.\n${formatRunCountsFooter({ itemsRead: 1, entriesAdded: 0, changesProposed: 0 })}`;
      await postRunComment(input, body);
      return failed(body);
    });
    execute.mockResolvedValueOnce(completed(`Continued the interrupted work.\n${formatRunCountsFooter({ itemsRead: 0, entriesAdded: 0, changesProposed: 0 })}`));
    const { agentId } = await start("assignment");
    const runs = await finish(agentId, (rows) => rows.length === 2 && rows.every((row) => row.issueCommentStatus === "satisfied"));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.resultJson).toMatchObject({ runCounts: { itemsRead: 1, entriesAdded: 0, changesProposed: 0 } });
    expect(runs[1]?.retryOfRunId).toBe(runs[0]?.id);
    expect(runs[1]?.contextSnapshot).toMatchObject({ retryReason: "issue_continuation_needed" });
  });

  it("runs a count correction before promoting a deferred comment wake", async () => {
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    execute.mockImplementationOnce(async () => {
      markFirstStarted();
      await firstGate;
      return completed("Finished the assigned work without the count footer.");
    });
    execute.mockResolvedValueOnce(completed(`Corrected report.\n${formatRunCountsFooter({ itemsRead: 3, entriesAdded: 0, changesProposed: 1 })}`));
    execute.mockResolvedValueOnce(completed(`Handled the deferred comment.\n${formatRunCountsFooter({ itemsRead: 0, entriesAdded: 0, changesProposed: 0 })}`));

    const { companyId, agentId, issueId, heartbeat } = await start();
    await firstStarted;
    const comment = await db.insert(issueComments).values({
      companyId,
      issueId,
      authorUserId: "user-1",
      body: "Please also check the deferred note.",
    }).returning().then((rows) => rows[0]);
    const deferred = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: comment.id },
      contextSnapshot: { issueId, taskId: issueId, commentId: comment.id, wakeReason: "issue_commented" },
      requestedByActorType: "user",
      requestedByActorId: "user-1",
    });
    expect(deferred).toBeNull();

    releaseFirst();
    const runs = await finish(
      agentId,
      (rows) => rows.length === 3 && rows.every((row) => row.status === "succeeded" && row.issueCommentStatus === "satisfied"),
    );
    const [original, correction, promoted] = runs;
    expect(correction?.retryOfRunId).toBe(original?.id);
    expect(promoted?.retryOfRunId).toBeNull();
    expect(promoted?.contextSnapshot).toMatchObject({ commentId: comment.id, wakeReason: "issue_commented" });
    expect(original?.resultJson).toMatchObject({ runCounts: { itemsRead: 3, entriesAdded: 0, changesProposed: 1 } });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("distinguishes a wholly missing task comment and attributes the one reporting correction to its original", async () => {
    execute.mockResolvedValueOnce(completed(""));
    execute.mockResolvedValue(completed(`Recovered report.\n${formatRunCountsFooter({ itemsRead: 1, entriesAdded: 0, changesProposed: 0 })}`));
    const { agentId } = await start();
    const runs = await finish(agentId, (rows) => rows.length === 2 && rows.every((row) => row.issueCommentStatus === "satisfied"));
    expect(runs[1]!.contextSnapshot).toMatchObject({ retryReason: "missing_issue_comment" });
    expect(execute.mock.calls[1]![0].context.paperclipTaskMarkdown).not.toContain("Run count reporting:");
    expect(execute.mock.calls[1]![0].context.paperclipWake).toMatchObject({ runCountsRetryReason: "missing_issue_comment" });
    expect(runs[0]!.resultJson).toMatchObject({ runCounts: { itemsRead: 1, entriesAdded: 0, changesProposed: 0 } });
    expect(runs[1]!.resultJson).toMatchObject({ runCounts: null, runCountsReporting: { status: "report_only" } });
  });

  it("leaves manual invocations and issue-free automation outside mandatory reporting", async () => {
    execute.mockResolvedValue(completed("Manual report."));
    const manual = await start("on_demand");
    const manualRuns = await finish(manual.agentId, (rows) => rows.length === 1 && rows[0]?.issueCommentStatus === "satisfied");
    expect(execute.mock.calls[0]![0].context.paperclipTaskMarkdown).not.toContain("Run count reporting:");
    expect(manualRuns[0]!.resultJson).toMatchObject({ runCounts: null, runCountsReporting: { status: "not_required" } });
    const automated = await start("automation", false);
    const automatedRuns = await finish(automated.agentId, (rows) => rows.length === 1 && rows[0]?.status === "succeeded");
    expect(automatedRuns[0]!.resultJson).toMatchObject({ runCounts: null, runCountsReporting: { status: "not_required" } });
  });
});
