import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { accountApprovalGuard, isOpenToWaitingAccount } from "../middleware/account-approval-guard.js";
import { errorHandler } from "../middleware/error-handler.js";

function createApp(actor: Express.Request["actor"]) {
  const app = express();
  app.use((req, _res, next) => {
    req.actor = { ...actor };
    next();
  });
  app.use(accountApprovalGuard());
  app.all("/{*anyPath}", (req, res) => {
    res.json({ reached: true, actor: req.actor });
  });
  app.use(errorHandler);
  return app;
}

const waiting: Express.Request["actor"] = {
  type: "board",
  userId: "user-waiting",
  companyIds: [],
  memberships: [],
  isInstanceAdmin: false,
  awaitingApproval: true,
  source: "session",
};

describe("the calls open to an account waiting for approval", () => {
  it("are what the waiting screen, the invite page and the board-claim page need", () => {
    for (const [method, path] of [
      ["GET", "/api/auth/get-session"],
      ["POST", "/api/auth/sign-out"],
      ["POST", "/api/auth/sign-in/email"],
      ["POST", "/api/auth/sign-up/email"],
      ["GET", "/api/health"],
      ["GET", "/api/invites/pcp_invite_abc"],
      ["GET", "/api/invites/pcp_invite_abc/logo"],
      ["POST", "/api/invites/pcp_invite_abc/accept"],
      ["GET", "/api/board-claim/token-1"],
      ["POST", "/api/board-claim/token-1/claim"],
    ]) {
      expect(isOpenToWaitingAccount(method!, path!), `${method} ${path}`).toBe(true);
    }
  });

  it("are nothing else, not even a near neighbour of an open one", () => {
    for (const [method, path] of [
      ["GET", "/api/companies"],
      ["POST", "/api/auth/get-session"],
      ["GET", "/api/auth/profile"],
      ["POST", "/api/auth/update-user"],
      ["POST", "/api/auth/change-password"],
      ["GET", "/api/auth/list-sessions"],
      ["POST", "/api/invites/abc/revoke"],
      ["GET", "/api/invites/abc/onboarding"],
      ["POST", "/api/invites/abc/accept/extra"],
      ["GET", "/api/invites/abc/../../companies"],
      ["GET", "/api/health/details"],
      ["DELETE", "/api/board-claim/token-1"],
      ["GET", "/api/cli-auth/me"],
    ]) {
      expect(isOpenToWaitingAccount(method!, path!), `${method} ${path}`).toBe(false);
    }
  });
});

describe("accountApprovalGuard", () => {
  it("refuses a waiting account any other API call, with a code the app can tell apart", async () => {
    const app = createApp(waiting);
    for (const path of ["/api/companies", "/API/Companies", "/api", "/llms/agent-icons.txt"]) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(403);
      expect(res.body, path).toMatchObject({
        error: "Your account is waiting for an admin to approve it.",
        code: "account_pending_approval",
      });
    }
    const write = await request(app).post("/api/companies").send({ name: "Mine" });
    expect(write.status).toBe(403);
  });

  it("lets a waiting account through to the calls open to it, as itself", async () => {
    const res = await request(createApp(waiting)).get("/api/auth/get-session");
    expect(res.status).toBe(200);
    expect(res.body.actor).toMatchObject({ type: "board", userId: "user-waiting", awaitingApproval: true });
  });

  it("lets a waiting account load the app's own pages, as nobody", async () => {
    const res = await request(createApp(waiting)).get("/instance/settings/access");
    expect(res.status).toBe(200);
    expect(res.body.actor).toEqual({ type: "none", source: "none" });
  });

  it("leaves every other actor alone, the local_trusted board included", async () => {
    const others: Array<Express.Request["actor"]> = [
      { type: "board", userId: "local-board", isInstanceAdmin: true, source: "local_implicit" },
      { type: "board", userId: "user-1", companyIds: ["c1"], source: "session" },
      { type: "agent", agentId: "agent-1", companyId: "c1", source: "agent_key" },
      { type: "none", source: "none" },
    ];
    for (const actor of others) {
      const res = await request(createApp(actor)).get("/api/companies");
      expect(res.status).toBe(200);
      expect(res.body.actor).toEqual(actor);
    }
  });
});
