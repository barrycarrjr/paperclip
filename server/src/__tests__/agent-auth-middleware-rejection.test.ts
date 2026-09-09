import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { _setPortfolioRootCacheForTesting } from "../services/portfolio-root-cache.js";

/**
 * A bearer token that fails verification used to call `next()` with no actor.
 * In a `local_trusted` deployment the request then kept the implicit local
 * board actor, so an agent posting with an expired token had its comments
 * stored under the human's identity. Every path below must now 401 instead.
 *
 * The one thing that must NOT 401 is a bearer token that was never an agent
 * credential: the public routine trigger carries its own opaque secret in the
 * same header and verifies it inside the route.
 */

function chain(rows: unknown[]) {
  return {
    from: () => ({
      where: () => Promise.resolve(rows),
    }),
  };
}

function buildApp(
  selectQueue: Array<unknown[] | (() => never)>,
  deploymentMode: "local_trusted" | "authenticated" = "local_trusted",
) {
  const select = vi.fn().mockImplementation(() => {
    if (selectQueue.length === 0) {
      throw new Error("unexpected db.select() call (queue empty)");
    }
    const next = selectQueue.shift()!;
    if (typeof next === "function") return next();
    return chain(next);
  });
  const update = vi.fn().mockImplementation(() => ({
    set: () => ({ where: () => Promise.resolve(undefined) }),
  }));
  const db = { select, update } as any;
  const app = express();
  app.use(
    actorMiddleware(db, {
      deploymentMode,
      resolveSession: async () => null,
    }),
  );
  app.get("/actor", (req, res) => {
    res.json(req.actor);
  });
  app.use(errorHandler);
  return { app, select };
}

describe("actorMiddleware: invalid agent credentials are rejected, not downgraded", () => {
  const previousSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const agentId = "11111111-1111-4111-8111-111111111111";
  const companyId = "22222222-2222-4222-8222-222222222222";
  const otherCompanyId = "44444444-4444-4444-8444-444444444444";
  const runId = "33333333-3333-4333-8333-333333333333";

  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "test-secret";
    _setPortfolioRootCacheForTesting(null);
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousSecret;
    _setPortfolioRootCacheForTesting(undefined);
  });

  it("401s an expired agent token and names the cause", async () => {
    const token = createLocalAgentJwt(agentId, companyId, "claude_local", runId);
    expect(token).toBeTruthy();
    // Re-mint the same claims with an exp in the past. Signing is irrelevant
    // here: verification rejects it either way, and the message is derived
    // from the unverified payload so the caller learns it needs a refresh.
    const [header, payloadB64, signature] = token!.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    payload.exp = Math.floor(Date.now() / 1000) - 60;
    const expired = [
      header,
      Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"),
      signature,
    ].join(".");

    const { app } = buildApp([
      [], // boardApiKeys: no match
      [], // agentApiKeys: no match
    ]);

    const res = await request(app).get("/actor").set("Authorization", `Bearer ${expired}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Expired agent token");
  });

  it("401s an agent-shaped token with a bad signature", async () => {
    const token = createLocalAgentJwt(agentId, companyId, "claude_local", runId);
    const tampered = `${token!.slice(0, -4)}beef`;

    const { app } = buildApp([[], []]);

    const res = await request(app).get("/actor").set("Authorization", `Bearer ${tampered}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("did not verify");
  });

  it("401s when the agent record is missing", async () => {
    const token = createLocalAgentJwt(agentId, companyId, "claude_local", runId);
    const { app } = buildApp([
      [], // boardApiKeys
      [], // agentApiKeys
      [], // agents: not found
    ]);

    const res = await request(app).get("/actor").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("missing or belongs to another company");
  });

  it("401s when the agent belongs to another company", async () => {
    const token = createLocalAgentJwt(agentId, companyId, "claude_local", runId);
    const { app } = buildApp([
      [],
      [],
      [{ id: agentId, companyId: otherCompanyId, status: "active" }],
    ]);

    const res = await request(app).get("/actor").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("missing or belongs to another company");
  });

  it("401s a terminated agent and says so", async () => {
    const token = createLocalAgentJwt(agentId, companyId, "claude_local", runId);
    const { app } = buildApp([
      [],
      [],
      [{ id: agentId, companyId, status: "terminated" }],
    ]);

    const res = await request(app).get("/actor").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("terminated");
  });

  it("401s an agent still pending approval and says so", async () => {
    const token = createLocalAgentJwt(agentId, companyId, "claude_local", runId);
    const { app } = buildApp([
      [],
      [],
      [{ id: agentId, companyId, status: "pending_approval" }],
    ]);

    const res = await request(app).get("/actor").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("pending approval");
  });

  it("401s an empty bearer token", async () => {
    const { app } = buildApp([]);

    const res = await request(app).get("/actor").set("Authorization", "Bearer   ");

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Empty bearer token");
  });

  it("still authenticates a valid agent token", async () => {
    const token = createLocalAgentJwt(agentId, companyId, "claude_local", runId);
    const { app } = buildApp([
      [],
      [],
      [{ id: agentId, companyId, status: "active" }],
    ]);

    const res = await request(app).get("/actor").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId,
      companyId,
      source: "agent_jwt",
    });
  });

  it("lets a non-agent bearer secret through so its own route can verify it", async () => {
    // `POST /routine-triggers/public/:publicId/fire` authenticates with the
    // trigger's own opaque secret in the Authorization header, and
    // actorMiddleware runs globally ahead of it. Rejecting every unknown
    // bearer token would break public webhook triggers, so a token that
    // carries none of our agent claims must fall through untouched.
    const { app } = buildApp([
      [], // boardApiKeys: no match
      [], // agentApiKeys: no match
    ]);

    const res = await request(app)
      .get("/actor")
      .set("Authorization", "Bearer wh_secret_not_a_jwt_at_all");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: "board", source: "local_implicit" });
  });

  it("lets a foreign JWT through when it carries none of our agent claims", async () => {
    // Shape check is on the claims, not merely on "has three dot-separated
    // parts": a third-party JWT forwarded to a plugin route is not an agent
    // credential and must not be rejected here.
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8").toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "someone", scope: "read" }), "utf8").toString("base64url");
    const foreign = `${header}.${payload}.notourssignature`;

    const { app } = buildApp([[], []]);

    const res = await request(app).get("/actor").set("Authorization", `Bearer ${foreign}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: "board", source: "local_implicit" });
  });
});
