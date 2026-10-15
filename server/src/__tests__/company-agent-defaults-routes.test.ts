import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockCompanyAgentDefaultsService = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

const mockAgentActionPolicyService = vi.hoisted(() => ({
  listCompanyPolicies: vi.fn(),
  updateCompanyPolicy: vi.fn(),
}));

vi.mock("../services/agent-action-policy.js", () => ({
  agentActionPolicyService: () => mockAgentActionPolicyService,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({}),
  agentService: () => ({}),
  budgetService: () => ({}),
  companyAgentDefaultsService: () => mockCompanyAgentDefaultsService,
  companyPortabilityService: () => ({}),
  companyService: () => mockCompanyService,
  logActivity: mockLogActivity,
}));

async function createApp(actor: Record<string, unknown>) {
  const [{ companyRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/companies.js")>("../routes/companies.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  const db: any = {};
  db.transaction = (callback: (tx: unknown) => unknown) => callback(db);
  app.use("/api/companies", companyRoutes(db));
  app.use(errorHandler);
  return app;
}

const boardMember = {
  type: "board",
  userId: "user-1",
  source: "session",
  isInstanceAdmin: false,
  companyIds: ["company-1"],
  memberships: [{ companyId: "company-1", status: "active", membershipRole: "owner" }],
};

describe("company agent-defaults routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/companies.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    mockCompanyService.getById.mockResolvedValue({ id: "company-1", kind: "standard" });
    mockCompanyAgentDefaultsService.get.mockResolvedValue({
      skipPermissionsByAdapterType: { claude_local: true },
    });
    mockCompanyAgentDefaultsService.update.mockResolvedValue({
      previous: { skipPermissionsByAdapterType: { claude_local: true } },
      next: { skipPermissionsByAdapterType: { claude_local: false } },
    });
    mockAgentActionPolicyService.listCompanyPolicies.mockResolvedValue([
      { companyId: "company-1", actionType: "send_message", mode: "ask_first" },
    ]);
    mockAgentActionPolicyService.updateCompanyPolicy.mockResolvedValue({
      previous: [{ companyId: "company-1", actionType: "send_message", mode: "ask_first" }],
      next: [{ companyId: "company-1", actionType: "send_message", mode: "go_ahead" }],
    });
  });

  it("lets a board member read the company defaults", async () => {
    const app = await createApp(boardMember);
    const res = await request(app).get("/api/companies/company-1/agent-defaults");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ skipPermissionsByAdapterType: { claude_local: true } });
  });

  it("lets a signed-in board member change the default and logs the before and after", async () => {
    const app = await createApp(boardMember);
    const res = await request(app)
      .patch("/api/companies/company-1/agent-defaults")
      .send({ skipPermissionsByAdapterType: { claude_local: false } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ skipPermissionsByAdapterType: { claude_local: false } });
    expect(mockCompanyAgentDefaultsService.update).toHaveBeenCalledWith("company-1", {
      skipPermissionsByAdapterType: { claude_local: false },
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity.mock.calls[0][1]).toMatchObject({
      companyId: "company-1",
      actorType: "user",
      actorId: "user-1",
      action: "company.agent_defaults_updated",
      entityType: "company",
      entityId: "company-1",
      details: {
        previous: { skipPermissionsByAdapterType: { claude_local: true } },
        agentDefaults: { skipPermissionsByAdapterType: { claude_local: false } },
        changedKeys: ["skipPermissionsByAdapterType"],
      },
    });
  });

  it("rejects agents, even the CEO of the same company", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-ceo",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });
    const res = await request(app)
      .patch("/api/companies/company-1/agent-defaults")
      .send({ skipPermissionsByAdapterType: { claude_local: true } });

    expect(res.status).toBe(403);
    expect(mockCompanyAgentDefaultsService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects tool sessions acting for a user", async () => {
    const app = await createApp({
      type: "tool_session",
      userId: "user-1",
      companyId: "company-1",
      source: "tool_session",
    });
    const res = await request(app)
      .patch("/api/companies/company-1/agent-defaults")
      .send({ skipPermissionsByAdapterType: { claude_local: true } });

    expect(res.status).toBe(403);
    expect(mockCompanyAgentDefaultsService.update).not.toHaveBeenCalled();
  });

  it("rejects viewers and members of other companies", async () => {
    const viewerApp = await createApp({
      ...boardMember,
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "viewer" }],
    });
    const viewerRes = await request(viewerApp)
      .patch("/api/companies/company-1/agent-defaults")
      .send({ skipPermissionsByAdapterType: { claude_local: true } });
    expect(viewerRes.status).toBe(403);

    const outsiderApp = await createApp({ ...boardMember, companyIds: ["company-2"], memberships: [] });
    const outsiderRes = await request(outsiderApp)
      .patch("/api/companies/company-1/agent-defaults")
      .send({ skipPermissionsByAdapterType: { claude_local: true } });
    expect(outsiderRes.status).toBe(403);
    expect(mockCompanyAgentDefaultsService.update).not.toHaveBeenCalled();
  });

  it("rejects unknown adapter types and non-boolean values", async () => {
    const app = await createApp(boardMember);
    const res = await request(app)
      .patch("/api/companies/company-1/agent-defaults")
      .send({ skipPermissionsByAdapterType: { http: true } });
    expect(res.status).toBe(400);
    expect(mockCompanyAgentDefaultsService.update).not.toHaveBeenCalled();
  });

  it("returns company action policies to a company reader", async () => {
    const app = await createApp(boardMember);
    const res = await request(app).get("/api/companies/company-1/action-policies");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { companyId: "company-1", actionType: "send_message", mode: "ask_first" },
    ]);
  });

  it("lets a board member update a company action policy and logs the change", async () => {
    const app = await createApp(boardMember);
    const res = await request(app)
      .patch("/api/companies/company-1/action-policies")
      .send({ actionType: "send_message", mode: "go_ahead" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { companyId: "company-1", actionType: "send_message", mode: "go_ahead" },
    ]);
    expect(mockAgentActionPolicyService.updateCompanyPolicy).toHaveBeenCalledWith(
      "company-1",
      "send_message",
      "go_ahead",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "company.action_policies_updated",
        details: expect.objectContaining({ actionType: "send_message", mode: "go_ahead" }),
      }),
    );
  });

  it("rejects an agent changing a company action policy", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-ceo",
      companyId: "company-1",
      source: "agent_key",
    });
    const res = await request(app)
      .patch("/api/companies/company-1/action-policies")
      .send({ actionType: "send_message", mode: "go_ahead" });

    expect(res.status).toBe(403);
    expect(mockAgentActionPolicyService.updateCompanyPolicy).not.toHaveBeenCalled();
  });
});
