import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  listAdapterAccounts,
  readAdapterAccountState,
  resetAdapterAccountCaches,
  upsertAdapterAccount,
} from "../services/adapter-accounts.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Adapter account failover tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * When the runs below failed, held on a fixed clock.
 *
 * The reset has to still be ahead of "now" for these to mean anything: the
 * router forgets a reset once it has passed, and a retry is only moved out to
 * the reset when that is later than the ordinary backoff. Written-in dates go
 * stale, so the clock is frozen here instead and every date is derived from it.
 */
const NOW = new Date("2026-08-15T15:00:00.000Z");

/** The reset the CLI reported when a real weekly window actually ran out. */
const PLAN_RESET = new Date(NOW.getTime() + 40 * 60 * 60 * 1_000).toISOString();

describeEmbeddedPostgres("Adapter account failover", () => {
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
    // Only the clock is faked, not setTimeout: the embedded Postgres driver
    // needs its own timers to keep running, and nothing here waits on one.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    // Accounts and their encryption key live under PAPERCLIP_HOME, so a temp
    // home keeps this test away from the real instance's account list.
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-accounts-"));
    process.env.PAPERCLIP_HOME = homeDir;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
    resetAdapterAccountCaches();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await db.delete(heartbeatRunEvents);
    await db.delete(environmentLeases);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
    resetAdapterAccountCaches();
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
    adapterType?: "claude_local" | "codex_local";
    now: Date;
  }) {
    const adapterType = input.adapterType ?? "claude_local";
    await db.insert(companies).values({
      id: input.companyId,
      name: "Paperclip",
      issuePrefix: `T${input.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: input.agentId,
      companyId: input.companyId,
      name: adapterType === "codex_local" ? "CodexCoder" : "ClaudeCoder",
      role: "engineer",
      status: "active",
      adapterType,
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
        retryNotBefore: PLAN_RESET,
        planResetsAt: PLAN_RESET,
        rateLimitWindow: "seven_day",
      },
      contextSnapshot: {
        issueId: randomUUID(),
        wakeReason: "issue_assigned",
        ...(input.ranOnSlot ? { adapterAccountSlot: input.ranOnSlot } : {}),
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
    await upsertAdapterAccount({ adapterType: "claude_local", token: "sk-ant-oat01-one", label: "Main" });
    await upsertAdapterAccount({ adapterType: "claude_local", token: "sk-ant-oat01-two", label: "Backup" });

    const runId = randomUUID();
    const now = new Date(NOW);
    await seedFailedRun({
      runId,
      companyId: randomUUID(),
      agentId: randomUUID(),
      errorCode: "claude_plan_exhausted",
      errorFamily: "plan_exhausted",
      ranOnSlot: "1",
      now,
    });

    await heartbeat.handleAdapterAccountFailover(runId);

    const retry = await retryRunFor(runId);
    expect(retry?.status).toBe("scheduled_retry");
    expect(retry?.scheduledRetryReason).toBe("account_failover");
    // Due immediately: the work is moving to an account with room, not waiting
    // for a spent one to recover.
    expect(retry!.scheduledRetryAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);

    const state = await readAdapterAccountState("claude_local");
    expect(state.activeSlot).toBe("2");
    expect(state.exhaustedUntil["1"]).toBe(Date.parse(PLAN_RESET));
    expect(listAdapterAccounts("claude_local").find((account) => account.slot === "2")?.active).toBe(true);
  });

  // The point of the whole rework: nothing about the store or the failover is
  // Claude-specific. A different adapter's accounts behave the same way and the
  // two lists never touch each other.
  //
  // This does NOT claim codex_local is switched on. An adapter only starts
  // using accounts once it declares accountCredentialEnvVar, and Codex has not
  // (it signs in through a CODEX_HOME directory, which would work as the
  // declared value but has not been verified to separate accounts). It stands
  // in here as "some other adapter".
  it("fails over on a different adapter, keeping each adapter's list separate", async () => {
    await upsertAdapterAccount({ adapterType: "claude_local", token: "claude-one", label: "Claude" });
    await upsertAdapterAccount({ adapterType: "codex_local", token: "codex-one", label: "Codex main" });
    await upsertAdapterAccount({ adapterType: "codex_local", token: "codex-two", label: "Codex backup" });

    const runId = randomUUID();
    const now = new Date(NOW);
    await seedFailedRun({
      runId,
      companyId: randomUUID(),
      agentId: randomUUID(),
      adapterType: "codex_local",
      errorCode: "codex_plan_exhausted",
      errorFamily: "plan_exhausted",
      ranOnSlot: "1",
      now,
    });

    await heartbeat.handleAdapterAccountFailover(runId);

    const retry = await retryRunFor(runId);
    expect(retry?.scheduledRetryReason).toBe("account_failover");
    expect((await readAdapterAccountState("codex_local")).activeSlot).toBe("2");
    // Claude's single account is untouched by Codex running out.
    const claude = await readAdapterAccountState("claude_local");
    expect(claude.activeSlot).toBe("1");
    expect(claude.exhaustedUntil).toEqual({});
  });

  it("parks the work until the reset when there is nowhere left to go", async () => {
    await upsertAdapterAccount({ adapterType: "claude_local", token: "sk-ant-oat01-only", label: "Main" });

    const runId = randomUUID();
    const now = new Date(NOW);
    await seedFailedRun({
      runId,
      companyId: randomUUID(),
      agentId: randomUUID(),
      errorCode: "claude_plan_exhausted",
      errorFamily: "plan_exhausted",
      ranOnSlot: "1",
      now,
    });

    await heartbeat.handleAdapterAccountFailover(runId);

    const retry = await retryRunFor(runId);
    expect(retry?.scheduledRetryReason).toBe("plan_exhausted");
    // The whole point of reading the structured reset: the run wakes when the
    // window actually reopens, not two minutes from now.
    expect(retry?.scheduledRetryAt?.toISOString()).toBe(PLAN_RESET);

    const state = await readAdapterAccountState("claude_local");
    expect(state.activeSlot).toBe("1");
  });

  it("never re-routes an agent that carries its own token", async () => {
    await upsertAdapterAccount({ adapterType: "claude_local", token: "sk-ant-oat01-one", label: "Main" });
    await upsertAdapterAccount({ adapterType: "claude_local", token: "sk-ant-oat01-two", label: "Backup" });

    const runId = randomUUID();
    const now = new Date(NOW);
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

    await heartbeat.handleAdapterAccountFailover(runId);

    const retry = await retryRunFor(runId);
    expect(retry?.scheduledRetryReason).toBe("plan_exhausted");
    expect((await readAdapterAccountState("claude_local")).activeSlot).toBe("1");
  });

  it("leaves a transient failure on the plain backoff ladder", async () => {
    await upsertAdapterAccount({ adapterType: "claude_local", token: "sk-ant-oat01-one", label: "Main" });
    await upsertAdapterAccount({ adapterType: "claude_local", token: "sk-ant-oat01-two", label: "Backup" });

    const runId = randomUUID();
    const now = new Date(NOW);
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
    expect((await readAdapterAccountState("claude_local")).activeSlot).toBe("1");
  });

  it("keeps tokens out of the account list handed to the UI", async () => {
    await upsertAdapterAccount({ adapterType: "claude_local", token: "sk-ant-oat01-secret-value", label: "Main" });
    expect(JSON.stringify(listAdapterAccounts("claude_local"))).not.toContain("sk-ant");
    // And out of the file on disk, which holds ciphertext only.
    const onDisk = fs.readFileSync(path.join(homeDir, "adapter-accounts.json"), "utf-8");
    expect(onDisk).not.toContain("sk-ant");
  });
});
