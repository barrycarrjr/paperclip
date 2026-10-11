import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  documentRevisions,
  documents,
  spacePages,
  spaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { spaceRoutes } from "../routes/spaces.js";

/**
 * The Spaces routes against a real database: the real router, validation,
 * access checks and service, with the actor stamped on each request the way
 * the auth middleware would.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Spaces route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const ELEVEN_MINUTES_MS = 11 * 60 * 1000;

describeEmbeddedPostgres("Spaces routes (HTTP)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-spaces-routes-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(spacePages);
    await db.delete(spaces);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  /** A signed-in person with the given role in one company. */
  function person(userId: string, companyId: string, membershipRole = "owner"): Record<string, unknown> {
    return {
      type: "board",
      userId,
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
      memberships: [{ companyId, status: "active", membershipRole }],
    };
  }

  function agent(companyId: string): Record<string, unknown> {
    return { type: "agent", agentId: randomUUID(), companyId, source: "agent_key", runId: randomUUID() };
  }

  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", spaceRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function createSpace(app: express.Express, companyId: string, name = "Handbook") {
    const res = await request(app).post(`/api/companies/${companyId}/spaces`).send({ name });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; urlKey: string };
  }

  async function createPage(
    app: express.Express,
    spaceId: string,
    page: { title: string; body?: string; parentPageId?: string },
  ) {
    const res = await request(app).post(`/api/spaces/${spaceId}/pages`).send(page);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; documentId: string; latestRevisionId: string; latestRevisionNumber: number };
  }

  function revisionsOf(documentId: string) {
    return db.select().from(documentRevisions).where(eq(documentRevisions.documentId, documentId));
  }

  it("creates Spaces, lists them with their page counts and finds one by its address", async () => {
    const companyId = await seedCompany();
    const app = createApp(person("user-a", companyId));

    const created = await request(app)
      .post(`/api/companies/${companyId}/spaces`)
      .send({ name: "Sales Handbook", description: "How we sell" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ name: "Sales Handbook", urlKey: "sales-handbook", description: "How we sell" });

    // The same name again gets an address of its own.
    const second = await createSpace(app, companyId, "Sales handbook");
    expect(second.urlKey).toBe("sales-handbook-2");
    await createPage(app, second.id, { title: "Pricing" });

    const list = await request(app).get(`/api/companies/${companyId}/spaces`);
    expect(list.status).toBe(200);
    expect(list.body.map((space: { urlKey: string; pageCount: number }) => [space.urlKey, space.pageCount])).toEqual([
      ["sales-handbook", 0],
      ["sales-handbook-2", 1],
    ]);

    const byKey = await request(app).get(`/api/companies/${companyId}/spaces/sales-handbook`);
    expect(byKey.status).toBe(200);
    expect(byKey.body.id).toBe(created.body.id);
    const byId = await request(app).get(`/api/companies/${companyId}/spaces/${second.id}`);
    expect(byId.body.urlKey).toBe("sales-handbook-2");
    expect((await request(app).get(`/api/companies/${companyId}/spaces/no-such-space`)).status).toBe(404);
  });

  it("renames a Space, changes its description and order, and keeps its address", async () => {
    const companyId = await seedCompany();
    const app = createApp(person("user-a", companyId));
    const first = await createSpace(app, companyId, "Rules");
    const second = await createSpace(app, companyId, "Notes");

    const res = await request(app)
      .patch(`/api/spaces/${first.id}`)
      .send({ name: "Standing rules", description: "What agents follow", sortOrder: 5 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ name: "Standing rules", description: "What agents follow", urlKey: "rules", sortOrder: 5 });

    const list = await request(app).get(`/api/companies/${companyId}/spaces`);
    expect(list.body.map((space: { id: string }) => space.id)).toEqual([second.id, first.id]);
  });

  it("nests pages and subpages to any depth, in the order they were made", async () => {
    const companyId = await seedCompany();
    const app = createApp(person("user-a", companyId));
    const space = await createSpace(app, companyId);
    const other = await createSpace(app, companyId, "Other");

    const intro = await createPage(app, space.id, { title: "Introduction" });
    const people = await createPage(app, space.id, { title: "People" });
    const hiring = await createPage(app, space.id, { title: "Hiring", parentPageId: people.id });
    const interviews = await createPage(app, space.id, { title: "Interviews", parentPageId: hiring.id });
    const onboarding = await createPage(app, space.id, { title: "Onboarding", parentPageId: people.id });

    const tree = await request(app).get(`/api/spaces/${space.id}/pages`);
    expect(tree.status).toBe(200);
    type Node = { id: string; title: string; children: Node[] };
    const shape = (nodes: Node[]): unknown => nodes.map((node) => [node.title, shape(node.children)]);
    expect(shape(tree.body)).toEqual([
      ["Introduction", []],
      ["People", [["Hiring", [["Interviews", []]]], ["Onboarding", []]]],
    ]);
    expect(tree.body[1].children[0].children[0].id).toBe(interviews.id);
    expect([intro.id, onboarding.id]).toEqual([tree.body[0].id, tree.body[1].children[1].id]);

    // A parent has to be a page of the same Space.
    const elsewhere = await request(app)
      .post(`/api/spaces/${other.id}/pages`)
      .send({ title: "Stray", parentPageId: people.id });
    expect(elsewhere.status).toBe(422);
  });

  it("reads a page with its text and the version it is on", async () => {
    const companyId = await seedCompany();
    const app = createApp(person("user-a", companyId));
    const space = await createSpace(app, companyId);
    const page = await createPage(app, space.id, { title: "Refunds", body: "# Refunds\n\nWithin 30 days." });

    const res = await request(app).get(`/api/spaces/${space.id}/pages/${page.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      title: "Refunds",
      body: "# Refunds\n\nWithin 30 days.",
      format: "markdown",
      latestRevisionNumber: 1,
      latestRevisionId: page.latestRevisionId,
      createdByUserId: "user-a",
    });
    expect((await request(app).get(`/api/spaces/${space.id}/pages/${randomUUID()}`)).status).toBe(404);
    expect((await request(app).get(`/api/spaces/${space.id}/pages/not-a-page`)).status).toBe(404);
  });

  it("saves a change written on the page's current version as a new version", async () => {
    const companyId = await seedCompany();
    const author = createApp(person("user-a", companyId));
    const editor = createApp(person("user-b", companyId, "operator"));
    const space = await createSpace(author, companyId);
    const page = await createPage(author, space.id, { title: "Refunds", body: "Within 30 days." });

    const saved = await request(editor)
      .patch(`/api/spaces/${space.id}/pages/${page.id}`)
      .send({ title: "Refund policy", body: "Within 60 days.", baseRevisionId: page.latestRevisionId });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ title: "Refund policy", body: "Within 60 days.", latestRevisionNumber: 2 });
    expect(saved.body.latestRevisionId).not.toBe(page.latestRevisionId);
    expect(saved.body.updatedByUserId).toBe("user-b");
    expect((await revisionsOf(page.documentId)).map((row) => row.revisionNumber).sort()).toEqual([1, 2]);

    // Saving the same text again makes no version.
    const unchanged = await request(editor)
      .patch(`/api/spaces/${space.id}/pages/${page.id}`)
      .send({ body: "Within 60 days.", baseRevisionId: saved.body.latestRevisionId });
    expect(unchanged.status).toBe(200);
    expect(unchanged.body.latestRevisionId).toBe(saved.body.latestRevisionId);
    expect(await revisionsOf(page.documentId)).toHaveLength(2);
  });

  it("refuses a save written on an older version with 409 and the version the page is on", async () => {
    const companyId = await seedCompany();
    const author = createApp(person("user-a", companyId));
    const editor = createApp(person("user-b", companyId, "operator"));
    const space = await createSpace(author, companyId);
    const page = await createPage(author, space.id, { title: "Refunds", body: "Within 30 days." });

    const theirs = await request(editor)
      .patch(`/api/spaces/${space.id}/pages/${page.id}`)
      .send({ body: "Within 60 days.", baseRevisionId: page.latestRevisionId });
    expect(theirs.status).toBe(200);

    const mine = await request(author)
      .patch(`/api/spaces/${space.id}/pages/${page.id}`)
      .send({ body: "Within 14 days.", baseRevisionId: page.latestRevisionId });
    expect(mine.status).toBe(409);
    expect(mine.body.details).toEqual({
      currentRevisionId: theirs.body.latestRevisionId,
      currentRevisionNumber: 2,
    });

    const now = await request(author).get(`/api/spaces/${space.id}/pages/${page.id}`);
    expect(now.body.body).toBe("Within 60 days.");
  });

  it("folds one person's saves within 10 minutes into one version, with a new id each time", async () => {
    const companyId = await seedCompany();
    const app = createApp(person("user-a", companyId));
    const space = await createSpace(app, companyId);
    const page = await createPage(app, space.id, { title: "Notes", body: "a" });
    const save = (body: string, baseRevisionId: string) =>
      request(app).patch(`/api/spaces/${space.id}/pages/${page.id}`).send({ body, baseRevisionId });

    const first = await save("ab", page.latestRevisionId);
    expect(first.status).toBe(200);
    expect(first.body.latestRevisionNumber).toBe(1);
    expect(first.body.latestRevisionId).not.toBe(page.latestRevisionId);
    const afterFirst = await revisionsOf(page.documentId);
    expect(afterFirst.map((row) => [row.id, row.revisionNumber, row.body])).toEqual([
      [first.body.latestRevisionId, 1, "ab"],
    ]);

    // The id the fold replaced no longer passes the check.
    const stale = await save("abc", page.latestRevisionId);
    expect(stale.status).toBe(409);
    expect(stale.body.details.currentRevisionId).toBe(first.body.latestRevisionId);

    const second = await save("abc", first.body.latestRevisionId);
    expect(second.status).toBe(200);
    expect(second.body.latestRevisionNumber).toBe(1);
    expect(second.body.latestRevisionId).not.toBe(first.body.latestRevisionId);

    // More than 10 minutes after the last save, the next one is a new version.
    await db
      .update(documentRevisions)
      .set({ createdAt: new Date(Date.now() - ELEVEN_MINUTES_MS) })
      .where(eq(documentRevisions.id, second.body.latestRevisionId));
    const later = await save("abcd", second.body.latestRevisionId);
    expect(later.status).toBe(200);
    expect(later.body.latestRevisionNumber).toBe(2);
    const revisions = await revisionsOf(page.documentId);
    expect(revisions.map((row) => [row.revisionNumber, row.body]).sort()).toEqual([
      [1, "abc"],
      [2, "abcd"],
    ]);

    // The activity log has one entry per version, not one per autosave.
    const logged = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.action, "space.page_updated"), eq(activityLog.entityId, page.id)));
    expect(logged).toHaveLength(1);
  });

  it("makes a second save of the same page wait for the first, then refuses it", async () => {
    const companyId = await seedCompany();
    const author = createApp(person("user-a", companyId));
    const space = await createSpace(author, companyId);
    const page = await createPage(author, space.id, { title: "Triage", body: "v1" });

    // Another save holds the page's row and has written version 2, but has
    // not finished yet.
    let rowHeld!: () => void;
    const holdingRow = new Promise<void>((resolve) => { rowHeld = resolve; });
    let letOtherSaveFinish!: () => void;
    const otherSaveMayFinish = new Promise<void>((resolve) => { letOtherSaveFinish = resolve; });
    let otherRevisionId = "";
    const otherSave = db.transaction(async (tx) => {
      await tx.execute(sql`select ${spacePages.id} from ${spacePages} where ${spacePages.id} = ${page.id} for update`);
      const [revision] = await tx
        .insert(documentRevisions)
        .values({
          companyId,
          documentId: page.documentId,
          revisionNumber: 2,
          title: "Triage",
          format: "markdown",
          body: "theirs",
          createdByUserId: "user-b",
        })
        .returning();
      await tx
        .update(documents)
        .set({ latestBody: "theirs", latestRevisionId: revision.id, latestRevisionNumber: 2 })
        .where(eq(documents.id, page.documentId));
      otherRevisionId = revision.id;
      rowHeld();
      await otherSaveMayFinish;
    });
    await holdingRow;

    const mine = request(createApp(person("user-c", companyId, "operator")))
      .patch(`/api/spaces/${space.id}/pages/${page.id}`)
      .send({ body: "mine", baseRevisionId: page.latestRevisionId })
      .then((res) => res);
    // Long enough for this save to reach the page's row and wait there.
    await new Promise((resolve) => setTimeout(resolve, 400));
    letOtherSaveFinish();
    await otherSave;

    const res = await mine;
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details.currentRevisionId).toBe(otherRevisionId);
    const now = await request(author).get(`/api/spaces/${space.id}/pages/${page.id}`);
    expect(now.body.body).toBe("theirs");
  });

  it("lets a viewer read Spaces and pages but not change them", async () => {
    const companyId = await seedCompany();
    const owner = createApp(person("user-a", companyId));
    const viewer = createApp(person("user-v", companyId, "viewer"));
    const space = await createSpace(owner, companyId);
    const page = await createPage(owner, space.id, { title: "Refunds", body: "Within 30 days." });

    expect((await request(viewer).get(`/api/companies/${companyId}/spaces`)).status).toBe(200);
    expect((await request(viewer).get(`/api/spaces/${space.id}/pages`)).status).toBe(200);
    const read = await request(viewer).get(`/api/spaces/${space.id}/pages/${page.id}`);
    expect(read.status).toBe(200);
    expect(read.body.body).toBe("Within 30 days.");

    expect((await request(viewer).post(`/api/companies/${companyId}/spaces`).send({ name: "Mine" })).status).toBe(403);
    expect((await request(viewer).patch(`/api/spaces/${space.id}`).send({ name: "Renamed" })).status).toBe(403);
    expect((await request(viewer).post(`/api/spaces/${space.id}/pages`).send({ title: "New" })).status).toBe(403);
    const edit = await request(viewer)
      .patch(`/api/spaces/${space.id}/pages/${page.id}`)
      .send({ body: "Within 90 days.", baseRevisionId: page.latestRevisionId });
    expect(edit.status).toBe(403);
    expect(await revisionsOf(page.documentId)).toHaveLength(1);

    // Someone from another company gets nothing.
    const outsider = createApp(person("user-x", randomUUID()));
    expect((await request(outsider).get(`/api/spaces/${space.id}/pages/${page.id}`)).status).toBe(403);
  });

  it("refuses agents and Clippy sessions, even in their own company", async () => {
    const companyId = await seedCompany();
    const owner = createApp(person("user-a", companyId));
    const space = await createSpace(owner, companyId);
    const page = await createPage(owner, space.id, { title: "Refunds", body: "Within 30 days." });

    for (const actor of [
      agent(companyId),
      { type: "tool_session", userId: "user-a", companyId, source: "tool_session_jwt" },
    ]) {
      const app = createApp(actor);
      const label = String(actor.type);
      expect((await request(app).get(`/api/companies/${companyId}/spaces`)).status, label).toBe(403);
      expect((await request(app).get(`/api/spaces/${space.id}/pages`)).status, label).toBe(403);
      expect((await request(app).get(`/api/spaces/${space.id}/pages/${page.id}`)).status, label).toBe(403);
      expect((await request(app).post(`/api/companies/${companyId}/spaces`).send({ name: "Agent's" })).status, label).toBe(403);
      expect((await request(app).post(`/api/spaces/${space.id}/pages`).send({ title: "New" })).status, label).toBe(403);
      const edit = await request(app)
        .patch(`/api/spaces/${space.id}/pages/${page.id}`)
        .send({ body: "Changed", baseRevisionId: page.latestRevisionId });
      expect(edit.status, label).toBe(403);
      expect(edit.body.error).toBe("Spaces are open to people only for now");
    }
    expect(await revisionsOf(page.documentId)).toHaveLength(1);
  });
});
