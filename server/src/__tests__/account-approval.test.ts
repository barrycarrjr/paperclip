import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  authUsers,
  boardApiKeys,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  invites,
} from "@paperclipai/db";
import { createApp } from "../app.js";
import {
  createBetterAuthHandler,
  createBetterAuthInstance,
  resolveBetterAuthSession,
  resolveBetterAuthSessionFromHeaders,
} from "../auth/better-auth.js";
import { getBoardClaimWarningUrl, initializeBoardClaimChallenge } from "../board-claim.js";
import type { Config } from "../config.js";
import { boardActorForLinkedUser } from "../middleware/auth.js";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { _resetLiveEventsForTest } from "../services/live-events.js";
import type { StorageService } from "../storage/types.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres account approval tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const ORIGIN = "http://localhost:3100";
const PASSWORD = "correct horse battery";
const WAITING = "account_pending_approval";

const storage: StorageService = {
  provider: "local_disk",
  async putFile(input) {
    return {
      provider: "local_disk",
      objectKey: `${input.namespace}/${randomUUID()}`,
      contentType: input.contentType,
      byteSize: input.body.length,
      sha256: createHash("sha256").update(input.body).digest("hex"),
      originalFilename: input.originalFilename,
    };
  },
  async getObject() {
    throw new Error("not used");
  },
  async headObject() {
    return { exists: false };
  },
  async deleteObject() {},
};

function authConfig(overrides: Partial<Config> = {}): Config {
  return {
    deploymentMode: "authenticated",
    authBaseUrlMode: "explicit",
    authPublicBaseUrl: ORIGIN,
    authDisableSignUp: false,
    ...overrides,
  } as Config;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The whole app, signed in through the real sign-in library against a real
 * database: every refusal below is the one a browser would get.
 */
describeEmbeddedPostgres("new accounts wait for an instance admin", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let server!: Server;
  let port = 0;
  let closeFeeds: (() => void) | null = null;
  const previousSecret = process.env.BETTER_AUTH_SECRET;

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = "account-approval-test-secret";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-account-approval-");
    db = createDb(tempDb.connectionString);
    const auth = createBetterAuthInstance(db, authConfig(), [ORIGIN]);
    const app = await createApp(db, {
      uiMode: "none",
      serverPort: 0,
      storageService: storage,
      deploymentMode: "authenticated",
      // The hostname guard is not under test here.
      deploymentExposure: "public",
      allowedHostnames: [],
      bindHost: "127.0.0.1",
      authReady: true,
      companyDeletionEnabled: false,
      pluginRuntimeEnabled: false,
      betterAuthHandler: createBetterAuthHandler(auth),
      resolveSession: (req) => resolveBetterAuthSession(auth, req),
    });
    server = createServer(app as unknown as Parameters<typeof createServer>[0]);
    const feeds = setupLiveEventsWebSocketServer(server, db, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders: (headers) => resolveBetterAuthSessionFromHeaders(auth, headers),
    });
    closeFeeds = () => (feeds as unknown as { close(): void }).close();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  }, 120_000);

  afterAll(async () => {
    closeFeeds?.();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    _resetLiveEventsForTest();
    await tempDb?.cleanup();
    if (previousSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = previousSecret;
  });

  function anonymous() {
    return request.agent(server).set("Origin", ORIGIN);
  }

  /** Signs a new account up through the sign-in page's own call. */
  async function signUp(name: string) {
    const email = `${name.toLowerCase().replace(/\s+/g, ".")}.${randomUUID().slice(0, 8)}@example.com`;
    const agent = anonymous();
    const res = await agent.post("/api/auth/sign-up/email").send({ name, email, password: PASSWORD });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const cookie = ((res.headers["set-cookie"] ?? []) as unknown as string[])
      .map((value) => value.split(";")[0])
      .join("; ");
    return { agent, userId: res.body.user.id as string, email, name, cookie };
  }

  /** An instance admin from before, so already approved. */
  async function signUpInstanceAdmin(name = "Ada Admin") {
    const admin = await signUp(name);
    await db.update(authUsers).set({ approvalStatus: "approved" }).where(eq(authUsers.id, admin.userId));
    await db.insert(instanceUserRoles).values({ userId: admin.userId, role: "instance_admin" });
    return admin;
  }

  async function signUpApprovedMember(name: string) {
    const member = await signUp(name);
    await db.update(authUsers).set({ approvalStatus: "approved" }).where(eq(authUsers.id, member.userId));
    return member;
  }

  async function accountStatus(userId: string) {
    return db
      .select({ approvalStatus: authUsers.approvalStatus })
      .from(authUsers)
      .where(eq(authUsers.id, userId))
      .then((rows) => rows[0]?.approvalStatus ?? null);
  }

  async function personalCompanyOf(userId: string) {
    return db
      .select({ id: companies.id })
      .from(companies)
      .where(and(eq(companies.kind, "personal"), eq(companies.ownerUserId, userId)))
      .then((rows) => rows[0]?.id ?? null);
  }

  async function seedCompany(name: string) {
    const [company] = await db
      .insert(companies)
      .values({ name, issuePrefix: `A${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}` })
      .returning({ id: companies.id });
    return company!.id;
  }

  async function seedHumanInvite(companyId: string, invitedByUserId: string) {
    const token = `pcp_invite_${randomUUID().replace(/-/g, "")}`;
    await db.insert(invites).values({
      companyId,
      inviteType: "company_join",
      allowedJoinTypes: "human",
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      invitedByUserId,
    });
    return token;
  }

  /** Opens a company's live feed with these cookies: "open", or the refusal. */
  function openFeed(companyId: string, cookie: string): Promise<string> {
    return new Promise((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/companies/${companyId}/events/ws`, {
        headers: { cookie, origin: ORIGIN },
      });
      socket.once("message", () => {
        socket.terminate();
        resolve("open");
      });
      socket.once("error", (err) => resolve(err.message));
    });
  }

  it("lets the account that claims the board skip the wait, as the first account on an instance", async () => {
    // The state a claim challenge is made in: only the local board is an admin.
    await db.delete(instanceUserRoles);
    await db.insert(instanceUserRoles).values({ userId: "local-board", role: "instance_admin" });
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    const claimUrl = new URL(getBoardClaimWarningUrl("127.0.0.1", 3100)!);
    const token = claimUrl.pathname.split("/").pop()!;
    const code = claimUrl.searchParams.get("code")!;

    const first = await signUp("First Owner");
    expect(await accountStatus(first.userId)).toBe("pending");

    await first.agent.get(`/api/board-claim/${token}?code=${code}`).expect(200);
    await first.agent.post(`/api/board-claim/${token}/claim`).send({ code }).expect(200);

    expect(await accountStatus(first.userId)).toBe("approved");
    expect(await personalCompanyOf(first.userId)).not.toBeNull();
    const session = await first.agent.get("/api/auth/get-session").expect(200);
    expect(session.body.accountStatus).toBe("approved");
    await first.agent.get("/api/companies").expect(200);
  });

  it("lets the account that accepts the bootstrap invite skip the wait", async () => {
    const token = `pcp_bootstrap_${randomUUID().replace(/-/g, "")}`;
    await db.insert(invites).values({
      inviteType: "bootstrap_ceo",
      allowedJoinTypes: "human",
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      invitedByUserId: "system",
    });

    const ceo = await signUp("Bootstrap Ceo");
    await ceo.agent.get(`/api/invites/${token}`).expect(200);
    const accepted = await ceo.agent.post(`/api/invites/${token}/accept`).send({ requestType: "human" });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
    expect(accepted.body.bootstrapAccepted).toBe(true);

    expect(await accountStatus(ceo.userId)).toBe("approved");
    expect(await personalCompanyOf(ceo.userId)).not.toBeNull();
    await ceo.agent.get("/api/admin/account-requests").expect(200);
  });

  it("signs a new account in, but refuses it everywhere else, with no Personal company", async () => {
    const pat = await signUp("Pat Waiting");

    const session = await pat.agent.get("/api/auth/get-session").expect(200);
    expect(session.body).toMatchObject({
      user: { id: pat.userId, email: pat.email, name: "Pat Waiting" },
      accountStatus: "pending",
    });

    const refused: Array<[method: "get" | "post" | "patch", path: string, body?: object]> = [
      ["get", "/api/companies"],
      ["post", "/api/companies", { name: "Mine" }],
      // What the app reads to decide what a signed-in person may see.
      ["get", "/api/cli-auth/me"],
      // Clippy, and pairing a chat app to talk to it from.
      ["get", "/api/chat/sessions"],
      ["post", "/api/chat/sessions", {}],
      ["get", "/api/me/channel-links"],
      ["get", "/api/admin/account-requests"],
      ["get", "/api/admin/users"],
      ["get", "/api/instance/settings/general"],
      ["get", "/api/auth/profile"],
      ["patch", "/api/auth/profile", { name: "Renamed" }],
      // The sign-in library's own account calls, other than signing in and out.
      ["get", "/api/auth/list-sessions"],
      ["post", "/api/auth/update-user", { name: "Renamed" }],
      // The agent reference pages, which sit outside /api.
      ["get", "/llms/agent-configuration.txt"],
    ];
    for (const [method, path, body] of refused) {
      const res = body ? await pat.agent[method](path).send(body) : await pat.agent[method](path);
      expect(res.status, `${method.toUpperCase()} ${path}`).toBe(403);
      expect(res.body, `${method.toUpperCase()} ${path}`).toMatchObject({
        error: "Your account is waiting for an admin to approve it.",
        code: WAITING,
      });
    }

    await pat.agent.get("/api/health").expect(200);
    expect(await personalCompanyOf(pat.userId)).toBeNull();

    await pat.agent.post("/api/auth/sign-out").send({}).expect(200);
    await pat.agent.get("/api/auth/get-session").expect(401);
  });

  it("refuses a waiting account CLI sign-in", async () => {
    const pat = await signUp("Pat Cli");
    const challenge = await anonymous()
      .post("/api/cli-auth/challenges")
      .send({ command: "paperclipai auth login" })
      .expect(201);

    const viewed = await pat.agent.get(`/api/cli-auth/challenges/${challenge.body.id}?token=${challenge.body.token}`);
    expect(viewed.status).toBe(403);
    expect(viewed.body.code).toBe(WAITING);
    const approved = await pat.agent
      .post(`/api/cli-auth/challenges/${challenge.body.id}/approve`)
      .send({ token: challenge.body.token });
    expect(approved.status).toBe(403);
    expect(approved.body.code).toBe(WAITING);

    // No key was made, and the one the CLI holds still does nothing.
    const keys = await db.select().from(boardApiKeys).where(eq(boardApiKeys.userId, pat.userId));
    expect(keys).toEqual([]);
    await anonymous()
      .get("/api/companies")
      .set("Authorization", `Bearer ${challenge.body.boardApiToken}`)
      .expect(401);
  });

  it("refuses a board API key that belongs to a waiting account", async () => {
    const pat = await signUp("Pat Key");
    const token = `pcp_board_${randomUUID().replace(/-/g, "")}`;
    await db.insert(boardApiKeys).values({ userId: pat.userId, name: "laptop", keyHash: sha256(token) });

    const res = await anonymous().get("/api/companies").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(WAITING);
  });

  it("gives a waiting account nothing through a paired chat app, so no Clippy there either", async () => {
    const pat = await signUp("Pat Chat");
    expect(await boardActorForLinkedUser(db, pat.userId)).toBeNull();

    await db.update(authUsers).set({ approvalStatus: "approved" }).where(eq(authUsers.id, pat.userId));
    expect(await boardActorForLinkedUser(db, pat.userId)).toMatchObject({ type: "board", userId: pat.userId });
  });

  it("refuses a waiting account the live feed even of a company it belongs to, and opens it once approved", async () => {
    const admin = await signUpInstanceAdmin();
    const pat = await signUp("Pat Feed");
    const companyId = await seedCompany("Feed Co");
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: pat.userId,
      status: "active",
      membershipRole: "operator",
    });

    expect(await openFeed(companyId, pat.cookie)).toBe("Unexpected server response: 403");

    await admin.agent.post(`/api/admin/account-requests/${pat.userId}/approve`).send({}).expect(200);

    expect(await openFeed(companyId, pat.cookie)).toBe("open");
  });

  it("shows instance admins the waiting accounts and lets them approve one, which gets its Personal company", async () => {
    const admin = await signUpInstanceAdmin();
    const pat = await signUp("Pat Approve");
    expect(await personalCompanyOf(pat.userId)).toBeNull();

    const list = await admin.agent.get("/api/admin/account-requests").expect(200);
    const entry = (list.body as Array<{ id: string }>).find((row) => row.id === pat.userId);
    expect(entry).toEqual({
      id: pat.userId,
      name: "Pat Approve",
      email: pat.email,
      requestedAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse((entry as { requestedAt: string }).requestedAt))).toBe(false);
    // Only waiting accounts are listed, the admin's own approved one is not.
    expect((list.body as Array<{ id: string }>).some((row) => row.id === admin.userId)).toBe(false);

    const approved = await admin.agent.post(`/api/admin/account-requests/${pat.userId}/approve`).send({});
    expect(approved.status).toBe(200);
    expect(approved.body).toEqual({ id: pat.userId, status: "approved" });

    const row = await db.select().from(authUsers).where(eq(authUsers.id, pat.userId)).then((rows) => rows[0]!);
    expect(row.approvalStatus).toBe("approved");
    expect(row.approvalDecidedByUserId).toBe(admin.userId);
    expect(row.approvalDecidedAt).toBeInstanceOf(Date);
    const personalId = await personalCompanyOf(pat.userId);
    expect(personalId).not.toBeNull();

    // In, on the very session it signed up with.
    const session = await pat.agent.get("/api/auth/get-session").expect(200);
    expect(session.body.accountStatus).toBe("approved");
    const mine = await pat.agent.get("/api/companies").expect(200);
    expect((mine.body as Array<{ id: string }>).map((company) => company.id)).toContain(personalId);

    const after = await admin.agent.get("/api/admin/account-requests").expect(200);
    expect((after.body as Array<{ id: string }>).some((rowItem) => rowItem.id === pat.userId)).toBe(false);
    // A second click, or a second admin, finds it done.
    await admin.agent.post(`/api/admin/account-requests/${pat.userId}/approve`).send({}).expect(200);
    await admin.agent.post(`/api/admin/account-requests/${pat.userId}/decline`).send({}).expect(409);
  });

  it("lets only instance admins see, approve or decline waiting accounts", async () => {
    const member = await signUpApprovedMember("Olive Member");
    const companyId = await seedCompany("Member Co");
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: member.userId,
      status: "active",
      membershipRole: "owner",
    });
    const pat = await signUp("Pat Only Admins");

    await member.agent.get("/api/admin/account-requests").expect(403);
    await member.agent.post(`/api/admin/account-requests/${pat.userId}/approve`).send({}).expect(403);
    await member.agent.post(`/api/admin/account-requests/${pat.userId}/decline`).send({}).expect(403);
    await anonymous().get("/api/admin/account-requests").expect(403);
    await anonymous().post(`/api/admin/account-requests/${pat.userId}/approve`).send({}).expect(403);

    // Nor can a waiting account let itself in.
    const self = await pat.agent.post(`/api/admin/account-requests/${pat.userId}/approve`).send({});
    expect(self.status).toBe(403);
    expect(self.body.code).toBe(WAITING);

    expect(await accountStatus(pat.userId)).toBe("pending");
    expect(await personalCompanyOf(pat.userId)).toBeNull();
  });

  it("declines an account: it leaves the list, is signed out, cannot sign in again, and cannot sign up again", async () => {
    const admin = await signUpInstanceAdmin();
    const dan = await signUp("Dan Declined");

    const declined = await admin.agent.post(`/api/admin/account-requests/${dan.userId}/decline`).send({});
    expect(declined.status).toBe(200);
    expect(declined.body).toEqual({ id: dan.userId, status: "declined" });

    const list = await admin.agent.get("/api/admin/account-requests").expect(200);
    expect((list.body as Array<{ id: string }>).some((row) => row.id === dan.userId)).toBe(false);
    const users = await admin.agent.get("/api/admin/users").expect(200);
    expect((users.body as Array<{ id: string }>).some((row) => row.id === dan.userId)).toBe(false);

    // Signed out on the spot.
    await dan.agent.get("/api/auth/get-session").expect(401);

    // The right password is refused, and says why.
    const signIn = await anonymous().post("/api/auth/sign-in/email").send({ email: dan.email, password: PASSWORD });
    expect(signIn.status).toBe(403);
    expect(signIn.body).toMatchObject({
      message: "An admin declined this account, so it cannot sign in.",
      code: "ACCOUNT_DECLINED",
    });
    // A wrong one learns nothing about the decision.
    const guess = await anonymous().post("/api/auth/sign-in/email").send({ email: dan.email, password: "not the password" });
    expect(guess.status).toBe(401);
    expect(JSON.stringify(guess.body)).not.toContain("declined");

    // The address cannot come back as a fresh request.
    const again = await anonymous()
      .post("/api/auth/sign-up/email")
      .send({ name: "Dan Again", email: dan.email, password: PASSWORD });
    expect(again.status).toBe(422);

    expect(await personalCompanyOf(dan.userId)).toBeNull();
    await admin.agent.post(`/api/admin/account-requests/${dan.userId}/approve`).send({}).expect(409);
    await admin.agent.post(`/api/admin/account-requests/${dan.userId}/decline`).send({}).expect(200);
    await admin.agent.post(`/api/admin/account-requests/no-such-user/approve`).send({}).expect(404);
  });

  it("lets an account in when it accepts an invite an instance admin sent", async () => {
    const admin = await signUpInstanceAdmin();
    const companyId = await seedCompany("Admin Invite Co");
    const token = await seedHumanInvite(companyId, admin.userId);

    const newcomer = await signUp("Nia Invited");
    await newcomer.agent.get(`/api/invites/${token}`).expect(200);
    const accepted = await newcomer.agent.post(`/api/invites/${token}/accept`).send({ requestType: "human" });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);

    expect(await accountStatus(newcomer.userId)).toBe("approved");
    expect(await personalCompanyOf(newcomer.userId)).not.toBeNull();
    await newcomer.agent.get("/api/companies").expect(200);
  });

  it("keeps an account waiting when it accepts an invite from someone who is not an instance admin", async () => {
    const owner = await signUpApprovedMember("Otto Owner");
    const companyId = await seedCompany("Owner Invite Co");
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: owner.userId,
      status: "active",
      membershipRole: "owner",
    });
    const token = await seedHumanInvite(companyId, owner.userId);

    const newcomer = await signUp("Nate Invited");
    const accepted = await newcomer.agent.post(`/api/invites/${token}/accept`).send({ requestType: "human" });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
    // The request to join the company is made all the same.
    expect(accepted.body).toMatchObject({ requestType: "human", status: "pending_approval" });

    expect(await accountStatus(newcomer.userId)).toBe("pending");
    expect(await personalCompanyOf(newcomer.userId)).toBeNull();
    const refused = await newcomer.agent.get("/api/companies");
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe(WAITING);
  });
});

describe("turning sign-up off", () => {
  it("still refuses every new account, as it did before approvals", async () => {
    const previousSecret = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = "account-approval-test-secret";
    try {
      // Refused before the database is ever asked.
      const auth = createBetterAuthInstance({} as ReturnType<typeof createDb>, authConfig({ authDisableSignUp: true }), [ORIGIN]);
      const app = express();
      app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));

      const res = await request(app)
        .post("/api/auth/sign-up/email")
        .set("Origin", ORIGIN)
        .send({ name: "Nobody", email: "nobody@example.com", password: PASSWORD });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Email and password sign up is not enabled");
    } finally {
      if (previousSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = previousSecret;
    }
  });
});
