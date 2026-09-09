import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issueThreadInteractions,
  issues,
  plugins,
  routines,
} from "@paperclipai/db";
import { START_WORK_ORIGIN_KIND, type PluginStatus } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// The planner's two outside dependencies: which model to use, and the one
// model call. Everything else (issues, interactions, budgets, settings,
// routines, plugins) runs for real against the embedded database.
const mocks = vi.hoisted(() => ({
  completeOnce: vi.fn(),
  pickOneShotModel: vi.fn(),
}));

vi.mock("../services/llm-one-shot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/llm-one-shot.js")>();
  return { ...actual, completeOnce: mocks.completeOnce };
});

vi.mock("../services/chat-providers.js", () => ({
  pickOneShotModel: mocks.pickOneShotModel,
}));

const { startWorkService } = await import("../services/start-work.js");
const { issueService } = await import("../services/issues.js");
const { issueThreadInteractionService } = await import("../services/issue-thread-interactions.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres start work tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const UNUSABLE_PLAN_MESSAGE =
  "Could not turn that into a plan. Try saying it a different way, with the outcome you want. Nothing was created.";
const TOO_MANY_PLANS_MESSAGE =
  "You have asked for a lot of plans in a short time. Wait a few minutes and try again. Nothing was created.";

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const USER_ID = "user-1";

type PlannerTask = {
  clientKey: string;
  parentClientKey?: string | null;
  title: string;
  why: string;
  priority?: string | null;
  assigneeAgentId: string | null;
  needsPlugins?: string[];
  [extra: string]: unknown;
};

function plannerJson(tasks: PlannerTask[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    summary: "A short plan.",
    soundsRecurring: false,
    recurringNote: null,
    // priority is required by the planner schema (nullable, not optional), as the prompt instructs.
    tasks: tasks.map((task) => ({ priority: null, ...task })),
    ...extra,
  });
}

function reply(text: string) {
  return { text, modelUsed: "test-model", stopReason: "end_turn" as const };
}

describeEmbeddedPostgres("startWorkService.plan", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-start-work-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  beforeEach(() => {
    mocks.completeOnce.mockReset();
    mocks.pickOneShotModel.mockReset();
    mocks.pickOneShotModel.mockResolvedValue("test-model");
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(routines);
    await db.delete(agents);
    await db.delete(plugins);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name = "Paperclip", overrides: Record<string, unknown> = {}): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      ...overrides,
    });
    return companyId;
  }

  async function seedAgent(
    companyId: string,
    input: { name: string; role: string; status?: string; title?: string; capabilities?: string },
  ): Promise<string> {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: input.name,
      role: input.role,
      title: input.title ?? null,
      capabilities: input.capabilities ?? null,
      status: input.status ?? "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function seedPlugin(pluginKey: string, status: PluginStatus): Promise<string> {
    const id = randomUUID();
    await db.insert(plugins).values({
      id,
      pluginKey,
      packageName: `@test/${pluginKey}`,
      version: "1.0.0",
      apiVersion: 1,
      status,
      categories: ["connector"],
      manifestJson: {
        id: pluginKey,
        apiVersion: 1,
        version: "1.0.0",
        displayName: pluginKey,
        description: "Test plugin",
        author: "Paperclip",
        categories: ["connector"],
        capabilities: [],
        entrypoints: { worker: "dist/worker.js" },
      },
    });
    return id;
  }

  async function seedRoutine(companyId: string, title: string): Promise<void> {
    await db.insert(routines).values({ companyId, title });
  }

  async function issueRows(companyId: string) {
    return db.select().from(issues).where(eq(issues.companyId, companyId));
  }

  /**
   * The hard constraint of this feature: drafting a plan wakes nobody and
   * starts nothing. Both tables must be empty after any plan() call, so a
   * later change that queues a wake for a wake_assignee_on_accept card is
   * caught here rather than in production.
   */
  async function expectNothingWoken() {
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
  }

  it("refuses with 422 before any AI call when the company has no usable agent, and no issues row exists afterwards", async () => {
    const companyId = await seedCompany();
    // Paused and terminated agents are not usable; a company with only those has nobody.
    await seedAgent(companyId, { name: "Sleeping", role: "ceo", status: "paused" });
    await seedAgent(companyId, { name: "Gone", role: "engineer", status: "terminated" });

    await expect(
      startWorkService(db).plan(companyId, { text: "Sort out the invoices", requestKey: randomUUID() }, { userId: USER_ID }),
    ).rejects.toMatchObject({
      status: 422,
      message: "This company has no agent to do the work. Add an agent first, then try again.",
    });

    expect(mocks.pickOneShotModel).not.toHaveBeenCalled();
    expect(mocks.completeOnce).not.toHaveBeenCalled();
    expect(await issueRows(companyId)).toHaveLength(0);
  });

  it("refuses with 503 before any write when pickOneShotModel returns null", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, { name: "Ada", role: "ceo" });
    mocks.pickOneShotModel.mockResolvedValue(null);

    await expect(
      startWorkService(db).plan(companyId, { text: "Sort out the invoices", requestKey: randomUUID() }, { userId: USER_ID }),
    ).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("No AI model is set up yet"),
    });

    expect(mocks.completeOnce).not.toHaveBeenCalled();
    expect(await issueRows(companyId)).toHaveLength(0);
    expect(await db.select().from(issueThreadInteractions)).toHaveLength(0);
  });

  it("returns the existing container and card for a repeated requestKey without a second AI call", async () => {
    const companyId = await seedCompany();
    const ceo = await seedAgent(companyId, { name: "Ada", role: "ceo" });
    mocks.completeOnce.mockResolvedValue(reply(plannerJson([
      { clientKey: "t1", title: "Chase the invoices", why: "Cash is late.", assigneeAgentId: ceo },
    ])));
    const requestKey = randomUUID();
    const svc = startWorkService(db);

    const first = await svc.plan(companyId, { text: "Chase up unpaid invoices", requestKey }, { userId: USER_ID });
    expect(first.status).toBe("created");
    expect(first.planner.modelUsed).toBe("test-model");

    const second = await svc.plan(companyId, { text: "Chase up unpaid invoices", requestKey }, { userId: USER_ID });
    expect(second.status).toBe("existing");
    expect(second.issue.id).toBe(first.issue.id);
    expect(second.interaction.id).toBe(first.interaction.id);
    expect(second.planner.modelUsed).toBeNull();
    expect(second.lead).toEqual({ id: ceo, name: "Ada" });

    expect(mocks.completeOnce).toHaveBeenCalledTimes(1);
    expect(await issueRows(companyId)).toHaveLength(1);
    await expectNothingWoken();
  });

  it("two concurrent plan calls with the same key share one AI call and one container (inflight map)", async () => {
    const companyId = await seedCompany();
    const ceo = await seedAgent(companyId, { name: "Ada", role: "ceo" });
    mocks.completeOnce.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return reply(plannerJson([
        { clientKey: "t1", title: "Chase the invoices", why: "Cash is late.", assigneeAgentId: ceo },
      ]));
    });
    const requestKey = randomUUID();
    const input = { text: "Chase up unpaid invoices", requestKey };

    // Two service instances, as two requests in one process would have.
    const [a, b] = await Promise.all([
      startWorkService(db).plan(companyId, input, { userId: USER_ID }),
      startWorkService(db).plan(companyId, input, { userId: USER_ID }),
    ]);

    expect(mocks.completeOnce).toHaveBeenCalledTimes(1);
    expect(a.issue.id).toBe(b.issue.id);
    expect(a.interaction.id).toBe(b.interaction.id);
    expect(await issueRows(companyId)).toHaveLength(1);
    await expectNothingWoken();
  });

  it("a second container with the same requestKey violates issues_start_work_request_uq and the service returns the first", async () => {
    const companyId = await seedCompany();
    const ceo = await seedAgent(companyId, { name: "Ada", role: "ceo" });
    const requestKey = randomUUID();
    let rivalIssueId: string | null = null;

    // Simulate another server process finishing first: while this process
    // is waiting on the model, the rival writes its container and card.
    mocks.completeOnce.mockImplementation(async () => {
      const rival = await issueService(db).create(companyId, {
        title: "Request: Chase up unpaid invoices",
        description: "Chase up unpaid invoices",
        status: "backlog",
        priority: "medium",
        originKind: START_WORK_ORIGIN_KIND,
        originId: requestKey,
        createdByUserId: "other-process",
      });
      rivalIssueId = rival.id;
      await issueThreadInteractionService(db).create({ id: rival.id, companyId }, {
        kind: "suggest_tasks",
        idempotencyKey: `start-work:${requestKey}`,
        continuationPolicy: "wake_assignee_on_accept",
        payload: { version: 1, tasks: [{ clientKey: "r1", title: "Rival task", assigneeAgentId: ceo }] },
      }, { userId: "other-process" });
      return reply(plannerJson([
        { clientKey: "t1", title: "Chase the invoices", why: "Cash is late.", assigneeAgentId: ceo },
      ]));
    });

    const result = await startWorkService(db).plan(
      companyId,
      { text: "Chase up unpaid invoices", requestKey },
      { userId: USER_ID },
    );

    expect(rivalIssueId).not.toBeNull();
    expect(result.status).toBe("existing");
    expect(result.issue.id).toBe(rivalIssueId);
    expect(result.interaction.payload.tasks.map((t) => t.clientKey)).toEqual(["r1"]);
    expect(await issueRows(companyId)).toHaveLength(1);
    expect(await db.select().from(issueThreadInteractions)).toHaveLength(1);
  });

  it("creates the container through issueService.create in backlog with no assignee, originKind start_work and originId = requestKey, and an identifier is allocated", async () => {
    const companyId = await seedCompany();
    const ceo = await seedAgent(companyId, { name: "Ada", role: "ceo" });
    mocks.completeOnce.mockResolvedValue(reply(plannerJson([
      { clientKey: "t1", title: "Chase the invoices", why: "Cash is late.", assigneeAgentId: ceo },
    ])));
    const requestKey = randomUUID();
    const text = "Chase up unpaid invoices\nStart with the oldest ones.";

    const result = await startWorkService(db).plan(companyId, { text, requestKey }, { userId: USER_ID });

    const [row] = await issueRows(companyId);
    expect(row).toMatchObject({
      id: result.issue.id,
      status: "backlog",
      assigneeAgentId: null,
      assigneeUserId: null,
      originKind: "start_work",
      originId: requestKey,
      createdByUserId: USER_ID,
      title: "Request: Chase up unpaid invoices",
      priority: "medium",
    });
    expect(row.identifier).toMatch(/^T[A-Z0-9]+-\d+$/);
    expect(result.issue.identifier).toBe(row.identifier);
    expect(row.description).toContain(text);
    expect(row.description).toContain("Asked for in plain words by a board user.");

    // Header facts come from the server, not the model.
    expect(result.lead).toEqual({ id: ceo, name: "Ada" });
    expect(result.guardrails.outboundHold).toBe(true);
    expect(result.notes).toEqual({
      soundsRecurring: false,
      recurringNote: null,
      companyName: "Paperclip",
      isPortfolioRoot: false,
    });
    expect(result.leftOut).toEqual([]);
    expect(result.warnings).toEqual([]);

    const logged = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const created = logged.find((row) => row.action === "issue.thread_interaction_created");
    expect(created).toMatchObject({
      actorType: "user",
      actorId: USER_ID,
      entityId: result.issue.id,
    });
    expect(created?.details).toMatchObject({ source: "start_work", modelUsed: "test-model", taskCount: 1, leftOutCount: 0 });

    // The use of the model is recorded against the company before the call,
    // so heavy use is visible even when every draft afterwards fails.
    const requested = logged.find((row) => row.action === "issue.start_work.plan_requested");
    expect(requested).toMatchObject({
      actorType: "user",
      actorId: USER_ID,
      entityType: "company",
      entityId: companyId,
    });
    expect(requested?.details).toMatchObject({ source: "start_work", requestKey, model: "test-model" });

    // And the header facts are stored with the plan so a retry repeats them.
    const planned = logged.find((row) => row.action === "issue.start_work.planned");
    expect(planned).toMatchObject({ entityType: "issue", entityId: result.issue.id });
    expect(planned?.details).toMatchObject({
      plan: { leftOut: [], soundsRecurring: false, recurringNote: null },
    });

    // Drafting wakes nobody: no wake request and no run exists yet.
    await expectNothingWoken();
  });

  it("the interaction carries idempotencyKey start-work:<key>, continuationPolicy wake_assignee_on_accept, and only clientKey, parentClientKey, title, description, priority and assigneeAgentId per task (hiddenInPreview, parentId, goalId, labels, assigneeUserId are absent)", async () => {
    const companyId = await seedCompany();
    const ceo = await seedAgent(companyId, { name: "Ada", role: "ceo" });
    // The model tries every field it should not be able to set.
    mocks.completeOnce.mockResolvedValue(reply(plannerJson([
      {
        clientKey: "t1",
        title: "Chase the invoices",
        why: "Cash is late.",
        priority: "high",
        assigneeAgentId: ceo,
        hiddenInPreview: true,
        parentId: randomUUID(),
        projectId: randomUUID(),
        goalId: randomUUID(),
        billingCode: "SECRET",
        labels: ["hidden"],
        assigneeUserId: "someone-else",
      },
      {
        clientKey: "t2",
        parentClientKey: "t1",
        title: "Send reminders",
        why: "Second nudge.",
        priority: null,
        assigneeAgentId: ceo,
      },
    ])));
    const requestKey = randomUUID();

    const result = await startWorkService(db).plan(
      companyId,
      { text: "Chase up unpaid invoices", requestKey },
      { userId: USER_ID },
    );

    const [row] = await db.select().from(issueThreadInteractions);
    expect(row).toMatchObject({
      issueId: result.issue.id,
      kind: "suggest_tasks",
      status: "pending",
      idempotencyKey: `start-work:${requestKey}`,
      continuationPolicy: "wake_assignee_on_accept",
      createdByUserId: USER_ID,
      createdByAgentId: null,
      title: "Plan for: Chase up unpaid invoices",
    });
    expect(row.summary).toBe("Drafted by test-model. 2 tasks.");

    const tasks = (row.payload as { tasks: Array<Record<string, unknown>> }).tasks;
    expect(tasks).toHaveLength(2);
    for (const task of tasks) {
      expect(Object.keys(task).sort()).toEqual(
        ["assigneeAgentId", "clientKey", "description", "parentClientKey", "priority", "title"],
      );
    }
    expect(tasks[0]).toMatchObject({ clientKey: "t1", parentClientKey: null, priority: "high", assigneeAgentId: ceo });
    expect(tasks[1]).toMatchObject({ clientKey: "t2", parentClientKey: "t1", priority: "medium" });
    // The why becomes the description, with a footer naming the request.
    expect(tasks[0].description).toBe(
      `Cash is late.\n\nFrom the request "Chase up unpaid invoices" (${result.issue.identifier}).`,
    );
  });

  it("replaces an assignee outside the roster with pickAssigneeForCompany and every task has an assignee", async () => {
    const companyId = await seedCompany();
    const ceo = await seedAgent(companyId, { name: "Ada", role: "ceo" });
    const paused = await seedAgent(companyId, { name: "Sleeping", role: "engineer", status: "paused" });
    const otherCompanyId = await seedCompany("Elsewhere");
    const foreign = await seedAgent(otherCompanyId, { name: "Stranger", role: "ceo" });
    const engineer = await seedAgent(companyId, { name: "Cy", role: "engineer" });
    mocks.completeOnce.mockResolvedValue(reply(plannerJson([
      { clientKey: "t1", title: "One", why: "w", assigneeAgentId: paused },
      { clientKey: "t2", title: "Two", why: "w", assigneeAgentId: foreign },
      { clientKey: "t3", title: "Three", why: "w", assigneeAgentId: randomUUID() },
      { clientKey: "t4", title: "Four", why: "w", assigneeAgentId: null },
      { clientKey: "t5", title: "Five", why: "w", assigneeAgentId: engineer },
    ])));

    const result = await startWorkService(db).plan(
      companyId,
      { text: "Do five things", requestKey: randomUUID() },
      { userId: USER_ID },
    );

    const assignees = result.interaction.payload.tasks.map((task) => task.assigneeAgentId);
    expect(assignees).toEqual([ceo, ceo, ceo, ceo, engineer]);
    expect(assignees.every(Boolean)).toBe(true);
  });

  it("moves a task whose needsPlugins are missing or disabled into leftOut, never into the payload, and the summary names it", async () => {
    const companyId = await seedCompany();
    const ceo = await seedAgent(companyId, { name: "Ada", role: "ceo" });
    await seedPlugin("gbp-reviews", "disabled");
    await seedPlugin("help-scout", "ready");
    mocks.completeOnce.mockResolvedValue(reply(plannerJson([
      { clientKey: "t1", title: "Answer Google reviews", why: "w", assigneeAgentId: ceo, needsPlugins: ["gbp-reviews"] },
      { clientKey: "t2", title: "Call the leads", why: "w", assigneeAgentId: ceo, needsPlugins: ["phone-tools"] },
      { clientKey: "t3", title: "Summarise support", why: "w", assigneeAgentId: ceo, needsPlugins: ["help-scout"] },
      { clientKey: "t4", parentClientKey: "t1", title: "Draft review templates", why: "w", assigneeAgentId: ceo },
    ])));

    const result = await startWorkService(db).plan(
      companyId,
      { text: "Look after the customers", requestKey: randomUUID() },
      { userId: USER_ID },
    );

    expect(result.leftOut).toEqual([
      { title: "Answer Google reviews", reason: "gbp-reviews is installed but not running (disabled)" },
      { title: "Call the leads", reason: "phone-tools is not installed" },
    ]);
    const kept = result.interaction.payload.tasks;
    expect(kept.map((task) => task.clientKey)).toEqual(["t3", "t4"]);
    // A child of a left-out task is still real work; it moves up under the request.
    expect(kept.find((task) => task.clientKey === "t4")?.parentClientKey).toBeNull();

    const [row] = await db.select().from(issueThreadInteractions);
    expect(row.summary).toBe(
      "Drafted by test-model. 2 tasks. Left out because a plugin is not ready: Answer Google reviews, Call the leads.",
    );

    // When nothing survives, nothing is written and the refusal names the plugins.
    mocks.completeOnce.mockResolvedValue(reply(plannerJson([
      { clientKey: "t1", title: "Answer Google reviews", why: "w", assigneeAgentId: ceo, needsPlugins: ["gbp-reviews"] },
    ])));
    await expect(
      startWorkService(db).plan(companyId, { text: "Answer the reviews", requestKey: randomUUID() }, { userId: USER_ID }),
    ).rejects.toMatchObject({
      status: 422,
      message: "Everything in that plan needs a plugin that is not ready: gbp-reviews. Install it on the Plugins page first.",
    });
    expect(await issueRows(companyId)).toHaveLength(1);
  });

  it("repairs malformed JSON once and refuses with 422 on the second failure with nothing created", async () => {
    const companyId = await seedCompany();
    const ceo = await seedAgent(companyId, { name: "Ada", role: "ceo" });

    // Bad twice: refused, and the repair round quoted the problem back.
    mocks.completeOnce
      .mockResolvedValueOnce(reply("Sure! Here is the plan: not json at all"))
      .mockResolvedValueOnce(reply("{\"summary\": \"still missing tasks\"}"));
    await expect(
      startWorkService(db).plan(companyId, { text: "Chase up unpaid invoices", requestKey: randomUUID() }, { userId: USER_ID }),
    ).rejects.toMatchObject({
      status: 422,
      message: "Could not turn that into a plan. Try saying it a different way, with the outcome you want. Nothing was created.",
    });
    expect(mocks.completeOnce).toHaveBeenCalledTimes(2);
    const repairContent = mocks.completeOnce.mock.calls[1][0].content as string;
    expect(repairContent).toContain("Your previous answer could not be used.");
    expect(repairContent).toContain("Sure! Here is the plan: not json at all");
    expect(repairContent).toContain("Problems:");
    expect(await issueRows(companyId)).toHaveLength(0);
    expect(await db.select().from(issueThreadInteractions)).toHaveLength(0);

    // Bad once, then good: the repair round is what makes the plan.
    mocks.completeOnce.mockReset();
    mocks.completeOnce
      .mockResolvedValueOnce(reply("```json\n{\"tasks\": []}\n```"))
      .mockResolvedValueOnce(reply("```json\n" + plannerJson([
        { clientKey: "t1", title: "Chase the invoices", why: "Cash is late.", assigneeAgentId: ceo },
      ]) + "\n```"));
    const result = await startWorkService(db).plan(
      companyId,
      { text: "Chase up unpaid invoices", requestKey: randomUUID() },
      { userId: USER_ID },
    );
    expect(result.status).toBe("created");
    expect(mocks.completeOnce).toHaveBeenCalledTimes(2);
    expect(mocks.completeOnce.mock.calls[1][0].content).toContain("tasks: Array must contain at least 1 element(s)");
  });

  it("rejects more than 12 tasks and a parentClientKey cycle at plan time", async () => {
    const companyId = await seedCompany();
    const ceo = await seedAgent(companyId, { name: "Ada", role: "ceo" });

    const thirteen = Array.from({ length: 13 }, (_, i) => ({
      clientKey: `t${i + 1}`,
      title: `Task ${i + 1}`,
      why: "w",
      assigneeAgentId: ceo,
    }));
    mocks.completeOnce.mockResolvedValue(reply(plannerJson(thirteen)));
    await expect(
      startWorkService(db).plan(companyId, { text: "Do everything", requestKey: randomUUID() }, { userId: USER_ID }),
    ).rejects.toMatchObject({ status: 422 });
    // The cap is enforced by the schema, so the model gets one chance to fold the rest into the summary.
    expect(mocks.completeOnce).toHaveBeenCalledTimes(2);
    expect(mocks.completeOnce.mock.calls[1][0].content).toContain("tasks: Array must contain at most 12 element(s)");

    // A loop gets the same one repair round the schema errors get, and a
    // second bad answer is refused in the words the operator can act on,
    // never in the task-order rule's own developer wording.
    mocks.completeOnce.mockReset();
    mocks.completeOnce.mockResolvedValue(reply(plannerJson([
      { clientKey: "a", parentClientKey: "b", title: "A", why: "w", assigneeAgentId: ceo },
      { clientKey: "b", parentClientKey: "a", title: "B", why: "w", assigneeAgentId: ceo },
    ])));
    await expect(
      startWorkService(db).plan(companyId, { text: "Do two things", requestKey: randomUUID() }, { userId: USER_ID }),
    ).rejects.toMatchObject({ status: 422, message: UNUSABLE_PLAN_MESSAGE });
    expect(mocks.completeOnce).toHaveBeenCalledTimes(2);
    expect(mocks.completeOnce.mock.calls[1][0].content).toContain("sit under each other in a loop (a, b)");

    mocks.completeOnce.mockReset();
    mocks.completeOnce.mockResolvedValue(reply(plannerJson([
      { clientKey: "a", parentClientKey: "nowhere", title: "A", why: "w", assigneeAgentId: ceo },
    ])));
    await expect(
      startWorkService(db).plan(companyId, { text: "Do one thing", requestKey: randomUUID() }, { userId: USER_ID }),
    ).rejects.toMatchObject({ status: 422, message: UNUSABLE_PLAN_MESSAGE });
    expect(mocks.completeOnce).toHaveBeenCalledTimes(2);
    expect(mocks.completeOnce.mock.calls[1][0].content).toContain(
      'tasks.a.parentClientKey: no task in this plan has clientKey "nowhere"',
    );

    expect(await issueRows(companyId)).toHaveLength(0);
  });

  it("a made up parentClientKey is repaired on the second attempt and the plan is created", async () => {
    const companyId = await seedCompany();
    const ceo = await seedAgent(companyId, { name: "Ada", role: "ceo" });
    mocks.completeOnce
      .mockResolvedValueOnce(reply(plannerJson([
        { clientKey: "t1", title: "Chase the invoices", why: "Cash is late.", assigneeAgentId: ceo },
        { clientKey: "t3", parentClientKey: "t9", title: "Send reminders", why: "Second nudge.", assigneeAgentId: ceo },
      ])))
      .mockResolvedValueOnce(reply(plannerJson([
        { clientKey: "t1", title: "Chase the invoices", why: "Cash is late.", assigneeAgentId: ceo },
        { clientKey: "t3", parentClientKey: "t1", title: "Send reminders", why: "Second nudge.", assigneeAgentId: ceo },
      ])));

    const result = await startWorkService(db).plan(
      companyId,
      { text: "Chase up unpaid invoices", requestKey: randomUUID() },
      { userId: USER_ID },
    );

    expect(result.status).toBe("created");
    expect(mocks.completeOnce).toHaveBeenCalledTimes(2);
    const repairContent = mocks.completeOnce.mock.calls[1][0].content as string;
    expect(repairContent).toContain("Your previous answer could not be used.");
    expect(repairContent).toContain('no task in this plan has clientKey "t9"');
    expect(result.interaction.payload.tasks.map((task) => task.parentClientKey)).toEqual([null, "t1"]);
  });

  it("strips em and en dashes from every title and why before storing", async () => {
    const companyId = await seedCompany();
    const ceo = await seedAgent(companyId, { name: "Ada", role: "ceo" });
    mocks.completeOnce.mockResolvedValue(reply(plannerJson([
      {
        clientKey: "t1",
        title: `Chase invoices ${EM_DASH} oldest first`,
        why: `Cash is late${EN_DASH}very late ${EM_DASH} and the bank is asking.`,
        assigneeAgentId: ceo,
      },
    ], { summary: `A plan ${EM_DASH} with a dash`, soundsRecurring: true, recurringNote: `Weekly ${EN_DASH} maybe` })));

    const result = await startWorkService(db).plan(
      companyId,
      { text: "Chase up unpaid invoices", requestKey: randomUUID() },
      { userId: USER_ID },
    );

    const [row] = await db.select().from(issueThreadInteractions);
    const stored = JSON.stringify({ payload: row.payload, summary: row.summary, title: row.title });
    expect(stored).not.toContain(EM_DASH);
    expect(stored).not.toContain(EN_DASH);
    const [task] = (row.payload as { tasks: Array<{ title: string; description: string }> }).tasks;
    expect(task.title).toBe("Chase invoices, oldest first");
    expect(task.description).toContain("Cash is late, very late, and the bank is asking.");
    expect(result.notes.recurringNote).toBe("Weekly, maybe");
    expect(result.notes.soundsRecurring).toBe(true);
  });

  it("the prompt contains only this company's agents, plugin keys and routine titles (two companies seeded)", async () => {
    const companyId = await seedCompany("Print Shop");
    const ceo = await seedAgent(companyId, { name: "Ada Printwell", role: "ceo", title: "Owner's right hand", capabilities: "invoicing, email" });
    await seedRoutine(companyId, "Monday print queue check");
    const otherCompanyId = await seedCompany("Bakery");
    await seedAgent(otherCompanyId, { name: "Bea Crumb", role: "ceo" });
    await seedRoutine(otherCompanyId, "Sunday oven check");
    await seedPlugin("help-scout", "ready");
    await seedPlugin("gbp-reviews", "disabled");
    mocks.completeOnce.mockResolvedValue(reply(plannerJson([
      { clientKey: "t1", title: "Chase the invoices", why: "Cash is late.", assigneeAgentId: ceo },
    ])));

    await startWorkService(db).plan(
      companyId,
      { text: "Chase up unpaid invoices", requestKey: randomUUID() },
      { userId: USER_ID },
    );

    expect(mocks.completeOnce).toHaveBeenCalledTimes(1);
    const call = mocks.completeOnce.mock.calls[0][0];
    expect(call.model).toBe("test-model");
    expect(call.callerLabel).toBe("start-work-planner");
    expect(call.boardUserId).toBe(USER_ID);
    const prompt = `${call.system}\n${call.content}`;

    expect(prompt).toContain("Print Shop");
    expect(prompt).toContain("Ada Printwell");
    expect(prompt).toContain(ceo);
    expect(prompt).toContain("Owner's right hand");
    expect(prompt).toContain("invoicing, email");
    expect(prompt).toContain("Monday print queue check");
    expect(prompt).toContain("Chase up unpaid invoices");

    expect(prompt).not.toContain("Bakery");
    expect(prompt).not.toContain("Bea Crumb");
    expect(prompt).not.toContain("Sunday oven check");

    // Only ready plugins are offered as keys the model may use.
    expect(call.content).toContain('["help-scout"]');
    expect(call.content).not.toContain('"gbp-reviews"]');
    // The no-dash rule is stated, and the prompt itself obeys it.
    expect(call.system).toContain("Never use an em dash or an en dash");
    expect(prompt).not.toContain(EM_DASH);
    expect(prompt).not.toContain(EN_DASH);
  });

  it("warnings carry the budget block reason for a blocked assignee", async () => {
    // A company paused for budget blocks every agent in it from starting;
    // the plan still drafts, and the header says the task will wait.
    const companyId = await seedCompany("Paperclip", { status: "paused", pauseReason: "budget" });
    const ceo = await seedAgent(companyId, { name: "Ada", role: "ceo" });
    mocks.completeOnce.mockResolvedValue(reply(plannerJson([
      { clientKey: "t1", title: "One", why: "w", assigneeAgentId: ceo },
      { clientKey: "t2", title: "Two", why: "w", assigneeAgentId: ceo },
    ])));

    const result = await startWorkService(db).plan(
      companyId,
      { text: "Do two things", requestKey: randomUUID() },
      { userId: USER_ID },
    );

    // One warning per distinct assignee, not per task.
    expect(result.warnings).toEqual([
      {
        agentId: ceo,
        agentName: "Ada",
        reason: "Company is paused because its budget hard-stop was reached.",
      },
    ]);
  });

  it("an agent waiting for approval is never in the roster, never the lead, and never proposed as an assignee", async () => {
    // Accepting a plan assigned to a pending approval agent is refused with
    // a 409 at accept time, so a plan that names one could never be
    // accepted. It must not be offered in the first place.
    const companyId = await seedCompany();
    const pendingCeo = await seedAgent(companyId, { name: "Not Approved Yet", role: "ceo", status: "pending_approval" });
    const engineer = await seedAgent(companyId, { name: "Cy", role: "engineer" });
    mocks.completeOnce.mockResolvedValue(reply(plannerJson([
      // The model names the pending CEO anyway; the server replaces it.
      { clientKey: "t1", title: "One", why: "w", assigneeAgentId: pendingCeo },
    ])));

    const result = await startWorkService(db).plan(
      companyId,
      { text: "Do one thing", requestKey: randomUUID() },
      { userId: USER_ID },
    );

    const prompt = mocks.completeOnce.mock.calls[0][0].content as string;
    expect(prompt).not.toContain(pendingCeo);
    expect(prompt).not.toContain("Not Approved Yet");
    expect(prompt).toContain(engineer);

    expect(result.lead).toEqual({ id: engineer, name: "Cy" });
    expect(result.interaction.payload.tasks.map((task) => task.assigneeAgentId)).toEqual([engineer]);
  });

  it("refuses the eleventh fresh plan from one person for one company in the window, and creates nothing", async () => {
    const companyId = await seedCompany();
    const ceo = await seedAgent(companyId, { name: "Ada", role: "ceo" });
    mocks.completeOnce.mockResolvedValue(reply(plannerJson([
      { clientKey: "t1", title: "One", why: "w", assigneeAgentId: ceo },
    ])));
    const svc = startWorkService(db);

    for (let i = 0; i < 10; i += 1) {
      const allowed = await svc.plan(companyId, { text: `Thing number ${i}`, requestKey: randomUUID() }, { userId: USER_ID });
      expect(allowed.status).toBe("created");
    }

    await expect(
      svc.plan(companyId, { text: "One thing too many", requestKey: randomUUID() }, { userId: USER_ID }),
    ).rejects.toMatchObject({ status: 429, message: TOO_MANY_PLANS_MESSAGE });

    // The refusal costs no model call and writes no eleventh container.
    expect(mocks.completeOnce).toHaveBeenCalledTimes(10);
    expect(await issueRows(companyId)).toHaveLength(10);

    // Another person in the same company is unaffected: the ceiling is per
    // person, not a company wide freeze.
    const other = await svc.plan(
      companyId,
      { text: "A different person asks", requestKey: randomUUID() },
      { userId: "user-2" },
    );
    expect(other.status).toBe("created");

    // And a repeat of a key that already has a plan is still answered, because
    // it never reaches the model.
    const repeatKey = randomUUID();
    const firstForOther = await svc.plan(companyId, { text: "Again please", requestKey: repeatKey }, { userId: "user-2" });
    const again = await svc.plan(companyId, { text: "Again please", requestKey: repeatKey }, { userId: USER_ID });
    expect(again.status).toBe("existing");
    expect(again.issue.id).toBe(firstForOther.issue.id);
  });

  it("a repeated requestKey returns the same left-out list and the same recurring note as the first answer", async () => {
    const companyId = await seedCompany();
    const ceo = await seedAgent(companyId, { name: "Ada", role: "ceo" });
    await seedPlugin("help-scout", "ready");
    mocks.completeOnce.mockResolvedValue(reply(plannerJson([
      { clientKey: "t1", title: "Summarise support", why: "w", assigneeAgentId: ceo, needsPlugins: ["help-scout"] },
      { clientKey: "t2", title: "Answer Google reviews", why: "w", assigneeAgentId: ceo, needsPlugins: ["gbp-reviews"] },
    ], { soundsRecurring: true, recurringNote: "This sounds like a weekly job." })));
    const requestKey = randomUUID();
    const svc = startWorkService(db);

    const first = await svc.plan(companyId, { text: "Look after the customers", requestKey }, { userId: USER_ID });
    expect(first.leftOut).toEqual([
      { title: "Answer Google reviews", reason: "gbp-reviews is not installed" },
    ]);
    expect(first.notes.soundsRecurring).toBe(true);
    expect(first.notes.recurringNote).toBe("This sounds like a weekly job.");

    const second = await svc.plan(companyId, { text: "Look after the customers", requestKey }, { userId: USER_ID });
    expect(second.status).toBe("existing");
    expect(second.leftOut).toEqual(first.leftOut);
    expect(second.notes).toEqual(first.notes);
    expect(mocks.completeOnce).toHaveBeenCalledTimes(1);
    await expectNothingWoken();
  });
});
