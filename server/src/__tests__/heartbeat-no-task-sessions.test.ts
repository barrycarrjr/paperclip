import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentRuntimeState, agents, approvals, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { approvalDecisionService } from "../services/approval-decisions.js";
import { buildInvokeWakeContext } from "../services/channel-host-methods.js";
import {
  deriveTaskKeyWithHeartbeatFallback,
  heartbeatService,
  readWakePrompts,
  WAKE_PROMPT_CONTEXT_KEY,
} from "../services/heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

type AdapterInput = { runId: string; runtime: { sessionId: string | null } };

// A run that does start finishes at once, without spawning anything.
const { finishedRunResult, mockAdapterExecute } = vi.hoisted(() => {
  const finishedRunResult = {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "No-task session test run.",
    provider: "test",
    model: "test-model",
  };
  return {
    finishedRunResult,
    mockAdapterExecute: vi.fn(async (_input: AdapterInput): Promise<Record<string, unknown>> => ({ ...finishedRunResult })),
  };
});

vi.mock("../adapters/index.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// A plugin's agent session: a task of its own, with its own conversation.
const BOOKS_TASK_KEY = "plugin:slack-tools:session:books";

/**
 * A run with no task (someone pressing Run now, a plugin invoking the agent)
 * must not continue the session the agent saved last: that is often a task's,
 * and can be one another of the agent's runs is using right now. Each kind of
 * wake keeps a conversation of its own, the way scheduled runs do.
 */
describeEmbeddedPostgres("sessions of runs with no task", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  // Runs that start write their workspace and run logs under the Paperclip
  // home, so they get a throwaway one instead of the real ~/.paperclip.
  let paperclipHome: string | null = null;
  const previousPaperclipHome = process.env.PAPERCLIP_HOME;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-no-task-sessions-");
    db = createDb(tempDb.connectionString);
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-no-task-sessions-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
  }, 120_000);

  beforeEach(() => {
    // Also drops any one-off implementation a test left unused.
    mockAdapterExecute.mockReset();
  });

  afterAll(async () => {
    // Let the last started run finish its after-run bookkeeping first.
    await settle(300);
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
    if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousPaperclipHome;
    if (paperclipHome) await fs.rm(paperclipHome, { recursive: true, force: true, maxRetries: 5 });
  });

  function settle(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function createAgent(maxConcurrentRuns = 1, heartbeat: Record<string, unknown> = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `N${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "EA",
      role: "general",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { maxConcurrentRuns, ...heartbeat } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  /** A run already going, written straight in: it holds a slot and never finishes. */
  async function insertRunningRun(ids: { companyId: string; agentId: string }, contextSnapshot: Record<string, unknown>) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      ...ids,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      contextSnapshot,
    });
    return runId;
  }

  /** Pat pressing Run now on the agent, as the agent page does. */
  function runNow(agentId: string, context: Record<string, unknown> = {}) {
    return heartbeatService(db).invoke(
      agentId,
      "on_demand",
      { triggeredBy: "board", actorId: "user-pat", ...context },
      "manual",
      { actorType: "user", actorId: "user-pat" },
    );
  }

  /** A message in the plugin's agent session, which runs that session's task. */
  function sendSessionMessage(agentId: string, prompt: string) {
    return heartbeatService(db).wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      payload: { prompt },
      requestedByActorType: "system",
      requestedByActorId: "plugin-slack-tools",
      contextSnapshot: {
        taskKey: BOOKS_TASK_KEY,
        wakeSource: "automation",
        wakeTriggerDetail: "system",
        [WAKE_PROMPT_CONTEXT_KEY]: prompt,
      },
    });
  }

  /** A plugin invoking the agent with no task, as `agents.invoke` does. */
  function pluginInvoke(agentId: string, pluginKey: string, prompt: string) {
    const pluginId = `plugin-${pluginKey}`;
    return heartbeatService(db).wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: null,
      payload: { prompt },
      requestedByActorType: "system",
      requestedByActorId: pluginId,
      contextSnapshot: buildInvokeWakeContext({ prompt, reason: null, pluginId, pluginKey }),
    });
  }

  /** The Retry button on a failed run, as the agent page and the inbox send it. */
  function retry(agentId: string, run: { id: string }) {
    return heartbeatService(db).wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "retry_failed_run",
      payload: { retryOfRunId: run.id },
      requestedByActorType: "user",
      requestedByActorId: "user-pat",
      contextSnapshot: { triggeredBy: "board", actorId: "user-pat" },
    });
  }

  /** The Resume button on a run that lost its process, which asks for that run's session. */
  function resume(agentId: string, run: { id: string }) {
    return heartbeatService(db).wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "resume_process_lost_run",
      payload: { resumeFromRunId: run.id },
      requestedByActorType: "user",
      requestedByActorId: "user-pat",
      contextSnapshot: { triggeredBy: "board", actorId: "user-pat" },
    });
  }

  /** A message the agent drafted for approval, as the draft gate records it. */
  async function insertDraftApproval(ids: { companyId: string; agentId: string }, draftRunId: string | null) {
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId: ids.companyId,
      type: "outbound_tool_draft",
      status: "pending",
      requestedByAgentId: ids.agentId,
      payload: {
        toolName: "slack-tools:slack_send_dm",
        parameters: { text: "The rent is paid." },
        summary: "Tell the landlord the rent is paid",
        agentId: ids.agentId,
        runId: draftRunId,
      },
    });
    return approvalId;
  }

  /** Pat approving the draft; the decision wakes the agent. Returns the run it woke. */
  async function approve(approvalId: string, endsOn: string) {
    mockAdapterExecute.mockImplementationOnce(async () => ({ ...finishedRunResult, sessionId: endsOn }));
    await approvalDecisionService(db, { heartbeat: heartbeatService(db) }).approve({
      approvalId,
      decidedByUserId: "user-pat",
    });
    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.contextSnapshot} ->> 'approvalId' = ${approvalId}`)
      .then((rows) => rows[0] ?? null);
    expect(run).not.toBeNull();
    expect(await waitForRunStatus(run!.id, "succeeded")).toBe("succeeded");
    return run!;
  }

  /** The conversation a run continues, read from its context the way the run itself reads it. */
  async function conversationOf(runId: string) {
    const run = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    return deriveTaskKeyWithHeartbeatFallback(run?.contextSnapshot as Record<string, unknown> | null, null);
  }

  /** The next run the adapter is handed stays in progress until released, then ends on `sessionId`. */
  function holdNextRun(sessionId: string) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await gate;
      return { ...finishedRunResult, sessionId };
    });
    return release;
  }

  /** The session a run was handed to continue, or null when it started a fresh one. */
  function sessionHandedTo(runId: string) {
    const call = mockAdapterExecute.mock.calls.find(([input]) => input.runId === runId);
    if (!call) throw new Error(`Run ${runId} never reached the adapter`);
    return call[0].runtime.sessionId;
  }

  async function runStatus(runId: string) {
    return db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]?.status ?? null);
  }

  async function waitForRunStatus(runId: string, status: string, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let current = await runStatus(runId);
    while (current !== status && Date.now() < deadline) {
      await settle(50);
      current = await runStatus(runId);
    }
    return current;
  }

  /** Wakes the agent and waits for the run, which ends on `endsOn`, to finish. */
  async function finishedRun(endsOn: string, wake: () => Promise<{ id: string } | null>) {
    mockAdapterExecute.mockImplementationOnce(async () => ({ ...finishedRunResult, sessionId: endsOn }));
    const run = await wake();
    expect(run).not.toBeNull();
    expect(await waitForRunStatus(run!.id, "succeeded")).toBe("succeeded");
    return run!;
  }

  /** The session the run was handed, for a run like `finishedRun`'s. */
  async function sessionOfRun(endsOn: string, wake: () => Promise<{ id: string } | null>) {
    return sessionHandedTo((await finishedRun(endsOn, wake)).id);
  }

  /** The session the agent saved last, whichever run saved it. */
  function lastSavedSessionId(agentId: string) {
    return db
      .select({ sessionId: agentRuntimeState.sessionId })
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .then((rows) => rows[0]?.sessionId ?? null);
  }

  it("does not hand a run with no task the session a task's run is using", async () => {
    const { agentId } = await createAgent(2);
    expect(await sessionOfRun("books-session", () => sendSessionMessage(agentId, "reconcile the books"))).toBeNull();
    expect(await lastSavedSessionId(agentId)).toBe("books-session");

    // The task's next run is going, on the task's session, when Pat presses Run now.
    const releaseTaskRun = holdNextRun("books-session");
    const taskRun = await sendSessionMessage(agentId, "and file the receipts");
    await vi.waitFor(() => expect(mockAdapterExecute).toHaveBeenCalledTimes(2));
    expect(sessionHandedTo(taskRun!.id)).toBe("books-session");

    expect(await sessionOfRun("manual-session", () => runNow(agentId))).toBeNull();

    releaseTaskRun();
    expect(await waitForRunStatus(taskRun!.id, "succeeded")).toBe("succeeded");
  });

  it("continues one conversation across runs of the same kind, whatever ran in between", async () => {
    const { agentId } = await createAgent();
    expect(await sessionOfRun("manual-session", () => runNow(agentId))).toBeNull();
    expect(await sessionOfRun("books-session", () => sendSessionMessage(agentId, "reconcile the books"))).toBeNull();

    expect(await sessionOfRun("manual-session", () => runNow(agentId))).toBe("manual-session");
  });

  it("keeps a conversation for each plugin that invokes the agent", async () => {
    const { agentId } = await createAgent();
    expect(await sessionOfRun("slack-session", () => pluginInvoke(agentId, "slack-tools", "Slack DM: pay the tuner"))).toBeNull();
    expect(await sessionOfRun("mail-session", () => pluginInvoke(agentId, "mail-tools", "Mail: the landlord wrote"))).toBeNull();
    expect(await sessionOfRun("manual-session", () => runNow(agentId))).toBeNull();

    expect(
      await sessionOfRun("slack-session", () => pluginInvoke(agentId, "slack-tools", "Slack DM: and the piano")),
    ).toBe("slack-session");
  });

  it("still starts fresh when asked, and the next run of the kind continues the fresh one", async () => {
    const { agentId } = await createAgent();
    expect(await sessionOfRun("manual-1", () => runNow(agentId))).toBeNull();

    expect(await sessionOfRun("manual-2", () => runNow(agentId, { forceFreshSession: true }))).toBeNull();
    expect(await sessionOfRun("manual-3", () => runNow(agentId))).toBe("manual-2");
  });

  it("still resumes the exact run asked for", async () => {
    const { agentId } = await createAgent();
    const first = await finishedRun("manual-1", () => runNow(agentId));
    expect(await sessionOfRun("manual-2", () => runNow(agentId))).toBe("manual-1");

    expect(await sessionOfRun("manual-3", () => resume(agentId, first))).toBe("manual-1");
  });

  it("resumes a plugin's run in that plugin's conversation, and saves the result there", async () => {
    const { agentId } = await createAgent();
    const first = await finishedRun("slack-1", () => pluginInvoke(agentId, "slack-tools", "Slack DM: pay the tuner"));
    expect(await sessionOfRun("slack-2", () => pluginInvoke(agentId, "slack-tools", "Slack DM: and the piano"))).toBe(
      "slack-1",
    );

    expect(await sessionOfRun("slack-3", () => resume(agentId, first))).toBe("slack-1");
    // What the resumed run did is now where the plugin's next message picks up,
    // and runs started by hand never see it.
    expect(await sessionOfRun("slack-4", () => pluginInvoke(agentId, "slack-tools", "Slack DM: done?"))).toBe("slack-3");
    expect(await sessionOfRun("manual-1", () => runNow(agentId))).toBeNull();
  });

  it("retries a plugin's run in that plugin's conversation", async () => {
    const { agentId } = await createAgent();
    const slackRun = await finishedRun("slack-session", () =>
      pluginInvoke(agentId, "slack-tools", "Slack DM: pay the tuner"),
    );
    expect(await sessionOfRun("manual-session", () => runNow(agentId))).toBeNull();

    expect(await sessionOfRun("slack-session-2", () => retry(agentId, slackRun))).toBe("slack-session");
    expect(await sessionOfRun("manual-session-2", () => runNow(agentId))).toBe("manual-session");
  });

  it("keeps an automatic retry in the conversation of the run it repeats", async () => {
    const { agentId } = await createAgent();
    mockAdapterExecute.mockImplementationOnce(async () => ({
      ...finishedRunResult,
      exitCode: 1,
      errorMessage: "Slack did not answer",
      sessionId: "slack-session",
    }));
    const slackRun = await pluginInvoke(agentId, "slack-tools", "Slack DM: pay the tuner");
    expect(await waitForRunStatus(slackRun!.id, "failed")).toBe("failed");
    // Another run saves the agent's last session before the retry is due.
    await finishedRun("manual-session", () => runNow(agentId));

    const heartbeat = heartbeatService(db);
    const scheduled = await heartbeat.scheduleBoundedRetry(slackRun!.id, { now: new Date(), random: () => 0.5 });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(await conversationOf(scheduled.run.id)).toBe("__plugin__:slack-tools");
    mockAdapterExecute.mockImplementationOnce(async () => ({ ...finishedRunResult, sessionId: "slack-session-2" }));
    await heartbeat.promoteDueScheduledRetries(scheduled.dueAt);
    await heartbeat.resumeQueuedRuns();

    expect(await waitForRunStatus(scheduled.run.id, "succeeded")).toBe("succeeded");
    expect(sessionHandedTo(scheduled.run.id)).toBe("slack-session");
  });

  it("wakes the agent about an approval in the conversation of the run that drafted it", async () => {
    const { companyId, agentId } = await createAgent();
    const draftRun = await finishedRun("slack-session", () =>
      pluginInvoke(agentId, "slack-tools", "Slack DM: tell the landlord the rent is paid"),
    );
    expect(await sessionOfRun("manual-session", () => runNow(agentId))).toBeNull();

    const approvalId = await insertDraftApproval({ companyId, agentId }, draftRun.id);
    const decisionRun = await approve(approvalId, "slack-session-2");
    expect(sessionHandedTo(decisionRun.id)).toBe("slack-session");

    // Retrying the decision's run stays in that conversation too.
    expect(await sessionOfRun("slack-session-3", () => retry(agentId, decisionRun))).toBe("slack-session-2");
  });

  it("wakes the agent about an approval in the drafting task's conversation, as one of that task's runs", async () => {
    const { companyId, agentId } = await createAgent();
    const draftRun = await finishedRun("books-session", () => sendSessionMessage(agentId, "reconcile the books"));
    expect(await sessionOfRun("manual-session", () => runNow(agentId))).toBeNull();

    const decisionRun = await approve(await insertDraftApproval({ companyId, agentId }, draftRun.id), "books-session-2");
    expect(sessionHandedTo(decisionRun.id)).toBe("books-session");
    // A task key of its own, so it takes turns with that task's other runs.
    expect((decisionRun.contextSnapshot as Record<string, unknown>).taskKey).toBe(BOOKS_TASK_KEY);
  });

  it("wakes the agent about an approval from an unknown run in a conversation for approvals", async () => {
    const { companyId, agentId } = await createAgent();
    expect(await sessionOfRun("manual-session", () => runNow(agentId))).toBeNull();

    const first = await approve(await insertDraftApproval({ companyId, agentId }, null), "approval-session");
    expect(sessionHandedTo(first.id)).toBeNull();
    const second = await approve(await insertDraftApproval({ companyId, agentId }, randomUUID()), "approval-session-2");
    expect(sessionHandedTo(second.id)).toBe("approval-session");
  });

  it("keeps waiting wakes of different kinds apart instead of merging them", async () => {
    const { companyId, agentId } = await createAgent(1, { enabled: true, intervalSec: 3600 });
    // A task's run holds the agent's only slot, so every wake below waits.
    await insertRunningRun({ companyId, agentId }, { taskKey: BOOKS_TASK_KEY, wakeSource: "automation" });

    const slack = await pluginInvoke(agentId, "slack-tools", "Slack DM: pay the tuner");
    const mail = await pluginInvoke(agentId, "mail-tools", "Mail: the landlord wrote");
    const manual = await runNow(agentId);
    const tick = await heartbeatService(db).wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_scheduler",
      contextSnapshot: { source: "scheduler", reason: "interval_elapsed" },
    });
    const waiting = [slack, mail, manual, tick].map((run) => run!.id);
    expect(new Set(waiting).size).toBe(4);
    expect(await Promise.all(waiting.map(conversationOf))).toEqual([
      "__plugin__:slack-tools",
      "__plugin__:mail-tools",
      "__on_demand__",
      "__heartbeat__",
    ]);

    // A second message for the same conversation still joins the one waiting.
    const slackAgain = await pluginInvoke(agentId, "slack-tools", "Slack DM: and the piano");
    expect(slackAgain!.id).toBe(slack!.id);
    expect(readWakePrompts(slackAgain!.contextSnapshot as Record<string, unknown>)).toEqual([
      "Slack DM: pay the tuner",
      "Slack DM: and the piano",
    ]);
  });

  it("does not fold a different kind of wake into a run with no task that is already going", async () => {
    const { companyId, agentId } = await createAgent(1, { enabled: true, intervalSec: 3600 });
    const slackRunId = await insertRunningRun({ companyId, agentId }, {
      ...buildInvokeWakeContext({
        prompt: "Slack DM: pay the tuner",
        reason: null,
        pluginId: "plugin-slack-tools",
        pluginKey: "slack-tools",
      }),
      wakeSource: "automation",
    });

    const tick = await heartbeatService(db).wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_scheduler",
      contextSnapshot: { source: "scheduler", reason: "interval_elapsed" },
    });

    expect(tick!.id).not.toBe(slackRunId);
    // Folded in, the tick would have turned the plugin's run into a scheduled
    // one, and a retry of it would then continue the scheduled conversation.
    expect(await conversationOf(slackRunId)).toBe("__plugin__:slack-tools");
  });
});
