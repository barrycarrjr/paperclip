import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentRuntimeState, agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  heartbeatService,
  readWakePrompts,
  resolveTaskSessionReset,
  WAKE_PROMPT_CONTEXT_KEY,
} from "../services/heartbeat.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

type AdapterInput = { context: Record<string, unknown>; runtime: { sessionId: string | null } };

// A run that does start finishes at once, without spawning anything.
const { finishedRunResult, mockAdapterExecute } = vi.hoisted(() => {
  const finishedRunResult = {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Wake message test run.",
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

describe("resolveTaskSessionReset", () => {
  it("starts fresh on every wake when the agent is set to", () => {
    for (const context of [{ wakeSource: "timer" }, { wakeReason: "agent_invoked" }, {}]) {
      expect(resolveTaskSessionReset(context, { freshSessionEveryRun: true })).toEqual({
        reset: true,
        reason: "the agent is set to start a fresh session every run",
      });
    }
  });

  it("leaves the wake to decide otherwise", () => {
    expect(resolveTaskSessionReset({ wakeSource: "timer" }, { freshSessionEveryRun: false })).toEqual({
      reset: false,
      reason: null,
    });
    expect(resolveTaskSessionReset({ wakeReason: "issue_assigned" }, { freshSessionEveryRun: false })).toEqual({
      reset: true,
      reason: "wake reason is issue_assigned",
    });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * A message handed to an agent (a plugin's `agents.invoke`, an agent session
 * message) must reach a run that will read it. A run that has started has
 * already built its prompt, so merging a message into it loses the message.
 */
describeEmbeddedPostgres("wake messages and runs already in progress", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  // Runs that start write their workspace and run logs under the Paperclip
  // home, so they get a throwaway one instead of the real ~/.paperclip.
  let paperclipHome: string | null = null;
  const previousPaperclipHome = process.env.PAPERCLIP_HOME;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-wake-messages-");
    db = createDb(tempDb.connectionString);
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-wake-messages-home-"));
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

  // One run at a time by default, so a queued follow-up waits instead of starting.
  async function createAgent(maxConcurrentRuns = 1, status: "running" | "idle" = "idle") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "EA",
      role: "general",
      status,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { maxConcurrentRuns } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function insertRun(
    ids: { companyId: string; agentId: string },
    status: "running" | "queued",
    contextSnapshot: Record<string, unknown>,
  ) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      ...ids,
      invocationSource: "automation",
      triggerDetail: "system",
      status,
      contextSnapshot,
    });
    return runId;
  }

  async function createAgentWithRun(
    runStatus: "running" | "queued",
    runContext: Record<string, unknown>,
    maxConcurrentRuns = 1,
  ) {
    const ids = await createAgent(maxConcurrentRuns, runStatus === "running" ? "running" : "idle");
    const runId = await insertRun(ids, runStatus, runContext);
    return { ...ids, runId };
  }

  function invoke(agentId: string, prompt: string, context: Record<string, unknown> = {}) {
    return heartbeatService(db).wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "agent_invoked",
      payload: { prompt },
      requestedByActorType: "system",
      requestedByActorId: "plugin-slack",
      contextSnapshot: { ...context, [WAKE_PROMPT_CONTEXT_KEY]: prompt, wakeReason: "agent_invoked" },
    });
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

  async function runStatus(runId: string) {
    return db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]?.status ?? null);
  }

  /** The session a run with no task of its own would resume next. */
  function runtimeSessionId(agentId: string) {
    return db
      .select({ sessionId: agentRuntimeState.sessionId })
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .then((rows) => rows[0]?.sessionId ?? null);
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

  it("gives a message that arrives during a run a run of its own", async () => {
    const { agentId, runId } = await createAgentWithRun("running", { wakeReason: "agent_invoked" });

    const followup = await invoke(agentId, "and pay the tuner");

    expect(followup).not.toBeNull();
    expect(followup!.id).not.toBe(runId);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)).orderBy(asc(heartbeatRuns.createdAt));
    expect(runs).toHaveLength(2);
    // The running run was left alone.
    expect(readWakePrompts(runs.find((run) => run.id === runId)!.contextSnapshot as Record<string, unknown>)).toEqual([]);
    expect(readWakePrompts(runs.find((run) => run.id === followup!.id)!.contextSnapshot as Record<string, unknown>)).toEqual([
      "and pay the tuner",
    ]);
  });

  it("adds a message to a run still waiting to start, keeping the one already there", async () => {
    const { agentId, runId } = await createAgentWithRun("queued", {
      [WAKE_PROMPT_CONTEXT_KEY]: "chase the invoices",
      wakeReason: "agent_invoked",
    });

    const merged = await invoke(agentId, "and pay the tuner");

    expect(merged?.id).toBe(runId);
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]!);
    expect(readWakePrompts(run.contextSnapshot as Record<string, unknown>)).toEqual([
      "chase the invoices",
      "and pay the tuner",
    ]);
  });

  // Two runs of one task would resume the same saved session at once.
  it("holds the follow-up while its task's run is going, but not another task's run", async () => {
    const { agentId } = await createAgentWithRun("running", { wakeReason: "agent_invoked" }, 2);

    const followup = await invoke(agentId, "and pay the tuner");

    // A slot is free, but the run in progress is the same task's.
    expect(await runStatus(followup!.id)).toBe("queued");

    const otherTask = await invoke(agentId, "file the receipts", {
      taskKey: "plugin:slack-tools:session:other",
    });

    expect(otherTask!.id).not.toBe(followup!.id);
    expect(await waitForRunStatus(otherTask!.id, "succeeded")).toBe("succeeded");
    // The end of that run starts the queue again; the follow-up must still wait.
    await settle(500);
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    expect(await runStatus(followup!.id)).toBe("queued");
  });

  it("starts the follow-up when its task's run finishes, on the session that run saved", async () => {
    const { agentId } = await createAgent(2);
    const releaseFirst = holdNextRun("session-a");
    const first = await invoke(agentId, "chase the invoices");
    await vi.waitFor(() => expect(mockAdapterExecute).toHaveBeenCalledTimes(1));

    const followup = await invoke(agentId, "and pay the tuner");
    expect(await runStatus(followup!.id)).toBe("queued");

    releaseFirst();

    expect(await waitForRunStatus(first!.id, "succeeded")).toBe("succeeded");
    expect(await waitForRunStatus(followup!.id, "succeeded")).toBe("succeeded");
    expect(mockAdapterExecute).toHaveBeenCalledTimes(2);
    const followupInput = mockAdapterExecute.mock.calls[1]![0];
    expect(followupInput.runtime.sessionId).toBe("session-a");
    expect(followupInput.context.paperclipTaskMarkdown).toEqual(expect.stringContaining("and pay the tuner"));
  });

  // A plugin sends its next message the moment it hears a run is done, and
  // that message's run has to continue the conversation.
  it("saves a run's session before reporting it finished", async () => {
    const { companyId, agentId } = await createAgent(2);
    mockAdapterExecute.mockImplementationOnce(async () => ({ ...finishedRunResult, sessionId: "session-a" }));
    let sessionWhenReportedDone: Promise<string | null> | null = null;
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      if (event.type !== "heartbeat.run.status" || payload.status !== "succeeded" || sessionWhenReportedDone) return;
      sessionWhenReportedDone = runtimeSessionId(agentId);
    });
    try {
      const first = await invoke(agentId, "chase the invoices");
      expect(await waitForRunStatus(first!.id, "succeeded")).toBe("succeeded");
      await vi.waitFor(() => expect(sessionWhenReportedDone).not.toBeNull());
      expect(await sessionWhenReportedDone).toBe("session-a");
    } finally {
      unsubscribe();
    }
  });

  // As with an issue's deferred wakes: whoever cancels has decided the next
  // run should not wait, and a remote run can take minutes to wind down.
  it("starts the follow-up as soon as its task's run is cancelled", async () => {
    const { agentId } = await createAgent(2);
    const releaseFirst = holdNextRun("session-a");
    const first = await invoke(agentId, "chase the invoices");
    await vi.waitFor(() => expect(mockAdapterExecute).toHaveBeenCalledTimes(1));
    const followup = await invoke(agentId, "and pay the tuner");
    expect(await runStatus(followup!.id)).toBe("queued");

    await heartbeatService(db).cancelRun(first!.id);

    expect(await waitForRunStatus(followup!.id, "succeeded")).toBe("succeeded");
    expect(mockAdapterExecute).toHaveBeenCalledTimes(2);
    // Let the cancelled run wind down before the next test.
    releaseFirst();
    await vi.waitFor(async () => expect(await runtimeSessionId(agentId)).toBe("session-a"));
    expect(await runStatus(first!.id)).toBe("cancelled");
  });

  it("does not stall the queue when a run is cancelled as it is about to start", async () => {
    const { companyId, agentId, runId } = await createAgentWithRun("running", { wakeReason: "agent_invoked" });
    const queuedRunId = await insertRun({ companyId, agentId }, "queued", {
      wakeReason: "agent_invoked",
      taskKey: "plugin:slack-tools:session:other",
    });
    // A paused company refuses the queued run when the queue next starts it.
    await db.update(companies).set({ status: "paused" }).where(eq(companies.id, companyId));

    const startedAt = Date.now();
    await heartbeatService(db).cancelRun(runId);

    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(await runStatus(queuedRunId)).toBe("cancelled");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  }, 60_000);
});
