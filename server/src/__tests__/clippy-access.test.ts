import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  authUsers,
  chatSessions,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { calendarRoutes } from "../routes/calendar.js";
import { chatRoutes } from "../routes/chat.js";
import { internalMcpRoutes } from "../routes/internal-mcp.js";
import { loadPersonalCompanyIndex } from "../services/personal-companies.js";
import { createPluginMcpBridge, setPluginMcpBridge, type PluginMcpBridge } from "../services/plugin-mcp-bridge.js";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import { _setPortfolioRootCacheForTesting } from "../services/portfolio-root-cache.js";

/**
 * Clippy acts as the person chatting and never does more than they could do
 * themselves. Run through the real actor middleware, chat routes and calendar
 * routes against a real database:
 *
 * - a chat session is refused for, or moved to, a company the person cannot
 *   use, and refused again on the next turn once their access is gone;
 * - Clippy's key is checked on every request against the person's access as
 *   it is then: a viewer's key reads but does not write, HQ's read across
 *   companies needs an HQ owner or admin, and someone else's Personal stays
 *   shut;
 * - models that run on the server are for instance admins only.
 *
 * Only the model is a stand-in, so a turn starts no program and calls no API.
 */

const models = vi.hoisted(() => ({
  native: "claude-opus-5-5",
  server: "adapter:claude_local:claude-opus-5-5",
}));

/** The bridge addresses the stand-in model was handed, and whether its next turn fails. */
const turns = vi.hoisted(() => ({ bridgeUrls: [] as string[], fail: false }));

vi.mock("../services/chat-providers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/chat-providers.js")>();
  // A server model's stand-in is named "adapter", as Claude Code's provider
  // is, so its turn is handed a plugin bridge token the way a real one is.
  const standIn = (name: "anthropic" | "adapter") => ({
    name,
    isConfigured: () => true,
    supportsModel: () => true,
    defaultModel: () => models.native,
    listModels: () => [models.native],
    async *streamTurn(input: { adapterContext?: { pluginMcpUrl?: string } }) {
      if (input.adapterContext?.pluginMcpUrl) turns.bridgeUrls.push(input.adapterContext.pluginMcpUrl);
      if (turns.fail) throw new Error("The model stopped answering.");
      yield { type: "text_delta" as const, delta: "Two invoices are due." };
      return {
        content: [{ type: "text" as const, text: "Two invoices are due." }],
        stopReason: "end_turn" as const,
      };
    },
  });
  const native = standIn("anthropic");
  const server = standIn("adapter");
  return {
    ...actual,
    getProviderForModel: (model: string) => (model.startsWith("adapter:") ? server : native),
    listAvailableModels: async () => [
      { provider: "anthropic", model: models.native },
      { provider: "adapter", model: models.server, source: "claude_local" },
    ],
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Clippy access tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const OWNER = "user-owner";
const BOB = "user-bob";

const REMINDER = {
  title: "Call the accountant",
  scheduleKind: "once",
  channels: ["desktop"],
  anchorAt: "2026-11-03T09:00:00-05:00",
};

describeEmbeddedPostgres("Clippy acts as the person, never more (HTTP, real database)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  let bridge!: PluginMcpBridge;
  const previousSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;

  let acme = "";
  let globex = "";
  let hq = "";
  let bobPersonal = "";

  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "clippy-access-test-secret";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-clippy-access-");
    db = createDb(tempDb.connectionString);

    acme = await seedCompany("Acme");
    globex = await seedCompany("Globex");
    // A new database already has its HQ.
    const [root] = await db.select({ id: companies.id }).from(companies).where(eq(companies.isPortfolioRoot, true));
    hq = root?.id ?? (await seedCompany("HQ", { isPortfolioRoot: true }));
    // The owner: an instance admin and HQ's owner, a member of no other company.
    await seedUser(OWNER, { instanceAdmin: true, memberships: [[hq, "owner"]] });
    await seedUser(BOB);
    bobPersonal = await seedCompany("Personal", { personalOwner: BOB });
    await addMembership(BOB, bobPersonal, "owner");
    await loadPersonalCompanyIndex(db);
    _setPortfolioRootCacheForTesting(hq);

    app = express();
    app.use(express.json());
    app.use(
      actorMiddleware(db, {
        deploymentMode: "authenticated",
        // A signed-in browser, named by a header so each request can be anyone.
        resolveSession: async (req) => {
          const userId = req.header("x-test-user");
          return userId
            ? { session: { id: `session-${userId}`, userId }, user: { id: userId, name: userId, email: null } }
            : null;
        },
      }),
    );
    // The plugin bridge Claude Code calls Clippy's tools through, and its
    // address, which answers anyone holding a token.
    bridge = createPluginMcpBridge({
      pluginToolDispatcher: {
        listToolsForAgent: async () => [],
        executeTool: async () => ({ result: { content: "" } }),
      } as unknown as PluginToolDispatcher,
      db,
    });
    setPluginMcpBridge(bridge);
    app.use("/api", chatRoutes(db, { pluginMcpBridge: bridge }));
    app.use("/api", calendarRoutes(db));
    app.use("/api", internalMcpRoutes());
    app.use(errorHandler);
  }, 90_000);

  afterAll(async () => {
    setPluginMcpBridge(null);
    _setPortfolioRootCacheForTesting(undefined);
    await tempDb?.cleanup();
    if (previousSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousSecret;
  });

  async function seedCompany(name: string, opts: { isPortfolioRoot?: boolean; personalOwner?: string } = {}) {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name,
      issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      isPortfolioRoot: opts.isPortfolioRoot ?? false,
      ...(opts.personalOwner ? { kind: "personal", ownerUserId: opts.personalOwner } : {}),
    });
    return id;
  }

  async function seedUser(
    userId: string,
    opts: { instanceAdmin?: boolean; memberships?: Array<[companyId: string, role: string]> } = {},
  ) {
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}@example.com`, createdAt: now, updatedAt: now });
    if (opts.instanceAdmin) await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
    for (const [companyId, role] of opts.memberships ?? []) await addMembership(userId, companyId, role);
    return userId;
  }

  /** A fresh person for one test, so a change to their access touches nothing else. */
  function newPerson(memberships: Array<[companyId: string, role: string]>) {
    return seedUser(`user-${randomUUID()}`, { memberships });
  }

  async function addMembership(userId: string, companyId: string, role: string) {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: role,
    });
  }

  function membershipOf(userId: string, companyId: string) {
    return and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId),
    );
  }

  /** Clippy's key for a chat in `companyId`, made the way a turn makes it. */
  function clippyKey(userId: string, companyId: string): string {
    const token = createLocalAgentJwt(`clippy-${randomUUID()}`, companyId, "claude_local", randomUUID(), { userId });
    if (!token) throw new Error("no agent JWT secret");
    return token;
  }

  const readEvents = (key: string, companyId: string) =>
    request(app).get(`/api/companies/${companyId}/events`).set("Authorization", `Bearer ${key}`);
  const addEvent = (key: string, companyId: string) =>
    request(app).post(`/api/companies/${companyId}/events`).set("Authorization", `Bearer ${key}`).send(REMINDER);

  const createChat = (userId: string, body: Record<string, unknown>) =>
    request(app).post("/api/chat/sessions").set("x-test-user", userId).send(body);
  const patchChat = (userId: string, id: string, body: Record<string, unknown>) =>
    request(app).patch(`/api/chat/sessions/${id}`).set("x-test-user", userId).send(body);
  const sendMessage = (userId: string, id: string) =>
    request(app).post(`/api/chat/sessions/${id}/messages`).set("x-test-user", userId).send({ text: "What is due?" });

  /** A chat made before these rules, straight into the table. */
  async function existingChat(userId: string, companyId: string | null, model: string) {
    const [row] = await db
      .insert(chatSessions)
      .values({ boardUserId: userId, companyId, title: "Older chat", mode: "agent", permissionMode: "bypass", model })
      .returning();
    return row!.id;
  }

  describe("which company a chat may run in", () => {
    it("refuses a viewer of one company a chat in another, but lets them chat where they can read", async () => {
      const viewer = await newPerson([[acme, "viewer"]]);

      const elsewhere = await createChat(viewer, { companyId: globex, model: models.native });
      expect(elsewhere.status).toBe(403);
      expect(elsewhere.body.error).toBe("User does not have access to this company");

      const own = await createChat(viewer, { companyId: acme, model: models.native });
      expect(own.status, JSON.stringify(own.body)).toBe(201);

      // Moving that chat to the other company is refused the same way.
      const moved = await patchChat(viewer, own.body.session.id, { companyId: globex });
      expect(moved.status).toBe(403);
      const stored = await db.select().from(chatSessions).where(eq(chatSessions.id, own.body.session.id));
      expect(stored[0]?.companyId).toBe(acme);
    });

    it("refuses a chat in HQ to someone who is not in HQ", async () => {
      const outsider = await newPerson([[acme, "member"]]);
      const res = await createChat(outsider, { companyId: hq, model: models.native });
      expect(res.status).toBe(403);
    });

    it("refuses a chat in someone else's Personal, even to an instance admin", async () => {
      const res = await createChat(OWNER, { companyId: bobPersonal, model: models.native });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("This is someone's personal company");
    });

    it("refuses the next turn once the person's access is gone", async () => {
      const member = await newPerson([[acme, "member"]]);
      const chat = await createChat(member, { companyId: acme, model: models.native });
      expect(chat.status).toBe(201);
      const first = await sendMessage(member, chat.body.session.id);
      expect(first.status).toBe(200);
      expect(first.text).toContain("Two invoices are due.");

      await db.delete(companyMemberships).where(membershipOf(member, acme));

      const next = await sendMessage(member, chat.body.session.id);
      expect(next.status).toBe(403);
      expect(next.body.error).toBe("User does not have access to this company");
    });

    it("keeps working for an ordinary member, for the owner anywhere but someone's Personal, and for Bob in his own", async () => {
      const member = await newPerson([[acme, "member"]]);
      const memberChat = await createChat(member, { companyId: acme, model: models.native });
      expect(memberChat.status).toBe(201);
      expect((await sendMessage(member, memberChat.body.session.id)).status).toBe(200);

      // An instance admin may use any company but someone else's Personal, as
      // Clippy's own tools always allowed, including one they are not a member of.
      for (const companyId of [globex, hq]) {
        const ownerChat = await createChat(OWNER, { companyId, model: models.native });
        expect(ownerChat.status, JSON.stringify(ownerChat.body)).toBe(201);
        expect((await sendMessage(OWNER, ownerChat.body.session.id)).status).toBe(200);
      }

      const bobChat = await createChat(BOB, { companyId: bobPersonal, model: models.native });
      expect(bobChat.status).toBe(201);
      expect((await sendMessage(BOB, bobChat.body.session.id)).status).toBe(200);
    });
  });

  describe("what Clippy's key may do, checked on every request", () => {
    it("lets a viewer's key read their company but not change it", async () => {
      const viewer = await newPerson([[acme, "viewer"]]);
      const key = clippyKey(viewer, acme);

      expect((await readEvents(key, acme)).status).toBe(200);
      const write = await addEvent(key, acme);
      expect(write.status).toBe(403);
      expect(write.body.error).toBe("Viewer access is read-only");
    });

    it("gives a key for a company the person is not in nothing there", async () => {
      // As a chat scoped there before this fix would have made it.
      const viewer = await newPerson([[acme, "viewer"]]);
      const key = clippyKey(viewer, globex);

      expect((await readEvents(key, globex)).status).toBe(403);
      expect((await addEvent(key, globex)).status).toBe(403);
    });

    it("gives a key scoped to HQ no read across companies unless the person is HQ's owner or admin", async () => {
      const hqMember = await newPerson([[hq, "member"]]);
      const memberKey = clippyKey(hqMember, hq);
      expect((await readEvents(memberKey, hq)).status).toBe(200);
      expect((await readEvents(memberKey, globex)).status).toBe(403);

      const outsider = await newPerson([[acme, "member"]]);
      expect((await readEvents(clippyKey(outsider, hq), globex)).status).toBe(403);

      // The owner keeps it: read across, but no writing there.
      const ownerKey = clippyKey(OWNER, hq);
      expect((await readEvents(ownerKey, globex)).status).toBe(200);
      expect((await addEvent(ownerKey, globex)).status).toBe(403);
    });

    it("follows a change of role or a removal at once, not when the key expires", async () => {
      const member = await newPerson([[acme, "member"]]);
      const key = clippyKey(member, acme);
      expect((await addEvent(key, acme)).status).toBe(201);

      await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(membershipOf(member, acme));
      const asViewer = await addEvent(key, acme);
      expect(asViewer.status).toBe(403);
      expect(asViewer.body.error).toBe("Viewer access is read-only");
      expect((await readEvents(key, acme)).status).toBe(200);

      await db.delete(companyMemberships).where(membershipOf(member, acme));
      expect((await readEvents(key, acme)).status).toBe(403);
    });

    it("keeps the owner's allowance in a company they are not a member of, and keeps everyone out of someone else's Personal", async () => {
      expect((await addEvent(clippyKey(OWNER, globex), globex)).status).toBe(201);

      expect((await readEvents(clippyKey(OWNER, bobPersonal), bobPersonal)).status).toBe(403);
      const bobKey = clippyKey(BOB, bobPersonal);
      expect((await readEvents(bobKey, bobPersonal)).status).toBe(200);
      expect((await addEvent(bobKey, bobPersonal)).status).toBe(201);
    });
  });

  describe("the plugin bridge token a Claude Code turn is handed", () => {
    // The bridge judges every call on the access the person had when the
    // token was made, and its address answers anyone holding the token, so
    // the token must not outlive the turn it was made for.
    it("stops working when the turn ends, with a reply or with an error", async () => {
      const chat = await createChat(OWNER, { companyId: hq, model: models.server });
      expect(chat.status, JSON.stringify(chat.body)).toBe(201);

      for (const ending of ["a reply", "an error"]) {
        turns.bridgeUrls.length = 0;
        turns.fail = ending === "an error";
        try {
          expect((await sendMessage(OWNER, chat.body.session.id)).status).toBe(200);
        } finally {
          turns.fail = false;
        }
        const token = turns.bridgeUrls[0]?.split("/").pop();
        expect(token, `the turn ending with ${ending} was handed a bridge token`).toBeTruthy();

        const afterTurn = await request(app)
          .post(`/api/internal/mcp/${token}`)
          .set("Accept", "application/json, text/event-stream")
          .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
        expect(afterTurn.status, `after a turn ending with ${ending}`).toBe(401);
        expect(bridge.resolveToken(token!)).toBeNull();
      }
    });
  });

  describe("models that run on the server are for instance admins", () => {
    it("refuses one to anyone else when a chat is made or its model changed", async () => {
      const member = await newPerson([[acme, "member"]]);

      const created = await createChat(member, { companyId: acme, model: models.server });
      expect(created.status).toBe(403);
      expect(created.body.error).toBe("Only instance admins can use models that run on this server.");

      const chat = await createChat(member, { companyId: acme, model: models.native });
      expect(chat.status).toBe(201);
      const changed = await patchChat(member, chat.body.session.id, { model: models.server });
      expect(changed.status).toBe(403);
      const stored = await db.select().from(chatSessions).where(eq(chatSessions.id, chat.body.session.id));
      expect(stored[0]?.model).toBe(models.native);
    });

    it("stops a chat already on one at the next turn, with a plain refusal", async () => {
      const member = await newPerson([[acme, "member"]]);
      const chatId = await existingChat(member, acme, models.server);

      const res = await sendMessage(member, chatId);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Only instance admins can use models that run on this server.");

      // Moving it onto another model is still allowed, and then it works.
      expect((await patchChat(member, chatId, { model: models.native })).status).toBe(200);
      expect((await sendMessage(member, chatId)).status).toBe(200);
    });

    it("keeps them working for an instance admin", async () => {
      const created = await createChat(OWNER, { companyId: hq, model: models.server });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const turn = await sendMessage(OWNER, created.body.session.id);
      expect(turn.status).toBe(200);
      expect(turn.text).toContain("Two invoices are due.");

      const chat = await createChat(OWNER, { companyId: hq, model: models.native });
      expect((await patchChat(OWNER, chat.body.session.id, { model: models.server })).status).toBe(200);
      expect((await sendMessage(OWNER, await existingChat(OWNER, hq, models.server))).status).toBe(200);
    });

    it("offers them in the model picker to instance admins only", async () => {
      const member = await newPerson([[acme, "member"]]);
      const offered = await request(app).get("/api/chat/models").set("x-test-user", member);
      expect(offered.status).toBe(200);
      expect(offered.body.models.map((m: { model: string }) => m.model)).toEqual([models.native]);

      const forOwner = await request(app).get("/api/chat/models").set("x-test-user", OWNER);
      expect(forOwner.body.models.map((m: { model: string }) => m.model)).toEqual([models.native, models.server]);
    });
  });
});
