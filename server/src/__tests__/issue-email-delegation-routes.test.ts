import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import {
  activityLog,
  agents,
  companies,
  createDb,
  instanceSettings,
  issueComments,
  issueEmailDelegations,
  issueReferenceMentions,
  issues,
} from "@paperclipai/db";
import { EMAIL_HANDOFF_ORIGIN_KIND, buildEmailHandoffOriginId } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * The take-over route has to stop a running agent, and what matters in these
 * tests is what it DOES with the answer: a stop that worked, a stop that
 * failed, and no run at all are three different things a person needs told
 * apart. Driving a real run to each of those states would test the heartbeat
 * rather than this route, so the heartbeat is stubbed and everything else
 * (the database, the state machine, the work item) stays real.
 */
const heartbeatStub = {
  getRun: vi.fn(async (_id: string) => null as any),
  getActiveRunForAgent: vi.fn(async (_id: string) => null as any),
  cancelRun: vi.fn(async (_id: string) => null as any),
};

vi.mock("../services/heartbeat.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  heartbeatService: () => heartbeatStub,
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres delegation route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/** Records every dispatch so the tests can assert what was actually sent. */
function makeDispatcher(behaviour: "draft" | "send" | "throw" = "draft") {
  const executeTool = vi.fn(async () => {
    if (behaviour === "throw") throw new Error("Mailbox rejected the message");
    return {
      pluginId: "email-tools",
      toolName: "email-tools:email_reply",
      result:
        behaviour === "draft"
          ? { content: "queued", data: { drafted: true, approvalId: "ap-1" } }
          : { content: "sent" },
    };
  });
  return { executeTool } as any;
}

describeEmbeddedPostgres("email delegation routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  let companyId!: string;
  let otherCompanyId!: string;
  let issueId!: string;
  let userId!: string;
  let agentId!: string;
  let dispatcher: any = null;

  let issueRoutes!: typeof import("../routes/issues.js")["issueRoutes"];
  let errorHandler!: typeof import("../middleware/index.js")["errorHandler"];

  const sourceKey = buildEmailHandoffOriginId({
    pluginId: "email-tools",
    mailbox: "personal",
    messageId: "<invoice@customer.example>",
  })!;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-delegation-routes-");
    db = createDb(tempDb.connectionString);
    ({ issueRoutes } = await import("../routes/issues.js"));
    ({ errorHandler } = await import("../middleware/index.js"));
  }, 90_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueReferenceMentions);
    await db.delete(issueEmailDelegations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
    dispatcher = null;
    heartbeatStub.getRun.mockReset().mockResolvedValue(null);
    heartbeatStub.getActiveRunForAgent.mockReset().mockResolvedValue(null);
    heartbeatStub.cancelRun.mockReset().mockResolvedValue(null);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function makeApp(actorCompanyId: () => string, actorType: "board" | "agent" = "board") {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: actorType,
        agentId: actorType === "agent" ? agentId : undefined,
        userId,
        companyIds: [actorCompanyId()],
        source: "session",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use(issueRoutes(db, {} as any, { getToolDispatcher: () => dispatcher }));
    app.use(errorHandler);
    return app;
  }

  async function seed(
    opts: {
      replyApproval?: "inherit" | "always" | "never";
      hold?: boolean;
      /** The work item's own status, so a take-over can be tested against work already underway. */
      issueStatus?: string;
    } = {},
  ) {
    userId = randomUUID();
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    for (const [id, name] of [
      [companyId, "Acme"],
      [otherCompanyId, "Other"],
    ] as const) {
      await db.insert(companies).values({
        id,
        name,
        issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
    }

    await db.insert(instanceSettings).values({
      key: "default",
      general: {
        outboundToolDraftMode: opts.hold ?? true,
        emailHandoffReplyApproval: opts.replyApproval ?? "inherit",
      },
    } as any);

    agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ada",
      role: "worker",
    });

    issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Customer asked about an invoice",
      status: opts.issueStatus ?? "todo",
      assigneeAgentId: agentId,
      originKind: EMAIL_HANDOFF_ORIGIN_KIND,
      originId: sourceKey,
    });

    const [delegation] = await db
      .insert(issueEmailDelegations)
      .values({
        issueId,
        companyId,
        pluginId: "email-tools",
        sourceKey,
        mailbox: "personal",
        messageId: "<invoice@customer.example>",
        delegatedToAgentId: agentId,
      })
      .returning();
    return delegation;
  }

  const base = () => `/companies/${companyId}/issues/${issueId}/email-delegations`;

  it("lists the handovers on an issue", async () => {
    const delegation = await seed();
    const res = await request(makeApp(() => companyId)).get(base());

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(delegation.id);
    expect(res.body[0].status).toBe("delegated");
  });

  it("marks a handover as picked up", async () => {
    const delegation = await seed();
    const res = await request(makeApp(() => companyId))
      .post(`${base()}/${delegation.id}/acknowledge`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("acknowledged");
    expect(res.body.acknowledgedAt).toBeTruthy();
  });

  it("resolves and holds the reply for approval when the hold is on", async () => {
    const delegation = await seed({ hold: true, replyApproval: "inherit" });
    dispatcher = makeDispatcher("draft");

    const res = await request(makeApp(() => companyId))
      .post(`${base()}/${delegation.id}/resolve`)
      .send({ replyBody: "Refund issued, sorry for the trouble.", resolutionNote: "Refunded" });

    expect(res.status).toBe(200);
    expect(res.body.delegation.status).toBe("resolved");
    expect(res.body.reply).toEqual({ replyState: "queued" });
    expect(dispatcher.executeTool).toHaveBeenCalledWith(
      "email-tools:email_reply",
      expect.objectContaining({ mailbox: "personal", messageId: "<invoice@customer.example>" }),
      expect.anything(),
      { forceDraftGate: true, bypassDraftGate: false },
    );
  });

  it("sends the reply straight out when the operator asked for that", async () => {
    const delegation = await seed({ hold: true, replyApproval: "never" });
    dispatcher = makeDispatcher("send");

    const res = await request(makeApp(() => companyId))
      .post(`${base()}/${delegation.id}/resolve`)
      .send({ replyBody: "All done." });

    expect(res.status).toBe(200);
    expect(res.body.reply).toEqual({ replyState: "sent" });
  });

  it("resolves without sending when no reply was written", async () => {
    const delegation = await seed();
    dispatcher = makeDispatcher("send");

    const res = await request(makeApp(() => companyId))
      .post(`${base()}/${delegation.id}/resolve`)
      .send({ resolutionNote: "Answered internally, nothing to send" });

    expect(res.status).toBe(200);
    expect(res.body.delegation.status).toBe("resolved");
    expect(res.body.reply.replyState).toBe("none");
    expect(dispatcher.executeTool).not.toHaveBeenCalled();
  });

  it("refuses rather than dropping a reply when tools are not ready", async () => {
    const delegation = await seed();
    dispatcher = null;

    const res = await request(makeApp(() => companyId))
      .post(`${base()}/${delegation.id}/resolve`)
      .send({ replyBody: "This was going to a customer." });

    expect(res.status).toBe(503);
    // The handover must still be open, so the reply can be sent on a retry.
    const [row] = await db.select().from(issueEmailDelegations);
    expect(row.status).toBe("delegated");
  });

  it("records a failed send without losing the resolution", async () => {
    const delegation = await seed();
    dispatcher = makeDispatcher("throw");

    const res = await request(makeApp(() => companyId))
      .post(`${base()}/${delegation.id}/resolve`)
      .send({ replyBody: "All done." });

    expect(res.status).toBe(200);
    expect(res.body.reply).toEqual({
      replyState: "failed",
      error: "Mailbox rejected the message",
    });
    const [row] = await db.select().from(issueEmailDelegations);
    expect(row.status).toBe("resolved");
    expect(row.replyState).toBe("failed");
  });

  it("hands work back with a reason, and sends nothing", async () => {
    const delegation = await seed();
    dispatcher = makeDispatcher("send");

    const res = await request(makeApp(() => companyId))
      .post(`${base()}/${delegation.id}/hand-back`)
      .send({ reason: "Needs billing access I do not have" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("handed_back");
    expect(res.body.handedBackReason).toBe("Needs billing access I do not have");
    expect(dispatcher.executeTool).not.toHaveBeenCalled();
  });

  it("will not hand back without a reason", async () => {
    const delegation = await seed();
    const res = await request(makeApp(() => companyId))
      .post(`${base()}/${delegation.id}/hand-back`)
      .send({});

    expect(res.status).toBe(400);
  });

  it("will not resolve a handover twice", async () => {
    const delegation = await seed();
    dispatcher = makeDispatcher("send");
    const app = makeApp(() => companyId);

    await request(app).post(`${base()}/${delegation.id}/resolve`).send({});
    const second = await request(app).post(`${base()}/${delegation.id}/resolve`).send({});

    expect(second.status).toBe(422);
  });

  it("refuses a stale version rather than overwriting a newer change", async () => {
    const delegation = await seed();
    const app = makeApp(() => companyId);

    await request(app)
      .post(`${base()}/${delegation.id}/hand-back`)
      .send({ reason: "Wrong team" });

    const res = await request(app)
      .post(`${base()}/${delegation.id}/resolve`)
      .send({ expectedVersion: delegation.version });

    expect(res.status).toBe(409);
  });

  it("does not let another company's user reach the handover", async () => {
    const delegation = await seed();
    const res = await request(makeApp(() => otherCompanyId))
      .post(`${base()}/${delegation.id}/acknowledge`)
      .send({});

    expect(res.status).toBe(403);
  });

  // ── Taking an email back from an agent ──────────────────────────────────

  it("lists everything agents are holding in the company", async () => {
    const delegation = await seed();
    const res = await request(makeApp(() => companyId)).get(
      `/companies/${companyId}/email-delegations`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(delegation.id);
    expect(res.body[0].agent).toEqual({ id: agentId, name: "Ada" });
    expect(res.body[0].issue).toMatchObject({ id: issueId, title: "Customer asked about an invoice" });
  });

  it("does not list another company's held mail", async () => {
    await seed();
    const res = await request(makeApp(() => otherCompanyId)).get(
      `/companies/${companyId}/email-delegations`,
    );
    expect(res.status).toBe(403);
  });

  it("takes the email back, stops the run, and frees the work item", async () => {
    const delegation = await seed({ issueStatus: "in_progress" });
    heartbeatStub.getActiveRunForAgent.mockResolvedValue({
      id: "run-1",
      status: "running",
      contextSnapshot: { issueId },
    });
    heartbeatStub.cancelRun.mockResolvedValue({ id: "run-1", status: "cancelled", companyId, agentId });

    const res = await request(makeApp(() => companyId))
      .post(`${base()}/${delegation.id}/take-over`)
      .send({ reason: "I want to answer this one myself" });

    expect(res.status).toBe(200);
    expect(res.body.delegation.status).toBe("handed_back");
    expect(res.body.delegation.handedBackReason).toBe("I want to answer this one myself");
    expect(res.body.run).toEqual({ state: "stopped", runId: "run-1" });
    expect(res.body.workItem).toMatchObject({
      state: "updated",
      unassignedAgent: true,
      statusChangedTo: "todo",
    });

    const [issue] = await db.select().from(issues);
    expect(issue.assigneeAgentId).toBeNull();
    expect(issue.status).toBe("todo");

    // The record itself cannot say a person ended this rather than the agent,
    // so the work item carries that in words.
    const comments = await db.select().from(issueComments);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("Took this email back from the agent");
    expect(comments[0]!.body).toContain("I want to answer this one myself");

    // The email is free again: nothing is holding it.
    const held = await request(makeApp(() => companyId)).get(
      `/companies/${companyId}/email-delegations`,
    );
    expect(held.body).toHaveLength(0);
  });

  it("says so when there was no run to stop", async () => {
    const delegation = await seed();

    const res = await request(makeApp(() => companyId))
      .post(`${base()}/${delegation.id}/take-over`)
      .send({ reason: "Mine now" });

    expect(res.status).toBe(200);
    expect(res.body.run).toEqual({ state: "none" });
    expect(res.body.delegation.status).toBe("handed_back");
  });

  it("reports a failure to stop the agent instead of swallowing it", async () => {
    const delegation = await seed();
    heartbeatStub.getActiveRunForAgent.mockResolvedValue({
      id: "run-2",
      status: "running",
      contextSnapshot: { issueId },
    });
    heartbeatStub.cancelRun.mockRejectedValue(new Error("The agent's machine did not answer"));

    const res = await request(makeApp(() => companyId))
      .post(`${base()}/${delegation.id}/take-over`)
      .send({ reason: "Taking this back" });

    expect(res.status).toBe(200);
    expect(res.body.run).toEqual({
      state: "failed",
      error: "The agent's machine did not answer",
      runId: "run-2",
    });
    // The take-over still stands: the person asked for the email back and got
    // it. What they also get is the truth about the run.
    expect(res.body.delegation.status).toBe("handed_back");
  });

  it("reports a run that would not stop even when nothing threw", async () => {
    const delegation = await seed();
    heartbeatStub.getActiveRunForAgent.mockResolvedValue({
      id: "run-3",
      status: "running",
      contextSnapshot: { issueId },
    });
    heartbeatStub.cancelRun.mockResolvedValue({ id: "run-3", status: "running" });

    const res = await request(makeApp(() => companyId))
      .post(`${base()}/${delegation.id}/take-over`)
      .send({ reason: "Taking this back" });

    expect(res.status).toBe(200);
    expect(res.body.run.state).toBe("failed");
    expect(res.body.run.runId).toBe("run-3");
  });

  it("will not take an email back without a reason", async () => {
    const delegation = await seed();
    const res = await request(makeApp(() => companyId))
      .post(`${base()}/${delegation.id}/take-over`)
      .send({});

    expect(res.status).toBe(400);
    const [row] = await db.select().from(issueEmailDelegations);
    expect(row.status).toBe("delegated");
  });

  it("does not let an agent take an email over on a person's behalf", async () => {
    const delegation = await seed();
    const res = await request(makeApp(() => companyId, "agent"))
      .post(`${base()}/${delegation.id}/take-over`)
      .send({ reason: "Not mine to take" });

    expect(res.status).toBe(403);
    const [row] = await db.select().from(issueEmailDelegations);
    expect(row.status).toBe("delegated");
  });

  it("will not take over a handover that is already finished", async () => {
    const delegation = await seed();
    const app = makeApp(() => companyId);
    await request(app).post(`${base()}/${delegation.id}/take-over`).send({ reason: "Mine" });

    const second = await request(app)
      .post(`${base()}/${delegation.id}/take-over`)
      .send({ reason: "Mine again" });
    expect(second.status).toBe(422);
  });

  it("does not let another company's user take the email back", async () => {
    const delegation = await seed();
    const res = await request(makeApp(() => otherCompanyId))
      .post(`${base()}/${delegation.id}/take-over`)
      .send({ reason: "Not my company" });

    expect(res.status).toBe(403);
  });

  it("does not accept a delegation id belonging to a different issue", async () => {
    const delegation = await seed();
    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId,
      companyId,
      title: "Unrelated work",
      status: "todo",
    });

    const res = await request(makeApp(() => companyId))
      .post(
        `/companies/${companyId}/issues/${otherIssueId}/email-delegations/${delegation.id}/acknowledge`,
      )
      .send({});

    expect(res.status).toBe(404);
  });
});
