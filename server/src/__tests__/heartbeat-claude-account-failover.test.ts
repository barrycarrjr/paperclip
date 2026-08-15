import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  listClaudeAccounts,
  readClaudeAccountState,
  resetClaudeAccountCaches,
  upsertClaudeAccount,
} from "../services/claude-accounts.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Claude account failover tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/** The reset the CLI reported when Barry's weekly window actually ran out. */
const AUG_17_RESET = "2026-08-17T07:00:00.000Z";

describeEmbeddedPostgres("Claude account failover", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let homeDir!: string;
  const priorHome = process.env.PAPERCLIP_HOME;
  const priorMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-claude-account-failover-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  beforeEach(() => {
    // Accounts and their encryption key live under PAPERCLIP_HOME, so a temp
    // home keeps this test away from the real instance's account list.
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-accounts-"));
    process.env.PAPERCLIP_HOME = homeDir;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
    resetClaudeAccountCaches();
  });

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(environmentLeases);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
    resetClaudeAccountCaches();
    if (priorHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = priorHome;
    if (priorMasterKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY = priorMasterKey;
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFailedRun(input: {
    runId: string;
    companyId: string;
    agentId: string;
    errorCode: string;
    errorFamily: string;
    ranOnSlot?: string | null;
    adapterConfig?: Record<string, unknown>;
    now: Date;
  }) {
    await db.insert(companies).values({
      id: input.companyId,
      name: "Paperclip",
      issuePrefix: `T${input.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: input.agentId,
      companyId: input.companyId,
      name: "ClaudeCoder",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: input.adapterConfig ?? {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: input.runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: "failed",
      error: "Claude run failed: You've hit your weekly limit",
      errorCode: input.errorCode,
      finishedAt: input.now,
      resultJson: {
        errorFamily: input.errorFamily,
        retryNotBefore: AUG_17_RESET,
        claudePlanResetsAt: AUG_17_RESET,
        claudeRateLimitWindow: "seven_day",
      },
      contextSnapshot: {
        issueId: randomUUID(),
        wakeReason: "issue_assigned",
        ...(input.ranOnSlot ? { claudeAccountSlot: input.ranOnSlot } : {}),
      },
      updatedAt: input.now,
      createdAt: input.now,
    });
  }

  async function retryRunFor(sourceRunId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, sourceRunId))
      .then((rows) => rows[0] ?? null);
  }

  it("switches to the standby account and retries straight away", async () => {
    await upsertClaudeAccount({ token: "sk-ant-oat01-one", label: "barrycarrjr" });
    await upsertClaudeAccount({ token: "sk-ant-oat01-two", label: "printinginabox" });

    const runId = randomUUID();
    const now = new Date("2026-08-15T15:00:00.000Z");
    await seedFailedRun({
      runId,
      companyId: randomUUID(),
      agentId: randomUUID(),
      errorCode: "claude_plan_exhausted",
      errorFamily: "plan_exhausted",
      ranOnSlot: "1",
      now,
    });

    await heartbeat.handleClaudeAccountFailover(runId);

    const retry = await retryRunFor(runId);
    expect(retry?.status).toBe("scheduled_retry");
    expect(retry?.scheduledRetryReason).toBe("claude_account_failover");
    // Due immediately: the work is moving to an account with room, not waiting
    // for a spent one to recover.
    expect(retry!.scheduledRetryAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);

    const state = await readClaudeAccountState();
    expect(state.activeSlot).toBe("2");
    expect(state.exhaustedUntil["1"]).toBe(Date.parse(AUG_17_RESET));
    expect(listClaudeAccounts().find((account) => account.slot === "2")?.active).toBe(true);
  });

  it("parks the work until the reset when there is nowhere left to go", async () => {
    await upsertClaudeAccount({ token: "sk-ant-oat01-only", label: "barrycarrjr" });

    const runId = randomUUID();
    const now = new Date("2026-08-15T15:00:00.000Z");
    await seedFailedRun({
      runId,
      companyId: randomUUID(),
      agentId: randomUUID(),
      errorCode: "claude_plan_exhausted",
      errorFamily: "plan_exhausted",
      ranOnSlot: "1",
      now,
    });

    await heartbeat.handleClaudeAccountFailover(runId);

    const retry = await retryRunFor(runId);
    expect(retry?.scheduledRetryReason).toBe("claude_plan_exhausted");
    // The whole point of reading the structured reset: the run wakes when the
    // window actually reopens, not two minutes from now.
    expect(retry?.scheduledRetryAt?.toISOString()).toBe(AUG_17_RESET);

    const state = await readClaudeAccountState();
    expect(state.activeSlot).toBe("1");
  });

  it("never re-routes an agent that carries its own token", async () => {
    await upsertClaudeAccount({ token: "sk-ant-oat01-one", label: "barrycarrjr" });
    await upsertClaudeAccount({ token: "sk-ant-oat01-two", label: "printinginabox" });

    const runId = randomUUID();
    const now = new Date("2026-08-15T15:00:00.000Z");
    await seedFailedRun({
      runId,
      companyId: randomUUID(),
      agentId: randomUUID(),
      errorCode: "claude_plan_exhausted",
      errorFamily: "plan_exhausted",
      // No slot recorded, because injection is skipped for a pinned agent.
      ranOnSlot: null,
      adapterConfig: {
        env: { CLAUDE_CODE_OAUTH_TOKEN: { type: "secret_ref", secretId: randomUUID(), version: "latest" } },
      },
      now,
    });

    await heartbeat.handleClaudeAccountFailover(runId);

    const retry = await retryRunFor(runId);
    expect(retry?.scheduledRetryReason).toBe("claude_plan_exhausted");
    expect((await readClaudeAccountState()).activeSlot).toBe("1");
  });

  it("leaves a transient failure on the plain backoff ladder", async () => {
    await upsertClaudeAccount({ token: "sk-ant-oat01-one", label: "barrycarrjr" });
    await upsertClaudeAccount({ token: "sk-ant-oat01-two", label: "printinginabox" });

    const runId = randomUUID();
    const now = new Date("2026-08-15T15:00:00.000Z");
    await seedFailedRun({
      runId,
      companyId: randomUUID(),
      agentId: randomUUID(),
      errorCode: "claude_transient_upstream",
      errorFamily: "transient_upstream",
      ranOnSlot: "1",
      now,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, { now, random: () => 0.5 });
    expect(scheduled.outcome).toBe("scheduled");
    const retry = await retryRunFor(runId);
    expect(retry?.scheduledRetryReason).toBe("transient_failure");
    // Account state is untouched: a busy provider is not a spent subscription.
    expect((await readClaudeAccountState()).activeSlot).toBe("1");
  });

  it("keeps tokens out of the account list handed to the UI", async () => {
    await upsertClaudeAccount({ token: "sk-ant-oat01-secret-value", label: "barrycarrjr" });
    expect(JSON.stringify(listClaudeAccounts())).not.toContain("sk-ant");
    // And out of the file on disk, which holds ciphertext only.
    const onDisk = fs.readFileSync(path.join(homeDir, "claude-accounts.json"), "utf-8");
    expect(onDisk).not.toContain("sk-ant");
  });
});
