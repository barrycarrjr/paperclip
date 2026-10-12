import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueLabels,
  issues,
  labels,
} from "@paperclipai/db";
import type { AgentModelSelection } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

type AdapterInput = {
  runId: string;
  agent: { id: string; companyId: string };
  config: Record<string, unknown>;
  context: Record<string, unknown>;
};

const hooks = vi.hoisted(() => ({
  afterInvoke: null as null | ((input: AdapterInput) => Promise<void>),
}));

const adapterExecute = vi.hoisted(() =>
  vi.fn(async (input: AdapterInput) => {
    await hooks.afterInvoke?.(input);
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Done.",
      provider: "test",
      model: String(input.config.model ?? ""),
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres model selection tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SELECTION: AgentModelSelection = {
  enabled: true,
  allowedModels: ["light-model", "strong-model"],
  rules: [
    { priorities: ["critical"], model: "strong-model" },
    { labels: ["legal"], model: "strong-model" },
  ],
};

/**
 * Automatic model selection: a run on a task starts with the model the agent's
 * rules pick from the task's labels and priority, a model set on the task wins
 * over the rules, and the run record says which model was used and why.
 */
describeEmbeddedPostgres("automatic model selection for a run", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-model-selection-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    // A finished run on a task is expected to leave a comment there.
    hooks.afterInvoke = async (input) => {
      const issueId = typeof input.context.issueId === "string" ? input.context.issueId : null;
      if (!issueId) return;
      await db.insert(issueComments).values({
        companyId: input.agent.companyId,
        issueId,
        authorAgentId: input.agent.id,
        createdByRunId: input.runId,
        body: "Done.",
      });
    };
  }, 120_000);

  beforeEach(() => {
    adapterExecute.mockClear();
  });

  afterAll(async () => {
    hooks.afterInvoke = null;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  });

  async function seedAgent(modelSelection: AgentModelSelection | null) {
    const [company] = await db.insert(companies).values({
      name: "Model Co",
      issuePrefix: `M${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id,
      name: "Writer",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "light-model" },
      runtimeConfig: modelSelection ? { modelSelection } : {},
      permissions: {},
    }).returning();
    return { companyId: company!.id, prefix: company!.issuePrefix, agentId: agent!.id };
  }

  let issueCounter = 0;
  async function seedIssue(
    owner: Awaited<ReturnType<typeof seedAgent>>,
    input: { priority?: string; labelNames?: string[]; overrideModel?: string } = {},
  ) {
    issueCounter += 1;
    const [issue] = await db.insert(issues).values({
      companyId: owner.companyId,
      identifier: `${owner.prefix}-${issueCounter}`,
      title: "Draft the agreement",
      status: "todo",
      priority: input.priority ?? "medium",
      assigneeAgentId: owner.agentId,
      assigneeAdapterOverrides: input.overrideModel ? { adapterConfig: { model: input.overrideModel } } : null,
    }).returning();
    for (const name of input.labelNames ?? []) {
      const [label] = await db.insert(labels).values({ companyId: owner.companyId, name, color: "#64748b" }).returning();
      await db.insert(issueLabels).values({ companyId: owner.companyId, issueId: issue!.id, labelId: label!.id });
    }
    return issue!.id;
  }

  /** Runs the agent on the task (or on nothing) and returns the settled run record and the model the adapter got. */
  async function runOn(agentId: string, issueId: string | null) {
    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: issueId ? { issueId } : {},
    });
    expect(queued).not.toBeNull();
    await vi.waitFor(
      async () => {
        const [row] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id));
        expect(row?.status).toBe("succeeded");
        const [agent] = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, agentId));
        expect(agent?.status).not.toBe("running");
      },
      { timeout: 20_000, interval: 100 },
    );
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id));
    const call = adapterExecute.mock.calls.map(([input]) => input).find((input) => input.runId === queued!.id);
    return { run: run!, adapterModel: call?.config.model };
  }

  it("records the agent's own model when selection is off", async () => {
    const owner = await seedAgent(null);
    const { run, adapterModel } = await runOn(owner.agentId, await seedIssue(owner, { labelNames: ["legal"] }));
    expect(adapterModel).toBe("light-model");
    expect(run).toMatchObject({ model: "light-model", modelSource: "agent-default", modelReason: "Agent's configured model" });
  });

  it("starts the run on the model a matching rule picks", async () => {
    const owner = await seedAgent(SELECTION);
    const { run, adapterModel } = await runOn(owner.agentId, await seedIssue(owner, { labelNames: ["Legal"] }));
    expect(adapterModel).toBe("strong-model");
    expect(run).toMatchObject({
      model: "strong-model",
      modelSource: "rule",
      modelReason: "label `legal` matched rule 2",
    });
  });

  it("falls back when no rule matches", async () => {
    const owner = await seedAgent({ ...SELECTION, fallbackModel: "light-model" });
    const { run, adapterModel } = await runOn(owner.agentId, await seedIssue(owner, { priority: "low" }));
    expect(adapterModel).toBe("light-model");
    expect(run).toMatchObject({ model: "light-model", modelSource: "fallback", modelReason: "No rule matched; fallback model" });
  });

  it("lets a model set on the task win over the rules", async () => {
    const owner = await seedAgent(SELECTION);
    const issueId = await seedIssue(owner, { priority: "critical", overrideModel: "hand-picked-model" });
    const { run, adapterModel } = await runOn(owner.agentId, issueId);
    expect(adapterModel).toBe("hand-picked-model");
    expect(run).toMatchObject({ model: "hand-picked-model", modelSource: "manual", modelReason: "Model set on this task" });
  });

  it("uses the agent's own model for a run with no task", async () => {
    const owner = await seedAgent(SELECTION);
    const { run, adapterModel } = await runOn(owner.agentId, null);
    expect(adapterModel).toBe("light-model");
    expect(run).toMatchObject({ model: "light-model", modelSource: "agent-default" });
  });
});
