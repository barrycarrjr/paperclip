import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  routineRevisions,
  routineRuns,
  routines,
} from "@paperclipai/db";
import type { EnvBinding } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

type AdapterInput = {
  runId: string;
  agent: { id: string; companyId: string };
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  runtime: { sessionId: string | null };
  onMeta?: (meta: { adapterType: string; command: string; env?: Record<string, string> }) => Promise<void>;
};

/** Set once the database is up: lets a run on a task leave the comment a finished run is expected to. */
const hooks = vi.hoisted(() => ({
  afterInvoke: null as null | ((input: AdapterInput) => Promise<void>),
}));

/**
 * Every run reports its invocation the way a real adapter does, with the env
 * it was handed, so the heartbeat masks it before storing it. Each run ends
 * on a session of its own, which the task's next run resumes unless it starts
 * fresh.
 */
const adapterExecute = vi.hoisted(() =>
  vi.fn(async (input: AdapterInput) => {
    await input.onMeta?.({
      adapterType: "codex_local",
      command: "agent",
      env: { ...((input.config.env as Record<string, string> | undefined) ?? {}) },
    });
    await hooks.afterInvoke?.(input);
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Released the build.",
      provider: "test",
      model: "test-model",
      sessionId: `session-${input.runId}`,
    };
  }),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      type: "codex_local",
      execute: adapterExecute,
      supportsLocalAgentJwt: false,
    })),
  };
});

/** The env each run hands to its runtime services (dev servers and the like), by run. */
const runtimeServiceEnvs = vi.hoisted(() => new Map<string, Record<string, string>>());

vi.mock("../services/workspace-runtime.ts", async () => {
  const actual = await vi.importActual<typeof import("../services/workspace-runtime.ts")>(
    "../services/workspace-runtime.ts",
  );
  return {
    ...actual,
    ensureRuntimeServicesForRun: async (input: Parameters<typeof actual.ensureRuntimeServicesForRun>[0]) => {
      runtimeServiceEnvs.set(input.runId, { ...input.adapterEnv });
      return actual.ensureRuntimeServicesForRun(input);
    },
  };
});

import { heartbeatService } from "../services/heartbeat.js";
import { pipelineService, type PipelineActor } from "../services/pipelines.js";
import { routineService } from "../services/routines.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stage env tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * A pipeline stage's saved env (Pipeline Settings, "Stage secrets") reaches the
 * stage's own agent when the stage's automation runs, as upstream passes a
 * routine's env: on the task the automation created, fixed when it ran, never
 * over the agent's own sign-in or a PAPERCLIP_ name, and with its secrets
 * masked. Nobody else who comes to run on that task gets any of it.
 */
describeEmbeddedPostgres("a pipeline stage's env in its automation's runs", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let pipelines!: ReturnType<typeof pipelineService>;
  const previousMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  const actor: PipelineActor = { type: "user", userId: "board-user" };

  beforeAll(async () => {
    // The local provider encrypts with this when a secret is saved and
    // decrypts with it when a run starts; without it a key file would be
    // written under the working directory.
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = randomBytes(32).toString("hex");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-stage-env-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    pipelines = pipelineService(db, { heartbeat });
    hooks.afterInvoke = async (input) => {
      const issueId = typeof input.context.issueId === "string" ? input.context.issueId : null;
      if (!issueId) return;
      await db.insert(issueComments).values({
        companyId: input.agent.companyId,
        issueId,
        authorAgentId: input.agent.id,
        createdByRunId: input.runId,
        body: "Released the build.",
      });
    };
  }, 120_000);

  beforeEach(() => {
    adapterExecute.mockClear();
    runtimeServiceEnvs.clear();
  });

  afterAll(async () => {
    hooks.afterInvoke = null;
    // Let the last run finish its after-run bookkeeping first.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
    if (previousMasterKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY = previousMasterKey;
  });

  async function seedAgent(companyId: string, name: string, env: Record<string, unknown> = {}) {
    const [agent] = await db.insert(agents).values({
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { env },
      runtimeConfig: {},
      permissions: {},
    }).returning();
    return agent!.id;
  }

  /** A company with a pipeline whose "In progress" stage runs an automation assigned to one agent. */
  async function seedStage(agentEnv: Record<string, unknown> = {}) {
    const [company] = await db.insert(companies).values({
      name: "Release Co",
      issuePrefix: `R${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "board-user",
    }).returning();
    const companyId = company!.id;
    const agentId = await seedAgent(companyId, "Release Agent", agentEnv);
    const pipeline = await pipelines.createPipeline({
      companyId,
      key: `releases-${randomUUID().slice(0, 8)}`,
      name: "Releases",
      enforceTransitions: false,
      actor,
    });
    const stage = (await pipelines.listStages(companyId, pipeline.id)).find((row) => row.key === "in_progress")!;
    await pipelines.updateStage({
      companyId,
      pipelineId: pipeline.id,
      stageId: stage.id,
      patch: {
        config: {
          automation: {
            assigneeAgentId: agentId,
            instructionsBody: "Release {{case_title}}.",
          },
        },
      },
      actor,
    });
    return { companyId, agentId, pipelineId: pipeline.id, stageId: stage.id };
  }

  type Stage = Awaited<ReturnType<typeof seedStage>>;

  async function seedSecret(companyId: string, value: string) {
    return secretService(db).create(companyId, { name: `deploy-token-${randomUUID().slice(0, 8)}`, provider: "local_encrypted", value });
  }

  async function saveStageEnv(stage: Stage, env: Record<string, EnvBinding> | null) {
    return pipelines.updateStageAutomationEnv({
      companyId: stage.companyId,
      pipelineId: stage.pipelineId,
      stageId: stage.stageId,
      env,
      actor,
    });
  }

  /**
   * Writes an env straight into the stage's routine and the revision its next
   * run is pinned to, as one saved before the save refused names would be.
   */
  async function plantStageEnv(routineId: string, env: Record<string, EnvBinding>) {
    const [routine] = await db.select().from(routines).where(eq(routines.id, routineId));
    const [revision] = await db
      .select()
      .from(routineRevisions)
      .where(eq(routineRevisions.id, routine!.latestRevisionId!));
    await db.update(routines).set({ env }).where(eq(routines.id, routineId));
    await db
      .update(routineRevisions)
      .set({ snapshot: { ...revision!.snapshot, routine: { ...revision!.snapshot.routine, env } } })
      .where(eq(routineRevisions.id, revision!.id));
  }

  /** Moves a new case into the stage, which runs its automation, and returns the task the automation created. */
  async function enterStage(stage: Stage, caseKey: string) {
    const created = await pipelines.ingestCase({
      companyId: stage.companyId,
      pipelineId: stage.pipelineId,
      caseKey,
      title: `Release ${caseKey}`,
      actor,
    });
    const moved = await pipelines.transitionCase({
      companyId: stage.companyId,
      caseId: created.case.id,
      toStageKey: "in_progress",
      expectedVersion: created.case.version,
      actor,
    });
    expect(moved.automationExecution.status).toBe("succeeded");
    const issueId = moved.automationExecution.status === "succeeded"
      ? moved.automationExecution.execution.executionIssueId
      : null;
    expect(issueId).toBeTruthy();
    return issueId!;
  }

  /** A run's stored record, once it has ended in `status` and its agent's after-run bookkeeping is done. */
  async function settledRun(runId: string, status: "succeeded" | "failed") {
    await vi.waitFor(
      async () => {
        const [row] = await db
          .select({ status: heartbeatRuns.status, agentId: heartbeatRuns.agentId })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, runId));
        expect(row?.status).toBe(status);
        const [agent] = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, row!.agentId));
        expect(agent?.status).not.toBe("running");
      },
      { timeout: 20_000, interval: 100 },
    );
    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    return row!;
  }

  /** What the adapter was handed for a run, once the run has succeeded and settled. */
  async function finishedRun(runId: string) {
    await settledRun(runId, "succeeded");
    const input = adapterExecute.mock.calls.map(([call]) => call).find((call) => call.runId === runId);
    expect(input).toBeDefined();
    return input!;
  }

  /** The run the routine started on the task it created. */
  async function automationRun(issueId: string) {
    await vi.waitFor(
      () => expect(adapterExecute.mock.calls.some(([call]) => call.context.issueId === issueId)).toBe(true),
      { timeout: 20_000, interval: 100 },
    );
    const call = adapterExecute.mock.calls.map(([input]) => input).find((input) => input.context.issueId === issueId)!;
    return finishedRun(call.runId);
  }

  /** Wakes an agent on a task (or on nothing) the way a person asking it to look again does. */
  async function wakeOn(agentId: string, issueId: string | null) {
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: issueId ? { issueId } : {},
    });
    expect(run).not.toBeNull();
    return run!.id;
  }

  async function commentOn(issueId: string, author: { userId?: string; agentId?: string }, body: string) {
    const [issue] = await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, issueId));
    const [comment] = await db.insert(issueComments).values({
      companyId: issue!.companyId,
      issueId,
      authorUserId: author.userId ?? null,
      authorAgentId: author.agentId ?? null,
      body,
    }).returning();
    return comment!.id;
  }

  /** Wakes an agent on someone else's task the way mentioning it in a comment there does. */
  async function mentionOn(agentId: string, issueId: string) {
    const commentId = await commentOn(issueId, { userId: "board-user" }, "Could you check this release too?");
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_comment_mentioned",
      payload: { issueId, commentId },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        commentId,
        wakeCommentId: commentId,
        wakeReason: "issue_comment_mentioned",
        source: "comment.mention",
      },
    });
    expect(run).not.toBeNull();
    return finishedRun(run!.id);
  }

  /**
   * An agent waking itself on a task through POST /agents/:id/wakeup, passing
   * the task and a comment on it so the run goes ahead though the task is not
   * assigned to it.
   */
  async function selfWakeOn(agentId: string, issueId: string) {
    const commentId = await commentOn(issueId, { agentId }, "Picking this up.");
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_commented",
      payload: { issueId, commentId },
      requestedByActorType: "agent",
      requestedByActorId: agentId,
      contextSnapshot: { triggeredBy: "agent", actorId: agentId, forceFreshSession: false },
    });
    expect(run).not.toBeNull();
    return finishedRun(run!.id);
  }

  function runEnv(input: AdapterInput) {
    return (input.config.env ?? {}) as Record<string, string>;
  }

  it("hands the stage's own agent its plain and secret values, masks the secret, and keeps them from runtime services", async () => {
    const stage = await seedStage({
      SHARED_KEY: { type: "plain", value: "agent" },
      AGENT_ONLY: { type: "plain", value: "agent-only" },
    });
    const secretValue = `deploy-${randomUUID()}`;
    const secret = await seedSecret(stage.companyId, secretValue);
    await saveStageEnv(stage, {
      DEPLOY_TOKEN: { type: "secret_ref", secretId: secret.id },
      REGION: "eu-west-1",
      SHARED_KEY: "stage",
    });

    const issueId = await enterStage(stage, "v1");
    const run = await automationRun(issueId);

    expect(run.agent.id).toBe(stage.agentId);
    expect(runEnv(run)).toMatchObject({
      DEPLOY_TOKEN: secretValue,
      REGION: "eu-west-1",
      SHARED_KEY: "stage",
      AGENT_ONLY: "agent-only",
    });

    // The invocation is stored with the secret masked and the plain value as is.
    const events = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, run.runId));
    const invoke = events.find((event) => event.eventType === "adapter.invoke");
    expect((invoke?.payload as { env?: Record<string, string> } | undefined)?.env).toMatchObject({
      DEPLOY_TOKEN: "***REDACTED***",
      REGION: "eu-west-1",
    });
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.runId));
    expect(JSON.stringify([events, stored])).not.toContain(secretValue);

    // A runtime service started for the run can outlive it and serve other
    // tasks, so it gets the run's env without the stage's.
    expect(runtimeServiceEnvs.get(run.runId)).toEqual({ SHARED_KEY: "agent", AGENT_ONLY: "agent-only" });
  }, 90_000);

  it("drops the names a stage may not set from an env saved before they were refused", async () => {
    const stage = await seedStage({
      ANTHROPIC_API_KEY: { type: "plain", value: "agent-own-key" },
    });
    const secret = await seedSecret(stage.companyId, `stage-${randomUUID()}`);
    const saved = await saveStageEnv(stage, { REGION: "eu-west-1" });
    const dropped = {
      ANTHROPIC_API_KEY: "stage-key",
      ANTHROPIC_BASE_URL: "https://elsewhere.example",
      OPENAI_API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
      CLAUDE_CODE_OAUTH_TOKEN: "stage-token",
      CODEX_HOME: "/stage/codex",
      HTTPS_PROXY: "http://proxy.example",
      NODE_OPTIONS: "--require /stage/hook.js",
      PATH: "/stage/bin",
      PAPERCLIP_API_KEY: "stage-paperclip-key",
      paperclip_task_id: "stage-task",
    } satisfies Record<string, EnvBinding>;
    await plantStageEnv(saved.routineId, { REGION: "eu-west-1", ...dropped });

    const issueId = await enterStage(stage, "v1");
    const env = runEnv(await automationRun(issueId));

    expect(env.REGION).toBe("eu-west-1");
    expect(env.ANTHROPIC_API_KEY).toBe("agent-own-key");
    for (const name of Object.keys(dropped).filter((key) => key !== "ANTHROPIC_API_KEY")) {
      expect(env).not.toHaveProperty(name);
    }
  }, 90_000);

  it("keeps a task on the env its automation ran with, while a new task gets the stage's current env", async () => {
    const stage = await seedStage();
    const first = await saveStageEnv(stage, { REGION: "eu-west-1" });

    const firstIssueId = await enterStage(stage, "v1");
    const firstRun = await automationRun(firstIssueId);
    expect(runEnv(firstRun).REGION).toBe("eu-west-1");

    await saveStageEnv(stage, { REGION: "us-east-1" });

    // The same task, woken again: still the env it started with, in the same session.
    const again = await finishedRun(await wakeOn(stage.agentId, firstIssueId));
    expect(runEnv(again).REGION).toBe("eu-west-1");
    expect(again.runtime.sessionId).toBe(`session-${firstRun.runId}`);

    const secondIssueId = await enterStage(stage, "v2");
    expect(runEnv(await automationRun(secondIssueId)).REGION).toBe("us-east-1");

    // Because the routine's run recorded the revision current when it ran.
    const [firstIssue] = await db.select().from(issues).where(eq(issues.id, firstIssueId));
    const [routineRun] = await db.select().from(routineRuns).where(eq(routineRuns.id, firstIssue!.originRunId!));
    expect(routineRun!.routineRevisionId).toBe(first.latestRoutineRevisionId);
  }, 90_000);

  it("gives nothing to an agent mentioned on the stage's task, while the stage's own agent still gets it", async () => {
    const stage = await seedStage();
    await saveStageEnv(stage, { REGION: "eu-west-1" });
    const issueId = await enterStage(stage, "v1");
    expect(runEnv(await automationRun(issueId)).REGION).toBe("eu-west-1");

    const reviewerId = await seedAgent(stage.companyId, "Reviewer");
    expect(runEnv(await mentionOn(reviewerId, issueId))).not.toHaveProperty("REGION");

    expect(runEnv(await finishedRun(await wakeOn(stage.agentId, issueId))).REGION).toBe("eu-west-1");
  }, 90_000);

  it("gives nothing to another agent that wakes itself on the stage's task", async () => {
    const stage = await seedStage();
    await saveStageEnv(stage, { REGION: "eu-west-1" });
    const issueId = await enterStage(stage, "v1");
    await automationRun(issueId);

    const otherId = await seedAgent(stage.companyId, "Other Agent");
    const run = await selfWakeOn(otherId, issueId);
    expect(run.agent.id).toBe(otherId);
    expect(runEnv(run)).not.toHaveProperty("REGION");
  }, 90_000);

  it("gives nothing once the stage's task is reassigned to another agent", async () => {
    const stage = await seedStage();
    await saveStageEnv(stage, { REGION: "eu-west-1" });
    const issueId = await enterStage(stage, "v1");
    await automationRun(issueId);

    const otherId = await seedAgent(stage.companyId, "Other Agent");
    await db.update(issues).set({ assigneeAgentId: otherId }).where(eq(issues.id, issueId));
    const run = await finishedRun(await wakeOn(otherId, issueId));
    expect(run.agent.id).toBe(otherId);
    expect(runEnv(run)).not.toHaveProperty("REGION");
  }, 90_000);

  it("gives nothing to a run of the stage's routine that names another assignee", async () => {
    const stage = await seedStage();
    const saved = await saveStageEnv(stage, { REGION: "eu-west-1" });
    const otherId = await seedAgent(stage.companyId, "Other Agent");

    const routineRun = await routineService(db, { heartbeat }).runRoutine(saved.routineId, {
      source: "manual",
      assigneeAgentId: otherId,
      variables: { pipeline_name: "Releases", stage_name: "In progress", case_title: "Hotfix" },
    });
    expect(routineRun.linkedIssueId).toBeTruthy();
    const run = await automationRun(routineRun.linkedIssueId!);
    expect(run.agent.id).toBe(otherId);
    expect(runEnv(run)).not.toHaveProperty("REGION");
  }, 90_000);

  it("gives nothing to the stage's agent on another task or on none", async () => {
    const stage = await seedStage();
    await saveStageEnv(stage, { REGION: "eu-west-1" });
    const [otherIssue] = await db.insert(issues).values({
      companyId: stage.companyId,
      title: "Unrelated task",
      status: "todo",
      priority: "medium",
      assigneeAgentId: stage.agentId,
    }).returning();

    expect(runEnv(await finishedRun(await wakeOn(stage.agentId, otherIssue!.id)))).not.toHaveProperty("REGION");
    expect(runEnv(await finishedRun(await wakeOn(stage.agentId, null)))).not.toHaveProperty("REGION");
  }, 90_000);

  it("fails a run whose stage secret was deleted, naming the variable and the stage", async () => {
    const stage = await seedStage();
    const secret = await seedSecret(stage.companyId, `deploy-${randomUUID()}`);
    await saveStageEnv(stage, { DEPLOY_TOKEN: { type: "secret_ref", secretId: secret.id } });
    const issueId = await enterStage(stage, "v1");
    await automationRun(issueId);

    await secretService(db).remove(secret.id);

    const failed = await settledRun(await wakeOn(stage.agentId, issueId), "failed");
    expect(failed.error).toBe(
      'This run could not start: the secret behind DEPLOY_TOKEN, set by stage "In progress" in pipeline "Releases", ' +
        "no longer exists. Tasks already started keep the stage's settings from when they started.",
    );
  }, 90_000);

  /**
   * A task recorded before the env was fixed at dispatch reads the stage's
   * current env, which can change under it. As upstream, the next run then
   * starts a fresh session instead of carrying on the old one.
   */
  it("starts a fresh session when the env of a task recorded without a revision changes", async () => {
    const stage = await seedStage();
    await saveStageEnv(stage, { REGION: "eu-west-1" });
    const issueId = await enterStage(stage, "v1");
    const firstRun = await automationRun(issueId);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    await db
      .update(routineRuns)
      .set({ routineRevisionId: null })
      .where(and(eq(routineRuns.id, issue!.originRunId!), eq(routineRuns.companyId, stage.companyId)));

    // Unchanged: the session carries on.
    const unchanged = await finishedRun(await wakeOn(stage.agentId, issueId));
    expect(runEnv(unchanged).REGION).toBe("eu-west-1");
    expect(unchanged.runtime.sessionId).toBe(`session-${firstRun.runId}`);

    await saveStageEnv(stage, { REGION: "us-east-1" });

    const changed = await finishedRun(await wakeOn(stage.agentId, issueId));
    expect(runEnv(changed).REGION).toBe("us-east-1");
    expect(changed.runtime.sessionId).toBeNull();
  }, 90_000);
});
