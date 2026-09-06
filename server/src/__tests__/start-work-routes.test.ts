import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_KEY = "33333333-3333-4333-8333-333333333333";
const ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const INTERACTION_ID = "55555555-5555-4555-8555-555555555555";
const LEAD_ID = "66666666-6666-4666-8666-666666666666";

// The service is the unit under test elsewhere; here only the route's
// access checks, body handling and status codes are on trial.
const mockPlan = vi.hoisted(() => vi.fn());

vi.mock("../services/start-work.js", () => ({
  startWorkService: () => ({ plan: mockPlan }),
}));

const { startWorkRoutes } = await import("../routes/start-work.js");
const { errorHandler } = await import("../middleware/error-handler.js");

function planResult(overrides: Record<string, unknown> = {}) {
  return {
    status: "created",
    issue: { id: ISSUE_ID, identifier: "PAP-12", title: "Request: Chase up unpaid invoices" },
    interaction: {
      id: INTERACTION_ID,
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      kind: "suggest_tasks",
      status: "pending",
      continuationPolicy: "wake_assignee_on_accept",
      idempotencyKey: `start-work:${REQUEST_KEY}`,
      payload: { version: 1, tasks: [{ clientKey: "t1", title: "Chase the invoices", assigneeAgentId: LEAD_ID }] },
      result: null,
    },
    lead: { id: LEAD_ID, name: "Ada" },
    leftOut: [],
    warnings: [],
    notes: { soundsRecurring: false, recurringNote: null, companyName: "Paperclip", isPortfolioRoot: false },
    guardrails: { outboundHold: false },
    planner: { modelUsed: "anthropic/claude-test" },
    matchedCards: [],
    ...overrides,
  };
}

function boardActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "board",
    userId: "user-1",
    source: "session",
    companyIds: [COMPANY_ID],
    isInstanceAdmin: false,
    memberships: [{ companyId: COMPANY_ID, membershipRole: "admin", status: "active" }],
    ...overrides,
  };
}

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", startWorkRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const PATH = `/api/companies/${COMPANY_ID}/start-work/plan`;
const VALID_BODY = { text: "Chase up unpaid invoices", requestKey: REQUEST_KEY };

describe("start work routes", () => {
  beforeEach(() => {
    mockPlan.mockReset();
    mockPlan.mockResolvedValue(planResult());
  });

  it("returns 403 for an agent actor", async () => {
    const app = createApp({ type: "agent", agentId: LEAD_ID, companyId: COMPANY_ID });
    const res = await request(app).post(PATH).send(VALID_BODY);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Board access required");
    expect(mockPlan).not.toHaveBeenCalled();
  });

  it("returns 403 for a tool_session actor", async () => {
    const app = createApp({ type: "tool_session", companyId: COMPANY_ID, userId: "user-1", toolSessionId: "ts-1" });
    const res = await request(app).post(PATH).send(VALID_BODY);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Board access required");
    expect(mockPlan).not.toHaveBeenCalled();
  });

  it("returns 403 for a viewer member with Viewer access is read-only", async () => {
    const app = createApp(boardActor({
      memberships: [{ companyId: COMPANY_ID, membershipRole: "viewer", status: "active" }],
    }));
    const res = await request(app).post(PATH).send(VALID_BODY);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Viewer access is read-only");
    expect(mockPlan).not.toHaveBeenCalled();
  });

  it("returns 403 for a member of a different company", async () => {
    const app = createApp(boardActor({
      companyIds: [OTHER_COMPANY_ID],
      memberships: [{ companyId: OTHER_COMPANY_ID, membershipRole: "admin", status: "active" }],
    }));
    const res = await request(app).post(PATH).send(VALID_BODY);
    expect(res.status).toBe(403);
    expect(mockPlan).not.toHaveBeenCalled();
  });

  it("uses the path companyId and ignores a companyId in the body", async () => {
    const app = createApp(boardActor());
    const res = await request(app).post(PATH).send({ ...VALID_BODY, companyId: OTHER_COMPANY_ID });
    expect(res.status).toBe(201);
    expect(mockPlan).toHaveBeenCalledTimes(1);
    const [companyId, body, actor] = mockPlan.mock.calls[0];
    expect(companyId).toBe(COMPANY_ID);
    // The schema strips it: the service never even sees a body companyId.
    expect(body).toEqual(VALID_BODY);
    expect(actor).toEqual({ userId: "user-1" });
  });

  it("returns 400 for text under 3 characters or a non-uuid requestKey", async () => {
    const app = createApp(boardActor());

    const short = await request(app).post(PATH).send({ text: "hi", requestKey: REQUEST_KEY });
    expect(short.status).toBe(400);
    expect(short.body.error).toBe("Validation error");

    const badKey = await request(app).post(PATH).send({ text: "Chase up unpaid invoices", requestKey: "not-a-uuid" });
    expect(badKey.status).toBe(400);

    const missing = await request(app).post(PATH).send({});
    expect(missing.status).toBe(400);

    expect(mockPlan).not.toHaveBeenCalled();
  });

  it("responds 201 with guardrails.outboundHold from instance settings and planner.modelUsed", async () => {
    mockPlan.mockResolvedValue(planResult({
      guardrails: { outboundHold: true },
      planner: { modelUsed: "openai/gpt-test" },
    }));
    const app = createApp(boardActor());
    const res = await request(app).post(PATH).send(VALID_BODY);
    expect(res.status).toBe(201);
    expect(res.body.guardrails).toEqual({ outboundHold: true });
    expect(res.body.planner).toEqual({ modelUsed: "openai/gpt-test" });
    expect(res.body.issue).toEqual({ id: ISSUE_ID, identifier: "PAP-12", title: "Request: Chase up unpaid invoices" });
    expect(res.body.interaction.id).toBe(INTERACTION_ID);
    expect(res.body.lead).toEqual({ id: LEAD_ID, name: "Ada" });
    // The service's own created/existing flag is the status code, not a body field.
    expect(res.body.status).toBeUndefined();
  });

  it("responds 200 for a repeated key", async () => {
    mockPlan.mockResolvedValue(planResult({ status: "existing", planner: { modelUsed: null } }));
    const app = createApp(boardActor());
    const res = await request(app).post(PATH).send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body.planner).toEqual({ modelUsed: null });
    expect(res.body.issue.id).toBe(ISSUE_ID);
  });

  it("passes the service's plain-words refusals through with their status", async () => {
    const { HttpError, serviceUnavailable, unprocessable } = await import("../errors.js");
    const app = createApp(boardActor());

    // The service's own ceiling on how many fresh plans one person may ask
    // for reaches the browser as a 429 with its sentence intact.
    mockPlan.mockRejectedValueOnce(new HttpError(
      429,
      "You have asked for a lot of plans in a short time. Wait a few minutes and try again. Nothing was created.",
    ));
    const tooMany = await request(app).post(PATH).send(VALID_BODY);
    expect(tooMany.status).toBe(429);
    expect(tooMany.body.error).toBe(
      "You have asked for a lot of plans in a short time. Wait a few minutes and try again. Nothing was created.",
    );

    mockPlan.mockRejectedValueOnce(serviceUnavailable("No AI model is set up yet, so a plan cannot be drafted."));
    const noModel = await request(app).post(PATH).send(VALID_BODY);
    expect(noModel.status).toBe(503);
    expect(noModel.body.error).toContain("No AI model is set up yet");

    mockPlan.mockRejectedValueOnce(unprocessable("This company has no agent to do the work. Add an agent first, then try again."));
    const noAgent = await request(app).post(PATH).send(VALID_BODY);
    expect(noAgent.status).toBe(422);
    expect(noAgent.body.error).toContain("no agent to do the work");
  });
});
