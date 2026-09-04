import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { _setPortfolioRootCacheForTesting } from "../services/portfolio-root-cache.js";

function chain(rows: unknown[]) {
  return {
    from: () => ({
      where: () => Promise.resolve(rows),
    }),
  };
}

function buildApp(selectQueue: Array<unknown[] | (() => never)>) {
  const select = vi.fn().mockImplementation(() => {
    if (selectQueue.length === 0) {
      throw new Error("unexpected db.select() call (queue empty)");
    }
    const next = selectQueue.shift()!;
    if (typeof next === "function") {
      return next();
    }
    return chain(next);
  });
  const db = { select } as any;
  const app = express();
  app.use(
    actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: async () => null,
    }),
  );
  app.get("/actor", (req, res) => {
    res.json(req.actor);
  });
  return { app, select };
}

describe("actorMiddleware: local agent JWT sub handling", () => {
  const previousSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const sessionUuid = "c760c479-b9e7-4a06-b260-b475c9bc4553";
  const companyId = "22222222-2222-4222-8222-222222222222";
  const runId = "33333333-3333-4333-8333-333333333333";
  const userId = "user-1";

  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "test-secret";
    // Pin the HQ cache to "no HQ exists" so annotateHqStatus does not
    // hit the db.companies table during these middleware-only tests.
    _setPortfolioRootCacheForTesting(null);
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousSecret;
    _setPortfolioRootCacheForTesting(undefined);
  });

  it("authenticates a Clippy chat session as a tool_session actor scoped to one company", async () => {
    // Clippy mints sub = `clippy-<sessionId>` in chat-providers.ts. The
    // middleware recognizes the synthetic prefix, skips the agents lookup
    // entirely (the sub is not a key into agents.id), and authenticates
    // with company scope + the driving user id from the user_id claim.
    const failOnAgentsLookup = (): never => {
      throw new Error("agents table must not be queried for tool-session sub");
    };
    const { app, select } = buildApp([
      [], // boardApiKeys: no match
      [], // agentApiKeys: no match
      failOnAgentsLookup,
    ]);

    const token = createLocalAgentJwt(
      `clippy-${sessionUuid}`,
      companyId,
      "claude_local",
      runId,
      { userId },
    );
    expect(token).toBeTruthy();

    const res = await request(app).get("/actor").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "tool_session",
      companyId,
      userId,
      toolSessionId: `clippy-${sessionUuid}`,
      source: "tool_session_jwt",
    });
    expect(res.body.runId).toBe(runId);
    // Only boardApiKeys + agentApiKeys; agents lookup MUST be skipped.
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("rejects an unrecognized non-UUID sub instead of reaching the agents lookup", async () => {
    // Defensive guard: any sub that is neither a UUID (legacy agent JWT)
    // nor a recognized tool-session prefix must NOT reach the agents
    // lookup, since `eq(agents.id, sub)` against the uuid column would
    // throw `22P02 invalid input syntax for type uuid` and 500 the
    // request.
    //
    // The token itself verified, so it IS one of our agent credentials and
    // it cannot authenticate. It used to fall through to type:none, which
    // in a local_trusted deployment lands on the board actor and stores
    // the agent's writes under the human's identity. It now 401s.
    const failOnAgentsLookup = (): never => {
      throw new Error("agents table must not be queried for unknown non-UUID sub");
    };
    const { app, select } = buildApp([
      [], // boardApiKeys: no match
      [], // agentApiKeys: no match
      failOnAgentsLookup,
    ]);

    const token = createLocalAgentJwt(
      "future-tool-not-recognized",
      companyId,
      "some_adapter",
      runId,
    );
    expect(token).toBeTruthy();

    const res = await request(app).get("/actor").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("still reaches the agents lookup when sub is a valid UUID", async () => {
    // Companion to the guards above: prove the legitimate UUID-sub path
    // still queries agents. We only assert the agents query is reached
    // (and throws our sentinel) — the post-lookup branches need broader
    // mocking than is useful here.
    const agentUuid = "11111111-1111-4111-8111-111111111111";

    let agentsQueried = false;
    const reachedAgentsLookup = (): never => {
      agentsQueried = true;
      throw new Error("sentinel: agents lookup reached for UUID sub");
    };
    const { app } = buildApp([
      [], // boardApiKeys: no match
      [], // agentApiKeys: no match
      reachedAgentsLookup,
    ]);

    const token = createLocalAgentJwt(agentUuid, companyId, "claude_local", runId);
    expect(token).toBeTruthy();

    await request(app).get("/actor").set("Authorization", `Bearer ${token}`);

    expect(agentsQueried).toBe(true);
  });
});
