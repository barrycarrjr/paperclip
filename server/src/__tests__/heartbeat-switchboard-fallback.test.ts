import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import type { SwitchboardAnswer } from "../services/switchboard.ts";

/**
 * The error the four runs of 2026-09-18 ended with, word for word.
 */
const INCIDENT_ERROR =
  "Claude run failed: subtype=success: Failed to authenticate: OAuth session expired and could not be refreshed";

/**
 * A Claude adapter whose sign-in has expired: it declares the same account
 * variable and Switchboard tool the real claude_local does, so the heartbeat
 * asks for an account exactly as it would in production, and every run fails
 * the way the incident's runs did.
 */
const adapterExecute = vi.hoisted(() =>
  vi.fn(async (_input: { context: Record<string, unknown>; config: Record<string, unknown> }) => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage:
      "Claude run failed: subtype=success: Failed to authenticate: OAuth session expired and could not be refreshed",
    errorCode: "claude_auth_required",
    provider: "anthropic",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      type: "claude_local",
      execute: adapterExecute,
      supportsLocalAgentJwt: false,
      accountCredentialEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
      switchboardProvider: "claude",
    })),
  };
});

/**
 * What Switchboard says, set per test. Nothing on the machine is consulted.
 * Forgetting an account is stubbed so a test can see what a failed run asked
 * to be forgotten.
 */
const switchboard = vi.hoisted(() => ({ next: null as SwitchboardAnswer | null }));

vi.mock("../services/switchboard.ts", async () => {
  const actual = await vi.importActual<typeof import("../services/switchboard.ts")>("../services/switchboard.ts");
  return {
    ...actual,
    switchboardAnswerFor: vi.fn(async () => switchboard.next ?? { account: null, noAnswer: null }),
    forgetSwitchboardAccount: vi.fn(() => true),
  };
});

/**
 * Where the run executes. Local unless a test says otherwise; a remote run is
 * faked by swapping only the execution target the orchestrator hands back,
 * because the adapter here is a stub and nothing actually connects anywhere.
 */
const target = vi.hoisted(() => ({ remote: false }));

vi.mock("../services/environment-run-orchestrator.ts", async () => {
  const actual = await vi.importActual<typeof import("../services/environment-run-orchestrator.ts")>(
    "../services/environment-run-orchestrator.ts",
  );
  return {
    ...actual,
    environmentRunOrchestrator: (...args: Parameters<typeof actual.environmentRunOrchestrator>) => {
      const real = actual.environmentRunOrchestrator(...args);
      return {
        ...real,
        realizeForRun: async (input: Parameters<typeof real.realizeForRun>[0]) => {
          const result = await real.realizeForRun(input);
          return target.remote
            ? { ...result, executionTarget: { kind: "remote" as const, transport: "sandbox" as const, remoteCwd: "/remote/work" } }
            : result;
        },
      };
    },
  };
});

import { heartbeatService } from "../services/heartbeat.js";
import { resetAdapterAccountCaches } from "../services/adapter-accounts.js";
import { forgetSwitchboardAccount } from "../services/switchboard.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat Switchboard fallback tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const lane = {
  accountId: "claude-account-2",
  label: "work-account",
  home: "C:\\Users\\me\\.claude-account-2",
  envVar: "CLAUDE_CONFIG_DIR",
  envValue: "C:\\Users\\me\\.claude-account-2",
  laneId: "lane-2",
  reason: "Subscription has capacity",
  token: null,
};

/**
 * The run record, end to end: a run that lands on the machine's own sign-in
 * because Switchboard named nothing says so on its context, and when that
 * sign-in is what fails, its error says so in plain words. On 2026-09-18 the
 * record said neither, and the agent sat in error for ten days.
 */
describeEmbeddedPostgres("heartbeat when switchboard names no account", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let homeDir!: string;
  const priorHome = process.env.PAPERCLIP_HOME;
  const priorMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-switchboard-fallback-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  beforeEach(() => {
    // An empty account list of Paperclip's own, as on the incident machine,
    // so the heartbeat goes on to ask Switchboard.
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-heartbeat-switchboard-"));
    process.env.PAPERCLIP_HOME = homeDir;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = Buffer.alloc(32, 14).toString("base64");
    resetAdapterAccountCaches();
    adapterExecute.mockClear();
    vi.mocked(forgetSwitchboardAccount).mockClear();
    switchboard.next = null;
    target.remote = false;
  });

  afterEach(() => {
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

  async function seedAgent(adapterConfig: Record<string, unknown> = {}): Promise<string> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Personal",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Operations Agent",
      role: "general",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig,
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function runToFailure(agentId: string, contextSnapshot: Record<string, unknown> = {}) {
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot,
    });
    expect(run).not.toBeNull();
    let finished: Awaited<ReturnType<typeof heartbeat.getRun>> | null = null;
    await vi.waitFor(
      async () => {
        finished = await heartbeat.getRun(run!.id);
        expect(finished?.status).toBe("failed");
      },
      { timeout: 15_000, interval: 100 },
    );
    // The agent's own status is the last thing a run settles; waiting for it
    // keeps the database from closing under the tail of the run.
    await vi.waitFor(
      async () => {
        const [agent] = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, agentId));
        expect(agent?.status).toBe("error");
      },
      { timeout: 15_000, interval: 100 },
    );
    return finished!;
  }

  it("records the fall back on the run and explains the sign-in failure in plain words", async () => {
    switchboard.next = {
      account: null,
      noAnswer: { reason: "Quota state is unknown or unreadable", usedInstead: "machine_sign_in" },
    };
    const agentId = await seedAgent();
    const run = await runToFailure(agentId);

    const context = run.contextSnapshot as Record<string, unknown>;
    expect(context.switchboardFallback).toEqual({
      provider: "claude",
      reason: "Quota state is unknown or unreadable",
    });
    expect(context).not.toHaveProperty("switchboardAccount");
    expect(run.errorCode).toBe("claude_auth_required");
    expect(run.error).toBe(
      "Switchboard had no Claude account available when this run started, so the run used this computer's own " +
        "Claude sign-in, which has expired or been signed out. Why Switchboard had no account: Quota state is " +
        `unknown or unreadable. Original error: ${INCIDENT_ERROR}`,
    );

    // The adapter saw the same record, and no account folder was forced on it.
    const call = adapterExecute.mock.calls[0]![0];
    expect(call.context.switchboardFallback).toEqual(context.switchboardFallback);
    expect((call.config.env as Record<string, unknown> | undefined)?.CLAUDE_CONFIG_DIR).toBeUndefined();
  }, 60_000);

  /**
   * A retry starts from a copy of the context of the run it retries. A stale
   * fall back left in it would explain this run's failure as something that
   * did not happen to it, and a stale account name would claim an account
   * the run never used.
   */
  it("does not carry an earlier run's fall back or account into a run that got an account", async () => {
    switchboard.next = { account: lane, noAnswer: null };
    const agentId = await seedAgent();
    const run = await runToFailure(agentId, {
      switchboardFallback: { provider: "claude", reason: "from the run this one retries" },
      switchboardAccount: "an account from the earlier run",
    });

    const context = run.contextSnapshot as Record<string, unknown>;
    expect(context).not.toHaveProperty("switchboardFallback");
    expect(context.switchboardAccount).toBe("work-account");
    expect(run.error).toBe(INCIDENT_ERROR);
    // Switchboard vouched for this account and it could not sign in, so it is
    // not reused if Switchboard then goes quiet.
    expect(forgetSwitchboardAccount).toHaveBeenCalledWith("claude", "claude-account-2");
  }, 60_000);

  it("leaves the error alone when switchboard was never asked", async () => {
    switchboard.next = { account: null, noAnswer: null };
    const agentId = await seedAgent();
    const run = await runToFailure(agentId);

    const context = run.contextSnapshot as Record<string, unknown>;
    expect(context).not.toHaveProperty("switchboardFallback");
    expect(run.error).toBe(INCIDENT_ERROR);
    expect(forgetSwitchboardAccount).not.toHaveBeenCalled();
  }, 60_000);

  /**
   * The review's scenario: Switchboard stopped naming its Claude lanes because
   * their accounts are signed out, and the run was put on the one it named
   * last. Before, this looked exactly like the 2026-09-18 runs: the adapter's
   * bare words, nothing on the record, and the same dead folder for a day.
   */
  it("records a reused account, explains its sign-in failure, and stops reusing it", async () => {
    switchboard.next = {
      account: lane,
      noAnswer: { reason: "No lane is currently available.", usedInstead: "recent_account", agedMs: 3 * 60 * 60_000 },
    };
    const agentId = await seedAgent();
    const run = await runToFailure(agentId);

    const context = run.contextSnapshot as Record<string, unknown>;
    expect(context.switchboardReplay).toEqual({
      provider: "claude",
      account: "work-account",
      reason: "No lane is currently available.",
      agedMinutes: 180,
    });
    expect(context.switchboardAccount).toBe("work-account");
    expect(context).not.toHaveProperty("switchboardFallback");
    expect(run.error).toBe(
      'Switchboard had no Claude account available when this run started, so the run reused "work-account", ' +
        "the account Switchboard had named most recently (about 3 hours earlier), and that account could not sign in. " +
        "Paperclip will not reuse it again unless Switchboard names it. Why Switchboard had no account: No lane is " +
        `currently available. Original error: ${INCIDENT_ERROR}`,
    );
    expect(forgetSwitchboardAccount).toHaveBeenCalledWith("claude", "claude-account-2");
    // The reused folder really was handed to the run, in folder mode.
    const call = adapterExecute.mock.calls[0]![0];
    const env = call.config.env as Record<string, unknown>;
    expect(env.CLAUDE_CONFIG_DIR).toBe(lane.envValue);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("");
  }, 60_000);

  /**
   * An agent whose own env carries a key signs in with that key, not with the
   * machine's inherited sign-in, so its failure stays the adapter's own words.
   * This is the env the heartbeat builds for the run (agent config with any
   * project and issue overrides), read before Switchboard's answer is added.
   */
  it("records and explains nothing when the agent's own env carries a key", async () => {
    switchboard.next = {
      account: null,
      noAnswer: { reason: "Quota state is unknown or unreadable", usedInstead: "machine_sign_in" },
    };
    const agentId = await seedAgent({ env: { ANTHROPIC_API_KEY: { type: "plain", value: "sk-ant-api-own" } } });
    const run = await runToFailure(agentId);

    const context = run.contextSnapshot as Record<string, unknown>;
    expect(context).not.toHaveProperty("switchboardFallback");
    expect(run.error).toBe(INCIDENT_ERROR);
  }, 60_000);

  it("neither records a reuse nor forgets the account when the agent's own env carries a key", async () => {
    switchboard.next = {
      account: lane,
      noAnswer: { reason: "No lane is currently available.", usedInstead: "recent_account", agedMs: 60_000 },
    };
    const agentId = await seedAgent({ env: { ANTHROPIC_API_KEY: { type: "plain", value: "sk-ant-api-own" } } });
    const run = await runToFailure(agentId);

    const context = run.contextSnapshot as Record<string, unknown>;
    expect(context).not.toHaveProperty("switchboardReplay");
    expect(run.error).toBe(INCIDENT_ERROR);
    expect(forgetSwitchboardAccount).not.toHaveBeenCalled();
  }, 60_000);

  /**
   * A remote run signs in on the remote host. Saying it used "this computer's
   * own sign-in", or blaming an account on this computer, would send the
   * operator to the wrong machine.
   */
  it("records, explains and forgets nothing for a run on a remote target", async () => {
    target.remote = true;
    switchboard.next = {
      account: null,
      noAnswer: { reason: "Quota state is unknown or unreadable", usedInstead: "machine_sign_in" },
    };
    const agentId = await seedAgent();
    const run = await runToFailure(agentId);

    expect(run.contextSnapshot as Record<string, unknown>).not.toHaveProperty("switchboardFallback");
    expect(run.error).toBe(INCIDENT_ERROR);
    const call = adapterExecute.mock.calls[0]![0];
    expect(call.context).not.toHaveProperty("switchboardFallback");
  }, 60_000);

  it("does not blame or forget a reused account for a remote run's sign-in failure", async () => {
    target.remote = true;
    switchboard.next = {
      account: lane,
      noAnswer: { reason: "No lane is currently available.", usedInstead: "recent_account", agedMs: 60_000 },
    };
    const agentId = await seedAgent();
    const run = await runToFailure(agentId);

    expect(run.contextSnapshot as Record<string, unknown>).not.toHaveProperty("switchboardReplay");
    expect(run.error).toBe(INCIDENT_ERROR);
    expect(forgetSwitchboardAccount).not.toHaveBeenCalled();
  }, 60_000);
});
