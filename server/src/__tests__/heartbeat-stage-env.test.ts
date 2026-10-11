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
  routineRuns,
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

import { heartbeatService } from "../services/heartbeat.js";
import { pipelineService, type PipelineActor } from "../services/pipelines.js";
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
 * agent when the stage's automation runs, as upstream passes a routine's env:
 * on the task the automation created, fixed when it ran, never over the
 * agent's own sign-in or a PAPERCLIP_ name, and with its secrets masked.
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

  /** What the adapter was handed for a run, once the run and the agent's after-run bookkeeping are done. */
  async function finishedRun(runId: string) {
    await vi.waitFor(
      async () => {
        const [row] = await db
          .select({ status: heartbeatRuns.status, agentId: heartbeatRuns.agentId })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, runId));
        expect(row?.status).toBe("succeeded");
        const [agent] = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, row!.agentId));
        expect(agent?.status).toBe("idle");
      },
      { timeout: 20_000, interval: 100 },
    );
    const input = adapterExecute.mock.calls.map(([call]) => call).find((call) => call.runId === runId);
    expect(input).toBeDefined();
    return input!;
  }

  /** The run the stage's automation started on its task. */
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
    return finishedRun(run!.id);
  }

  /** Wakes an agent on someone else's task the way mentioning it in a comment there does. */
  async function mentionOn(agentId: string, issueId: string) {
    const [issue] = await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, issueId));
    const [comment] = await db.insert(issueComments).values({
      companyId: issue!.companyId,
      issueId,
      authorUserId: "board-user",
      body: "Could you check this release too?",
    }).returning();
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_comment_mentioned",
      payload: { issueId, commentId: comment!.id },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        commentId: comment!.id,
        wakeCommentId: comment!.id,
        wakeReason: "issue_comment_mentioned",
        source: "comment.mention",
      },
    });
    expect(run).not.toBeNull();
    return finishedRun(run!.id);
  }

  function runEnv(input: AdapterInput) {
    return (input.config.env ?? {}) as Record<string, string>;
  }

  it("hands a run on the automation's task the stage's plain and secret values, masking the secret", async () => {
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
  }, 90_000);

  it("never lets the stage's env set the agent's sign-in or a PAPERCLIP_ name", async () => {
    const stage = await seedStage({
      ANTHROPIC_API_KEY: { type: "plain", value: "agent-own-key" },
    });
    const secret = await seedSecret(stage.companyId, `stage-${randomUUID()}`);
    await saveStageEnv(stage, {
      REGION: "eu-west-1",
      ANTHROPIC_API_KEY: "stage-key",
      OPENAI_API_KEY: { type: "secret_ref", secretId: secret.id },
      CLAUDE_CODE_OAUTH_TOKEN: "stage-token",
      CLAUDE_CONFIG_DIR: "/stage/claude",
      CODEX_HOME: "/stage/codex",
      PAPERCLIP_API_KEY: "stage-paperclip-key",
      PAPERCLIP_RUN_ID: "stage-run",
      paperclip_task_id: "stage-task",
    });

    const issueId = await enterStage(stage, "v1");
    const env = runEnv(await automationRun(issueId));

    expect(env.REGION).toBe("eu-west-1");
    expect(env.ANTHROPIC_API_KEY).toBe("agent-own-key");
    for (const name of [
      "OPENAI_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
      "PAPERCLIP_API_KEY",
      "PAPERCLIP_RUN_ID",
      "paperclip_task_id",
    ]) {
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
    const again = await wakeOn(stage.agentId, firstIssueId);
    expect(runEnv(again).REGION).toBe("eu-west-1");
    expect(again.runtime.sessionId).toBe(`session-${firstRun.runId}`);

    const secondIssueId = await enterStage(stage, "v2");
    expect(runEnv(await automationRun(secondIssueId)).REGION).toBe("us-east-1");

    // Because the routine's run recorded the revision current when it ran.
    const [firstIssue] = await db.select().from(issues).where(eq(issues.id, firstIssueId));
    const [routineRun] = await db.select().from(routineRuns).where(eq(routineRuns.id, firstIssue!.originRunId!));
    expect(routineRun!.routineRevisionId).toBe(first.latestRoutineRevisionId);
  }, 90_000);

  it("reaches every agent woken on the automation's task and nothing else", async () => {
    const stage = await seedStage();
    await saveStageEnv(stage, { REGION: "eu-west-1" });
    const issueId = await enterStage(stage, "v1");
    expect(runEnv(await automationRun(issueId)).REGION).toBe("eu-west-1");

    // Another agent asked to look at the same task gets it too, as upstream.
    const reviewerId = await seedAgent(stage.companyId, "Reviewer");
    expect(runEnv(await mentionOn(reviewerId, issueId)).REGION).toBe("eu-west-1");

    // The same agent on a task the automation did not create, or on no task,
    // gets nothing from the stage.
    const [otherIssue] = await db.insert(issues).values({
      companyId: stage.companyId,
      title: "Unrelated task",
      status: "todo",
      priority: "medium",
      assigneeAgentId: stage.agentId,
    }).returning();
    expect(runEnv(await wakeOn(stage.agentId, otherIssue!.id))).not.toHaveProperty("REGION");
    expect(runEnv(await wakeOn(stage.agentId, null))).not.toHaveProperty("REGION");
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
    const unchanged = await wakeOn(stage.agentId, issueId);
    expect(runEnv(unchanged).REGION).toBe("eu-west-1");
    expect(unchanged.runtime.sessionId).toBe(`session-${firstRun.runId}`);

    await saveStageEnv(stage, { REGION: "us-east-1" });

    const changed = await wakeOn(stage.agentId, issueId);
    expect(runEnv(changed).REGION).toBe("us-east-1");
    expect(changed.runtime.sessionId).toBeNull();
  }, 90_000);
});
