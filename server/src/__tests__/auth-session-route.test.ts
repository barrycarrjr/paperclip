import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";

function createSelectChain(rows: unknown[]) {
  return {
    from() {
      return {
        where() {
          return Promise.resolve(rows);
        },
      };
    },
  };
}

/**
 * The three lookups the middleware makes for a signed-in user, in the order it
 * makes them: the instance admin role, the memberships, and whether an
 * instance admin has approved the account.
 */
function createDb(
  approvalStatus: string = "approved",
  rows: { roles?: unknown[]; memberships?: unknown[] } = {},
) {
  return {
    select: vi
      .fn()
      .mockImplementationOnce(() => createSelectChain(rows.roles ?? []))
      .mockImplementationOnce(() => createSelectChain(rows.memberships ?? []))
      .mockImplementationOnce(() => createSelectChain([{ approvalStatus }])),
  } as any;
}

function createApp(db: any) {
  const app = express();
  app.use(
    actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: async () => ({
        session: { id: "session-1", userId: "user-1" },
        user: {
          id: "user-1",
          name: "User One",
          email: "user@example.com",
        },
      }),
    }),
  );
  app.get("/actor", (req, res) => {
    res.json(req.actor);
  });
  return app;
}

describe("actorMiddleware authenticated session profile", () => {
  it("preserves the signed-in user name and email on the board actor", async () => {
    const res = await request(createApp(createDb())).get("/actor");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board",
      userId: "user-1",
      userName: "User One",
      userEmail: "user@example.com",
      source: "session",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: false,
    });
    expect(res.body.awaitingApproval).toBeUndefined();
  });

  it("gives an account still waiting for approval no memberships and no admin role, whatever it holds", async () => {
    const db = createDb("pending", {
      roles: [{ id: "role-1" }],
      memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
    });

    const res = await request(createApp(db)).get("/actor");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      type: "board",
      userId: "user-1",
      userName: "User One",
      userEmail: "user@example.com",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: false,
      awaitingApproval: true,
      source: "session",
    });
  });

  it("treats a declined account's session as no session at all", async () => {
    const res = await request(createApp(createDb("declined"))).get("/actor");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ type: "none", source: "none" });
  });

  it("treats an account it cannot find as no session at all", async () => {
    const db = {
      select: vi
        .fn()
        .mockImplementationOnce(() => createSelectChain([]))
        .mockImplementationOnce(() => createSelectChain([]))
        .mockImplementationOnce(() => createSelectChain([])),
    } as any;

    const res = await request(createApp(db)).get("/actor");

    expect(res.body).toEqual({ type: "none", source: "none" });
  });
});
