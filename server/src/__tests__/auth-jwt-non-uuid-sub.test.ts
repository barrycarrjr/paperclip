import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";

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

describe("actorMiddleware: local agent JWT with non-UUID sub", () => {
  const previousSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;

  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "test-secret";
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousSecret;
  });

  it("falls through to unauthenticated without crashing when sub is not a UUID", async () => {
    // Mirrors the synthetic Clippy chat-session sub minted in
    // services/chat-providers.ts (`clippy-${sessionId}`). Before the guard,
    // running this through `eq(agents.id, claims.sub)` against the uuid
    // column threw `22P02 invalid input syntax for type uuid` and turned
    // every Clippy → API call into a 500.
    //
    // Expected select calls (in order): boardApiKeys lookup, agentApiKeys
    // lookup. The agents lookup must be skipped entirely for the non-UUID
    // sub.
    const failOnAgentsLookup = (): never => {
      throw new Error("agents table must not be queried for non-UUID sub");
    };
    const { app, select } = buildApp([
      [], // boardApiKeys: no match
      [], // agentApiKeys: no match
      failOnAgentsLookup, // agents: must NOT be queried
    ]);

    const token = createLocalAgentJwt(
      "clippy-c760c479-b9e7-4a06-b260-b475c9bc4553",
      "22222222-2222-4222-8222-222222222222",
      "claude_local",
      "33333333-3333-4333-8333-333333333333",
    );
    expect(token).toBeTruthy();

    const res = await request(app).get("/actor").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: "none" });
    // boardApiKeys + agentApiKeys; agents lookup MUST be skipped.
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("still reaches the agents lookup when sub is a valid UUID", async () => {
    // Companion to the regression test above: prove the guard didn't
    // accidentally short-circuit the legitimate UUID-sub path. We only
    // assert the agents query is reached (and throws our sentinel) — the
    // post-lookup branches (annotateHqStatus, etc.) need broader mocking
    // than is useful for this guard.
    const agentId = "11111111-1111-4111-8111-111111111111";
    const companyId = "22222222-2222-4222-8222-222222222222";
    const runId = "33333333-3333-4333-8333-333333333333";

    let agentsQueried = false;
    const reachedAgentsLookup = (): never => {
      agentsQueried = true;
      throw new Error("sentinel: agents lookup reached for UUID sub");
    };
    const { app } = buildApp([
      [], // boardApiKeys: no match
      [], // agentApiKeys: no match
      reachedAgentsLookup, // sentinel: confirm we reach the agents lookup
    ]);

    const token = createLocalAgentJwt(agentId, companyId, "claude_local", runId);
    expect(token).toBeTruthy();

    await request(app).get("/actor").set("Authorization", `Bearer ${token}`);

    expect(agentsQueried).toBe(true);
  });
});
