import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, agentRuntimeState, companies, costEvents, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

type Input = { runId: string; agent: { id: string; companyId: string }; config: Record<string, unknown>; context: Record<string, unknown>; runtime: { sessionId?: string | null } };
const hooks = vi.hoisted(() => ({ result: {} as AdapterExecutionResult, afterInvoke: null as null | ((input: Input) => Promise<void>) }));
const execute = vi.hoisted(() => vi.fn(async (input: Input) => {
  await hooks.afterInvoke?.(input);
  return { ...hooks.result, model: String(input.config.model ?? "light") };
}));
vi.mock("../adapters/index.ts", async () => ({
  ...await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts"),
  getServerAdapter: vi.fn(() => ({ type: "claude_local", execute, supportsLocalAgentJwt: false })),
}));
import { heartbeatService } from "../services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping model usage DB tests: ${support.reason}`);
const row = { inputTokens: 10, outputTokens: 4, cachedInputTokens: 20, cacheCreationInputTokens: 3, costUsd: 0.004 };
const map = { light: { ...row }, advisor: { ...row }, other: { ...row } };

describeDatabase("invocation model usage and advisor ledger attribution", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-model-usage-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    hooks.afterInvoke = async input => {
      if (typeof input.context.issueId === "string") await db.insert(issueComments).values({ companyId: input.agent.companyId,
        issueId: input.context.issueId, authorAgentId: input.agent.id, createdByRunId: input.runId, body: "Done." });
    };
  }, 120_000);
  beforeEach(() => {
    execute.mockClear();
    hooks.result = { exitCode: 0, signal: null, timedOut: false, summary: "Done.", provider: "anthropic", biller: "anthropic",
      billingType: "api", sessionId: "saved-session", sessionDisplayId: "saved-session", sessionParams: { sessionId: "saved-session" },
      costUsd: 0.012, usage: { inputTokens: 999, outputTokens: 999, cachedInputTokens: 999 }, usageScope: "invocation", modelUsage: map,
      resultJson: { reportedModelUsage: map, paperclipAdvisor: { requestedModel: "opus", consultation: "unknown" } } };
  });
  afterAll(async () => {
    hooks.afterInvoke = null;
    await new Promise(resolve => setTimeout(resolve, 300));
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  });
  async function seed() {
    const [company] = await db.insert(companies).values({ name: "Usage Co", issuePrefix: `U${randomUUID().slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Light agent", role: "engineer", status: "idle", adapterType: "claude_local",
      adapterConfig: { model: "light", advisorModel: "opus" }, runtimeConfig: { modelSelection: { enabled: true, allowedModels: ["light", "strong"], rules: [{ priorities: ["critical"], model: "strong" }] } }, permissions: {} }).returning();
    return { company: company!, agent: agent! };
  }
  async function run(owner: Awaited<ReturnType<typeof seed>>, issueId?: string, expectedEvents = 3) {
    const queued = await heartbeat.wakeup(owner.agent.id, { source: "on_demand", triggerDetail: "manual", contextSnapshot: issueId ? { issueId } : {} });
    expect(queued).not.toBeNull();
    await vi.waitFor(async () => {
      const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id));
      expect(current?.status).toBe("succeeded");
      const [agent] = await db.select().from(agents).where(eq(agents.id, owner.agent.id));
      expect(agent?.status).not.toBe("running");
      const events = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, queued!.id));
      expect(events).toHaveLength(expectedEvents);
    }, { timeout: 20_000, interval: 100 });
    const [record] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id));
    const events = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, queued!.id));
    const [state] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, owner.agent.id));
    return { record: record!, events, state: state!, input: execute.mock.calls.find(([input]) => input.runId === queued!.id)![0] };
  }
  it("attributes every model exactly and preserves aggregate rounded cents once", async () => {
    const owner = await seed();
    const result = await run(owner);
    expect(result.events.map(event => event.model).sort()).toEqual(["advisor", "light", "other"]);
    expect(result.events.reduce((sum, event) => sum + event.costCents, 0)).toBe(1);
    expect(result.events.find(event => event.model === "advisor")?.costCents).toBe(1);
    for (const event of result.events) expect(event).toMatchObject({ companyId: owner.company.id, agentId: owner.agent.id,
      inputTokens: 13, outputTokens: 4, cachedInputTokens: 20, billingType: "metered_api" });
    expect(result.state).toMatchObject({ totalInputTokens: 39, totalOutputTokens: 12, totalCachedInputTokens: 60, totalCostCents: 1 });
    expect(result.record.usageJson).toMatchObject({ modelUsage: map, usageSource: "invocation_model_totals", costAttribution: "per_model", reportedUsdType: "provider_estimate" });
    expect(result.record.resultJson).toMatchObject({ reportedModelUsage: map });
  });
  it("counts resumed process totals afresh even when the same model counters are smaller", async () => {
    const owner = await seed(); await run(owner);
    hooks.result.modelUsage = { light: { ...row, inputTokens: 1, outputTokens: 1, cachedInputTokens: 2, cacheCreationInputTokens: 0, costUsd: 0.004 } };
    hooks.result.costUsd = 0.004;
    const resumed = await run(owner, undefined, 1);
    expect(resumed.record.usageJson).toMatchObject({ inputTokens: 1, outputTokens: 1, cachedInputTokens: 2 });
    expect(resumed.state).toMatchObject({ totalInputTokens: 40, totalOutputTokens: 13, totalCachedInputTokens: 62, totalCostCents: 1 });
  });
  it("keeps subscription cents included while retaining CLI estimates and per-model tokens", async () => {
    const owner = await seed(); hooks.result.billingType = "subscription";
    const result = await run(owner);
    expect(result.events.every(event => event.billingType === "subscription_included" && event.costCents === 0)).toBe(true);
    expect(result.state.totalCostCents).toBe(0);
    expect(result.record.usageJson).toMatchObject({ costUsd: 0.012, modelUsage: map, reportedUsdType: "provider_estimate" });
  });
  it("falls back to aggregate unknown attribution for malformed advisor usage, including resume", async () => {
    const owner = await seed(); await run(owner);
    hooks.result.modelUsage = { light: { ...row, outputTokens: -1 } };
    hooks.result.usage = { inputTokens: 2, outputTokens: 3, cachedInputTokens: 4 };
    const result = await run(owner, undefined, 1);
    expect(result.events[0]).toMatchObject({ model: "unknown", inputTokens: 2, outputTokens: 3, cachedInputTokens: 4, costCents: 1 });
    expect(result.state).toMatchObject({ totalInputTokens: 41, totalOutputTokens: 15, totalCachedInputTokens: 64, totalCostCents: 2 });
    expect(result.record.usageJson).not.toHaveProperty("modelUsage");
  });
  it("preserves existing single-model adapter attribution", async () => {
    const owner = await seed(); delete hooks.result.modelUsage; delete hooks.result.usageScope; hooks.result.resultJson = {};
    const result = await run(owner, undefined, 1);
    expect(result.events[0]).toMatchObject({ model: "light", inputTokens: 999, outputTokens: 999, costCents: 1 });
  });
  it("accounts known retry subtotals while persisting that unreported consumption is unknown", async () => {
    const owner = await seed(); delete hooks.result.modelUsage;
    hooks.result.usage = { inputTokens: 26, outputTokens: 8, cachedInputTokens: 40 };
    hooks.result.costUsd = 0.008;
    hooks.result.resultJson = { paperclipAdvisor: { accounting: "unknown_advisor_consumption" },
      paperclipUsageReporting: { costComplete: false, usageComplete: false }, availableModelUsageReports: [map] };
    const result = await run(owner, undefined, 1);
    expect(result.events[0]).toMatchObject({ model: "unknown", costCents: 1, inputTokens: 26 });
    expect(result.record.usageJson).toMatchObject({ costAttribution: "aggregate_unknown", costUsd: 0.008,
      reportingCompleteness: { costComplete: false, usageComplete: false } });
    expect(result.record.resultJson).toMatchObject({ availableModelUsageReports: [map] });
  });
  it.each([undefined, "manual-primary"])("keeps routing/manual primary precedence and advice configuration (%s)", async override => {
    const owner = await seed();
    const [issue] = await db.insert(issues).values({ companyId: owner.company.id, title: "Critical task", identifier: `${owner.company.issuePrefix}-1`, status: "todo",
      priority: "critical", assigneeAgentId: owner.agent.id, assigneeAdapterOverrides: override ? { adapterConfig: { model: override } } : null }).returning();
    const result = await run(owner, issue!.id);
    expect(result.input.config).toMatchObject({ model: override ?? "strong", advisorModel: "opus" });
    expect(result.record.modelSource).toBe(override ? "manual" : "rule");
    expect(result.events.every(event => event.companyId === owner.company.id && event.issueId === issue!.id)).toBe(true);
  });
});
