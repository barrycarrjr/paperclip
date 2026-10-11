import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  agentApiKeys,
  agents,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
} from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import {
  _resetLiveEventsForTest,
  LIVE_EVENTS_BOOT_ID,
  publishLiveEvent,
} from "../services/live-events.js";
import { loadPersonalCompanyIndex } from "../services/personal-companies.js";
import { invalidatePortfolioRootCache } from "../services/portfolio-root-cache.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres live feed privacy tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type FeedMessage = { kind?: string; id?: number; companyId?: string };

// Alice owns a Personal company and is also an HQ admin, so she can open the
// portfolio feed. Bob is an HQ owner and Carol an instance administrator with
// an ordinary seat in HQ; neither of them owns Alice's Personal. Dan is an
// instance administrator with no seat anywhere. Erin is an instance
// administrator and an HQ admin who does not own Alice's Personal either. The
// owner of this instance is an instance administrator, an HQ owner, and the
// owner of his own Personal.
const ALICE = "user-alice";
const BOB = "user-bob";
const CAROL = "user-carol";
const DAN = "user-dan";
const ERIN = "user-erin";
const OWNER = "user-owner";
const HQ_AGENT_TOKEN = "hq-agent-live-feed-token";

/**
 * A Personal company is private to the person it belongs to. The live feeds
 * must keep that promise as the REST routes do, the portfolio feed above all,
 * because it exists to carry every company's events to HQ.
 */
describeEmbeddedPostgres("live event feeds and Personal companies", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const servers: Server[] = [];
  const closeFeedServers: Array<() => void> = [];
  const openSockets = new Set<WebSocket>();
  let authenticatedPort = 0;
  let localTrustedPort = 0;
  let hqId!: string;
  let acmeId!: string;
  let alicePersonalId!: string;
  let ownerPersonalId!: string;

  async function startFeedServer(deploymentMode: DeploymentMode): Promise<number> {
    const server = createServer();
    const wss = setupLiveEventsWebSocketServer(server, db, {
      deploymentMode,
      // Stands in for the sign-in cookie: the test names the user directly.
      resolveSessionFromHeaders: async (headers) => {
        const userId = headers.get("x-test-user");
        return userId ? { session: { id: `session-${userId}`, userId }, user: { id: userId } } : null;
      },
    });
    servers.push(server);
    closeFeedServers.push(() => (wss as unknown as { close(): void }).close());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-live-feed-personal-");
    db = createDb(tempDb.connectionString);
    authenticatedPort = await startFeedServer("authenticated");
    localTrustedPort = await startFeedServer("local_trusted");
  }, 90_000);

  // Also run before each test: the migrations seed an HQ company of their own,
  // and there can only be one.
  async function clearTables() {
    await db.delete(agentApiKeys);
    await db.delete(agents);
    await db.delete(instanceUserRoles);
    await db.delete(companyMemberships);
    await db.delete(companies);
  }

  beforeEach(async () => {
    _resetLiveEventsForTest();
    await clearTables();
    hqId = randomUUID();
    acmeId = randomUUID();
    alicePersonalId = randomUUID();
    ownerPersonalId = randomUUID();

    await db.insert(companies).values([
      { id: hqId, name: "HQ", issuePrefix: "HQF", isPortfolioRoot: true },
      { id: acmeId, name: "Acme", issuePrefix: "ACF" },
      { id: alicePersonalId, name: "Personal", issuePrefix: "MEF", kind: "personal", ownerUserId: ALICE },
      { id: ownerPersonalId, name: "Personal", issuePrefix: "ME2F", kind: "personal", ownerUserId: OWNER },
    ]);
    await db.insert(companyMemberships).values([
      { companyId: hqId, principalType: "user", principalId: BOB, status: "active", membershipRole: "owner" },
      { companyId: hqId, principalType: "user", principalId: ALICE, status: "active", membershipRole: "admin" },
      // An instance administrator needs a seat in HQ to watch its feed, as the
      // REST portfolio routes require.
      { companyId: hqId, principalType: "user", principalId: CAROL, status: "active", membershipRole: "viewer" },
      { companyId: hqId, principalType: "user", principalId: OWNER, status: "active", membershipRole: "owner" },
      { companyId: hqId, principalType: "user", principalId: ERIN, status: "active", membershipRole: "admin" },
      {
        companyId: alicePersonalId,
        principalType: "user",
        principalId: ALICE,
        status: "active",
        membershipRole: "owner",
      },
      {
        companyId: ownerPersonalId,
        principalType: "user",
        principalId: OWNER,
        status: "active",
        membershipRole: "owner",
      },
    ]);
    await db.insert(instanceUserRoles).values([
      { userId: CAROL, role: "instance_admin" },
      { userId: DAN, role: "instance_admin" },
      { userId: ERIN, role: "instance_admin" },
      { userId: OWNER, role: "instance_admin" },
    ]);
    const [hqAgent] = await db
      .insert(agents)
      .values({ companyId: hqId, name: "HQ analyst" })
      .returning({ id: agents.id });
    await db.insert(agentApiKeys).values({
      agentId: hqAgent!.id,
      companyId: hqId,
      name: "live feed test",
      keyHash: createHash("sha256").update(HQ_AGENT_TOKEN).digest("hex"),
    });

    await loadPersonalCompanyIndex(db);
    invalidatePortfolioRootCache();
  });

  afterEach(async () => {
    for (const socket of openSockets) socket.terminate();
    openSockets.clear();
    _resetLiveEventsForTest();
    await clearTables();
    invalidatePortfolioRootCache();
  });

  afterAll(async () => {
    for (const close of closeFeedServers) close();
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await tempDb?.cleanup();
  });

  /** Opens a feed, resolving with its messages once the hello frame is in. */
  function openFeed(
    path: string,
    headers: Record<string, string>,
    port = authenticatedPort,
  ): Promise<FeedMessage[]> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
      openSockets.add(socket);
      const messages: FeedMessage[] = [];
      socket.on("message", (data) => {
        const message = JSON.parse(String(data)) as FeedMessage;
        messages.push(message);
        if (message.kind === "hello") resolve(messages);
      });
      socket.on("error", reject);
    });
  }

  const portfolioFeed = () => `/api/companies/${hqId}/portfolio-events/ws`;
  const companyFeed = (companyId: string) => `/api/companies/${companyId}/events/ws`;
  const replayFromStart = `?since=0&boot=${LIVE_EVENTS_BOOT_ID}`;
  const asUser = (userId: string) => ({ "x-test-user": userId });
  const eventCompanies = (messages: FeedMessage[]) =>
    messages.filter((message) => typeof message.id === "number").map((message) => message.companyId);
  const eventIds = (messages: FeedMessage[]) =>
    messages.filter((message) => typeof message.id === "number").map((message) => message.id);

  // The ordinary company's event is published after the private one, and one
  // socket delivers in order, so once it has arrived a leak would be there too.
  function publishPrivateThenOrdinary() {
    publishLiveEvent({
      companyId: alicePersonalId,
      type: "activity.logged",
      payload: { entityType: "issue", title: "Alice's private plans" },
    });
    publishLiveEvent({ companyId: acmeId, type: "activity.logged", payload: { entityType: "issue" } });
  }

  const nonOwners: Array<[string, () => Record<string, string>]> = [
    ["an HQ agent", () => ({ authorization: `Bearer ${HQ_AGENT_TOKEN}` })],
    ["an HQ admin who is not the owner", () => asUser(BOB)],
    ["an instance administrator who is not the owner", () => asUser(CAROL)],
  ];

  describe("the portfolio feed", () => {
    it.each(nonOwners)("keeps a Personal company's events from %s, live", async (_who, headers) => {
      const messages = await openFeed(portfolioFeed(), headers());
      publishPrivateThenOrdinary();

      await vi.waitFor(() => expect(eventCompanies(messages)).toContain(acmeId));
      expect(eventCompanies(messages)).not.toContain(alicePersonalId);
    });

    it.each(nonOwners)("keeps a Personal company's events from %s, on replay", async (_who, headers) => {
      publishPrivateThenOrdinary();
      const messages = await openFeed(`${portfolioFeed()}${replayFromStart}`, headers());

      await vi.waitFor(() => expect(eventCompanies(messages)).toContain(acmeId));
      expect(eventCompanies(messages)).not.toContain(alicePersonalId);
    });

    it("does not make HQ start over because of a busy company it cannot see", async () => {
      // Enough of Alice's events to push her oldest out of the replay buffer.
      // Her company is not HQ's to see, so it must not turn HQ's catch-up
      // into a full reload either.
      for (let i = 0; i < 320; i += 1) {
        publishLiveEvent({ companyId: alicePersonalId, type: "activity.logged", payload: { i } });
      }
      publishLiveEvent({ companyId: acmeId, type: "activity.logged", payload: {} });

      const messages = await openFeed(`${portfolioFeed()}${replayFromStart}`, asUser(BOB));

      await vi.waitFor(() => expect(eventCompanies(messages)).toEqual([acmeId]));
      expect(messages.some((message) => message.kind === "resync")).toBe(false);
    });

    it("still gives the owner her own Personal company's events, live and on replay", async () => {
      const before = publishLiveEvent({ companyId: alicePersonalId, type: "activity.logged", payload: {} });
      const messages = await openFeed(`${portfolioFeed()}${replayFromStart}`, asUser(ALICE));
      const live = publishLiveEvent({ companyId: alicePersonalId, type: "activity.logged", payload: {} });

      await vi.waitFor(() => expect(eventIds(messages)).toEqual([before.id, live.id]));
    });

    it("still gives the single local operator everything, as the company access check does", async () => {
      const messages = await openFeed(portfolioFeed(), {}, localTrustedPort);
      const event = publishLiveEvent({ companyId: alicePersonalId, type: "activity.logged", payload: {} });

      await vi.waitFor(() => expect(eventIds(messages)).toEqual([event.id]));
    });

    it("refuses an instance administrator with no seat in HQ, as the REST portfolio routes do", async () => {
      await expect(openFeed(portfolioFeed(), asUser(DAN))).rejects.toThrow(/403/);
    });
  });

  describe("a single company's feed", () => {
    it.each([
      ["an HQ admin who is not the owner", BOB],
      ["an instance administrator who is not the owner", CAROL],
    ])("refuses %s the feed of someone's Personal company", async (_who, userId) => {
      await expect(openFeed(companyFeed(alicePersonalId), asUser(userId))).rejects.toThrow(/403/);
    });

    it.each([
      ["an HQ admin who is not the owner", BOB],
      // Erin, not Carol: Carol has only a viewer seat in HQ, so she is
      // refused for that alone, and the case would no longer test the id.
      ["an instance administrator and HQ admin who is not the owner", ERIN],
    ])("refuses %s that feed with the company id in capitals and braces", async (_who, userId) => {
      // Postgres reads that id as the same company. The feed must not depend
      // on events happening to be routed by the exact string.
      await expect(
        openFeed(companyFeed(`{${alicePersonalId.toUpperCase()}}`), asUser(userId)),
      ).rejects.toThrow(/403/);
    });

    it("opens a Personal company's feed to its owner", async () => {
      const messages = await openFeed(companyFeed(alicePersonalId), asUser(ALICE));
      const event = publishLiveEvent({ companyId: alicePersonalId, type: "activity.logged", payload: {} });

      await vi.waitFor(() => expect(eventIds(messages)).toEqual([event.id]));
    });

    it("still lets an HQ admin follow an ordinary company without a membership there", async () => {
      const messages = await openFeed(companyFeed(acmeId), asUser(BOB));
      const event = publishLiveEvent({ companyId: acmeId, type: "activity.logged", payload: {} });

      await vi.waitFor(() => expect(eventIds(messages)).toEqual([event.id]));
    });

    it("refuses an instance administrator with no seat an ordinary company's feed, as REST does", async () => {
      await expect(openFeed(companyFeed(acmeId), asUser(DAN))).rejects.toThrow(/403/);
    });
  });

  describe("the owner of this instance", () => {
    it("still gets HQ's feed with his own Personal in it, any company's feed, and his own Personal's", async () => {
      const hq = await openFeed(portfolioFeed(), asUser(OWNER));
      const acme = await openFeed(companyFeed(acmeId), asUser(OWNER));
      const own = await openFeed(companyFeed(ownerPersonalId), asUser(OWNER));
      const his = publishLiveEvent({ companyId: ownerPersonalId, type: "activity.logged", payload: {} });
      publishLiveEvent({ companyId: alicePersonalId, type: "activity.logged", payload: {} });
      const ordinary = publishLiveEvent({ companyId: acmeId, type: "activity.logged", payload: {} });

      await vi.waitFor(() => expect(eventIds(hq)).toEqual([his.id, ordinary.id]));
      await vi.waitFor(() => expect(eventIds(acme)).toEqual([ordinary.id]));
      await vi.waitFor(() => expect(eventIds(own)).toEqual([his.id]));
    });
  });
});
