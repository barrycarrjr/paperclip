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
import { SPACE_ARCHIVED_MESSAGE, SPACE_PAGE_MOVE_LOOP_MESSAGE } from "../services/spaces.js";

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

  /** A page's versions as [number, text, summary], oldest first. */
  async function versionsOf(documentId: string) {
    return (await revisionsOf(documentId))
      .sort((a, b) => a.revisionNumber - b.revisionNumber)
      .map((row) => [row.revisionNumber, row.body, row.changeSummary]);
  }

  type TreeNode = { id: string; title: string; children: TreeNode[] };
  const shapeOf = (nodes: TreeNode[]): unknown => nodes.map((node) => [node.title, shapeOf(node.children)]);

  /** A Space's page tree as nested [title, children]. */
  async function treeOf(app: express.Express, spaceId: string) {
    const res = await request(app).get(`/api/spaces/${spaceId}/pages`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return shapeOf(res.body);
  }

  function move(
    app: express.Express,
    spaceId: string,
    pageId: string,
    to: { spaceId?: string; parentPageId: string | null; index?: number },
  ) {
    return request(app).post(`/api/spaces/${spaceId}/pages/${pageId}/move`).send(to);
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

  it("takes accents off a name's letters for its address, and falls back to space", async () => {
    const companyId = await seedCompany();
    const app = createApp(person("user-a", companyId));

    expect((await createSpace(app, companyId, "Café Règles")).urlKey).toBe("cafe-regles");
    expect((await createSpace(app, companyId, "Señor Ölçü Naïve")).urlKey).toBe("senor-olcu-naive");
    expect((await createSpace(app, companyId, "Руководство")).urlKey).toBe("space");
    expect((await createSpace(app, companyId, "!!!")).urlKey).toBe("space-2");
  });

  it("finds a Space by its id before any Space whose address is that id", async () => {
    const companyId = await seedCompany();
    const app = createApp(person("user-a", companyId));
    const original = await createSpace(app, companyId, "Original");
    const named = await createSpace(app, companyId, original.id);
    expect(named.urlKey).toBe(original.id);

    const res = await request(app).get(`/api/companies/${companyId}/spaces/${original.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(original.id);
    expect(res.body.name).toBe("Original");
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

    // More than 10 minutes after the version's first save, the next one is a new version.
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

  /** Moves a page's whole history back, as if this much time had passed since. */
  async function letTimePass(documentId: string, minutes: number) {
    await db
      .update(documentRevisions)
      .set({ createdAt: sql`${documentRevisions.createdAt} - make_interval(mins => ${minutes})` })
      .where(eq(documentRevisions.documentId, documentId));
  }

  it("starts a new version after 10 minutes of one person's writing, however close the saves", async () => {
    const companyId = await seedCompany();
    const app = createApp(person("user-a", companyId));
    const space = await createSpace(app, companyId);
    const page = await createPage(app, space.id, { title: "Notes", body: "Before today" });
    await letTimePass(page.documentId, 60);

    // Saves 9 minutes apart for 27 minutes.
    let base = page.latestRevisionId;
    for (const [index, body] of ["Hour 1", "Hour 1 and 2", "Hour 1, 2 and 3", ""].entries()) {
      if (index > 0) await letTimePass(page.documentId, 9);
      const res = await request(app)
        .patch(`/api/spaces/${space.id}/pages/${page.id}`)
        .send({ body, baseRevisionId: base });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      base = res.body.latestRevisionId;
    }

    // A slip at the end (the page wiped) leaves the earlier writing restorable.
    const revisions = (await revisionsOf(page.documentId))
      .map((row) => [row.revisionNumber, row.body])
      .sort((a, b) => Number(a[0]) - Number(b[0]));
    expect(revisions).toEqual([
      [1, "Before today"],
      [2, "Hour 1 and 2"],
      [3, ""],
    ]);
  });

  it("keeps both versions when a person keeps their own text over their other tab's save", async () => {
    const companyId = await seedCompany();
    const app = createApp(person("user-a", companyId));
    const space = await createSpace(app, companyId);
    const page = await createPage(app, space.id, { title: "Plan", body: "v1" });
    await letTimePass(page.documentId, 30);
    const save = (body: string, baseRevisionId: string, keepPrevious?: boolean) =>
      request(app)
        .patch(`/api/spaces/${space.id}/pages/${page.id}`)
        .send({ body, baseRevisionId, ...(keepPrevious ? { keepPrevious } : {}) });

    // Tab one (or the phone) saves first.
    const tabOne = await save("Plan A, written in tab one", page.latestRevisionId);
    expect(tabOne.body.latestRevisionNumber).toBe(2);
    // Tab two still holds version 1, so its save is refused and it offers the choice.
    expect((await save("Plan B, written in tab two", page.latestRevisionId)).status).toBe(409);
    // "Keep mine": tab two's text on top of version 2, less than 10 minutes after it.
    const keep = await save("Plan B, written in tab two", tabOne.body.latestRevisionId, true);
    expect(keep.status).toBe(200);
    expect(keep.body.latestRevisionNumber).toBe(3);

    const revisions = (await revisionsOf(page.documentId))
      .map((row) => [row.revisionNumber, row.body])
      .sort((a, b) => Number(a[0]) - Number(b[0]));
    expect(revisions).toEqual([
      [1, "v1"],
      [2, "Plan A, written in tab one"],
      [3, "Plan B, written in tab two"],
    ]);
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

      // Part 2's routes too: history, move, trash, archive and the page lookup.
      const pagePath = `/api/spaces/${space.id}/pages/${page.id}`;
      const refused = [
        request(app).get(`${pagePath}/revisions`),
        request(app).get(`${pagePath}/revisions/${page.latestRevisionId}`),
        request(app).post(`${pagePath}/revisions/${page.latestRevisionId}/restore`).send({ baseRevisionId: page.latestRevisionId }),
        request(app).post(`${pagePath}/move`).send({ parentPageId: null, index: 0 }),
        request(app).delete(pagePath),
        request(app).get(`/api/spaces/${space.id}/trash`),
        request(app).post(`/api/spaces/${space.id}/trash/${page.id}/restore`),
        request(app).patch(`/api/spaces/${space.id}`).send({ archived: true }),
        request(app).get(`/api/companies/${companyId}/space-pages/${page.id}`),
      ];
      for (const res of await Promise.all(refused)) {
        expect(res.status, `${label} ${res.req.method} ${res.req.path}`).toBe(403);
      }
    }
    expect(await revisionsOf(page.documentId)).toHaveLength(1);
    expect(await treeOf(owner, space.id)).toEqual([["Refunds", []]]);
  });

  it("tells someone who is not signed in to sign in, rather than that Spaces are for people", async () => {
    const companyId = await seedCompany();
    const app = createApp({ type: "none", source: "none" });

    expect((await request(app).get(`/api/companies/${companyId}/spaces`)).status).toBe(401);
    expect((await request(app).post(`/api/companies/${companyId}/spaces`).send({ name: "Rules" })).status).toBe(401);
    expect((await request(app).get(`/api/spaces/${randomUUID()}/pages`)).status).toBe(401);
  });

  // The activity feed, a person's profile and the live feed are open to every
  // agent of the company, and to HQ's agents, which Spaces are not.
  it("keeps names, descriptions and page titles out of Spaces activity rows", async () => {
    const companyId = await seedCompany();
    const owner = createApp(person("user-a", companyId));
    const editor = createApp(person("user-b", companyId, "operator"));
    const created = await request(owner)
      .post(`/api/companies/${companyId}/spaces`)
      .send({ name: "Layoffs 2027", description: "Who goes in Q1 and why" });
    expect(created.status).toBe(201);
    const renamed = await request(owner)
      .patch(`/api/spaces/${created.body.id}`)
      .send({ name: "Restructuring 2027", description: "Final list: Ann, Bob" });
    expect(renamed.status).toBe(200);
    const page = await createPage(owner, created.body.id, { title: "Ann Smith severance terms", body: "Private" });
    const saved = await request(editor)
      .patch(`/api/spaces/${created.body.id}/pages/${page.id}`)
      .send({ title: "Ann Smith, final terms", body: "Private, changed", baseRevisionId: page.latestRevisionId });
    expect(saved.status).toBe(200);

    const rows = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const logged = JSON.stringify(rows.map((row) => row.details));
    for (const words of ["Layoffs", "layoffs", "Restructuring", "Who goes", "Final list", "Ann Smith", "Private"]) {
      expect(logged, words).not.toContain(words);
    }
    const detailsOf = (action: string) => rows.find((row) => row.action === action)?.details;
    expect(detailsOf("space.created")).toEqual({ spaceId: created.body.id });
    expect(detailsOf("space.updated")).toEqual({ spaceId: created.body.id, changed: ["name", "description"] });
    expect(detailsOf("space.page_created")).toEqual({ spaceId: created.body.id, pageId: page.id, parentPageId: null });
    expect(detailsOf("space.page_updated")).toEqual({ spaceId: created.body.id, pageId: page.id, revisionNumber: 2 });
  });

  describe("history", () => {
    it("lists a page's versions newest first with who made each, shows any one, and lets a viewer read but not restore", async () => {
      const companyId = await seedCompany();
      const owner = createApp(person("user-a", companyId));
      const editor = createApp(person("user-b", companyId, "operator"));
      const viewer = createApp(person("user-v", companyId, "viewer"));
      const space = await createSpace(owner, companyId);
      const page = await createPage(owner, space.id, { title: "Refunds", body: "Within 30 days." });
      const other = await createPage(owner, space.id, { title: "Other" });
      const saved = await request(editor)
        .patch(`/api/spaces/${space.id}/pages/${page.id}`)
        .send({ title: "Refund policy", body: "Within 60 days.", baseRevisionId: page.latestRevisionId });
      expect(saved.status).toBe(200);

      const list = await request(viewer).get(`/api/spaces/${space.id}/pages/${page.id}/revisions`);
      expect(list.status).toBe(200);
      expect(list.body.map((row: Record<string, unknown>) => [row.revisionNumber, row.title, row.createdByUserId])).toEqual([
        [2, "Refund policy", "user-b"],
        [1, "Refunds", "user-a"],
      ]);
      // The list leaves the text out; it comes one version at a time.
      expect(list.body[0]).not.toHaveProperty("body");

      const first = await request(viewer).get(`/api/spaces/${space.id}/pages/${page.id}/revisions/${list.body[1].id}`);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ revisionNumber: 1, title: "Refunds", body: "Within 30 days." });
      // Another page's version is not this page's.
      expect((await request(viewer).get(`/api/spaces/${space.id}/pages/${page.id}/revisions/${other.latestRevisionId}`)).status).toBe(404);

      const restore = await request(viewer)
        .post(`/api/spaces/${space.id}/pages/${page.id}/revisions/${list.body[1].id}/restore`)
        .send({ baseRevisionId: saved.body.latestRevisionId });
      expect(restore.status).toBe(403);
      expect(await revisionsOf(page.documentId)).toHaveLength(2);
    });

    it("restores a version as a new one on top that never folds, through the same version check as a save", async () => {
      const companyId = await seedCompany();
      const app = createApp(person("user-a", companyId));
      const space = await createSpace(app, companyId);
      const page = await createPage(app, space.id, { title: "Plan", body: "v1" });
      await letTimePass(page.documentId, 30);
      const pagePath = `/api/spaces/${space.id}/pages/${page.id}`;
      const second = await request(app).patch(pagePath).send({ body: "v2", baseRevisionId: page.latestRevisionId });
      expect(second.body.latestRevisionNumber).toBe(2);

      // Straight after the same person's own save, which a plain save would fold into.
      const restored = await request(app)
        .post(`${pagePath}/revisions/${page.latestRevisionId}/restore`)
        .send({ baseRevisionId: second.body.latestRevisionId });
      expect(restored.status, JSON.stringify(restored.body)).toBe(200);
      expect(restored.body).toMatchObject({ title: "Plan", body: "v1", latestRevisionNumber: 3 });
      // Nor does the next save fold into the restore.
      const edited = await request(app).patch(pagePath).send({ body: "v1, edited", baseRevisionId: restored.body.latestRevisionId });
      expect(edited.body.latestRevisionNumber).toBe(4);
      expect(await versionsOf(page.documentId)).toEqual([
        [1, "v1", null],
        [2, "v2", null],
        [3, "v1", "Restored version 1"],
        [4, "v1, edited", null],
      ]);

      // Written on a page that has moved on since: refused, like a save.
      const stale = await request(app)
        .post(`${pagePath}/revisions/${page.latestRevisionId}/restore`)
        .send({ baseRevisionId: second.body.latestRevisionId });
      expect(stale.status).toBe(409);
      expect(stale.body.details.currentRevisionId).toBe(edited.body.latestRevisionId);
      expect(await revisionsOf(page.documentId)).toHaveLength(4);

      const logged = await db.select().from(activityLog).where(eq(activityLog.action, "space.page_version_restored"));
      expect(logged.map((row) => row.details)).toEqual([
        { spaceId: space.id, pageId: page.id, revisionNumber: 3, restoredFromRevisionNumber: 1 },
      ]);
    });
  });

  it("archives a Space: it leaves the list, still opens by its address, and refuses every change until unarchived", async () => {
    const companyId = await seedCompany();
    const app = createApp(person("user-a", companyId));
    const space = await createSpace(app, companyId, "Old rules");
    const current = await createSpace(app, companyId, "Current rules");
    const page = await createPage(app, space.id, { title: "Refunds", body: "v1" });
    const trashed = await createPage(app, space.id, { title: "Draft" });
    const elsewhere = await createPage(app, current.id, { title: "Elsewhere" });
    expect((await request(app).delete(`/api/spaces/${space.id}/pages/${trashed.id}`)).status).toBe(200);

    const archived = await request(app).patch(`/api/spaces/${space.id}`).send({ archived: true });
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    expect(archived.body.archivedAt).not.toBeNull();

    const listed = async (query = "") =>
      (await request(app).get(`/api/companies/${companyId}/spaces${query}`)).body.map((row: { id: string }) => row.id);
    expect(await listed()).toEqual([current.id]);
    expect(await listed("?archived=true")).toEqual([space.id]);

    // Still opens and reads.
    expect((await request(app).get(`/api/companies/${companyId}/spaces/old-rules`)).status).toBe(200);
    expect(await treeOf(app, space.id)).toEqual([["Refunds", []]]);
    expect((await request(app).get(`/api/spaces/${space.id}/pages/${page.id}`)).status).toBe(200);
    expect((await request(app).get(`/api/spaces/${space.id}/pages/${page.id}/revisions`)).status).toBe(200);
    expect((await request(app).get(`/api/spaces/${space.id}/trash`)).body).toHaveLength(1);

    const pagePath = `/api/spaces/${space.id}/pages/${page.id}`;
    const refused = {
      rename: request(app).patch(`/api/spaces/${space.id}`).send({ name: "Renamed" }),
      addPage: request(app).post(`/api/spaces/${space.id}/pages`).send({ title: "New" }),
      save: request(app).patch(pagePath).send({ body: "v2", baseRevisionId: page.latestRevisionId }),
      restoreVersion: request(app).post(`${pagePath}/revisions/${page.latestRevisionId}/restore`).send({ baseRevisionId: page.latestRevisionId }),
      reorder: move(app, space.id, page.id, { parentPageId: null, index: 0 }),
      moveOut: move(app, space.id, page.id, { spaceId: current.id, parentPageId: null }),
      moveIn: move(app, current.id, elsewhere.id, { spaceId: space.id, parentPageId: null }),
      delete: request(app).delete(pagePath),
      restoreFromTrash: request(app).post(`/api/spaces/${space.id}/trash/${trashed.id}/restore`),
    };
    for (const [name, pending] of Object.entries(refused)) {
      const res = await pending;
      expect(res.status, name).toBe(422);
      expect(res.body.error, name).toBe(SPACE_ARCHIVED_MESSAGE);
    }
    expect(await versionsOf(page.documentId)).toEqual([[1, "v1", null]]);
    expect(await treeOf(app, current.id)).toEqual([["Elsewhere", []]]);

    const unarchived = await request(app).patch(`/api/spaces/${space.id}`).send({ archived: false });
    expect(unarchived.status).toBe(200);
    expect(unarchived.body.archivedAt).toBeNull();
    expect((await request(app).patch(`/api/spaces/${space.id}`).send({ name: "Renamed" })).status).toBe(200);
    expect(await listed()).toEqual([space.id, current.id]);

    const logged = await db.select().from(activityLog).where(eq(activityLog.entityId, space.id));
    expect(logged.map((row) => [row.action, row.details]).filter(([action]) => action !== "space.created")).toEqual(
      expect.arrayContaining([
        ["space.archived", { spaceId: space.id }],
        ["space.unarchived", { spaceId: space.id }],
        ["space.updated", { spaceId: space.id, changed: ["name"] }],
      ]),
    );
  });

  describe("order and move", () => {
    it("puts pages in order under the same parent, without an activity row", async () => {
      const companyId = await seedCompany();
      const app = createApp(person("user-a", companyId));
      const space = await createSpace(app, companyId);
      const a = await createPage(app, space.id, { title: "A" });
      await createPage(app, space.id, { title: "B" });
      const c = await createPage(app, space.id, { title: "C" });

      expect((await move(app, space.id, c.id, { parentPageId: null, index: 0 })).status).toBe(200);
      expect(await treeOf(app, space.id)).toEqual([["C", []], ["A", []], ["B", []]]);
      expect((await move(app, space.id, a.id, { parentPageId: null, index: 2 })).status).toBe(200);
      expect(await treeOf(app, space.id)).toEqual([["C", []], ["B", []], ["A", []]]);
      // Past the end is the end.
      expect((await move(app, space.id, c.id, { parentPageId: null, index: 99 })).status).toBe(200);
      expect(await treeOf(app, space.id)).toEqual([["B", []], ["A", []], ["C", []]]);

      expect(await db.select().from(activityLog).where(eq(activityLog.action, "space.page_moved"))).toHaveLength(0);
    });

    it("moves a page with its subpages under another page, to the top level, and to another Space of the company", async () => {
      const companyId = await seedCompany();
      const app = createApp(person("user-a", companyId));
      const space = await createSpace(app, companyId);
      const other = await createSpace(app, companyId, "Other");
      const intro = await createPage(app, space.id, { title: "Intro" });
      const people = await createPage(app, space.id, { title: "People" });
      const hiring = await createPage(app, space.id, { title: "Hiring", parentPageId: people.id });
      const interviews = await createPage(app, space.id, { title: "Interviews", parentPageId: hiring.id });

      expect((await move(app, space.id, hiring.id, { parentPageId: intro.id })).status).toBe(200);
      expect(await treeOf(app, space.id)).toEqual([["Intro", [["Hiring", [["Interviews", []]]]]], ["People", []]]);

      const top = await move(app, space.id, hiring.id, { parentPageId: null });
      expect(top.status).toBe(200);
      expect(top.body).toMatchObject({ id: hiring.id, spaceId: space.id, parentPageId: null });
      expect(await treeOf(app, space.id)).toEqual([["Intro", []], ["People", []], ["Hiring", [["Interviews", []]]]]);

      const across = await move(app, space.id, hiring.id, { spaceId: other.id, parentPageId: null });
      expect(across.status, JSON.stringify(across.body)).toBe(200);
      expect(across.body).toMatchObject({ spaceId: other.id, parentPageId: null });
      expect(await treeOf(app, space.id)).toEqual([["Intro", []], ["People", []]]);
      expect(await treeOf(app, other.id)).toEqual([["Hiring", [["Interviews", []]]]]);
      // The subpage went too, so its old Space no longer has it.
      expect((await request(app).get(`/api/spaces/${other.id}/pages/${interviews.id}`)).status).toBe(200);
      expect((await request(app).get(`/api/spaces/${space.id}/pages/${interviews.id}`)).status).toBe(404);

      // And under a page of the other Space, at the front of its subpages.
      expect((await move(app, space.id, intro.id, { spaceId: other.id, parentPageId: hiring.id, index: 0 })).status).toBe(200);
      expect(await treeOf(app, other.id)).toEqual([["Hiring", [["Intro", []], ["Interviews", []]]]]);

      const logged = await db.select().from(activityLog).where(eq(activityLog.action, "space.page_moved"));
      expect(logged.map((row) => row.details)).toEqual(
        expect.arrayContaining([
          { spaceId: other.id, pageId: hiring.id, parentPageId: null, fromSpaceId: space.id, fromParentPageId: null },
          { spaceId: other.id, pageId: intro.id, parentPageId: hiring.id, fromSpaceId: space.id, fromParentPageId: null },
        ]),
      );
      expect(logged).toHaveLength(4);
    });

    it("refuses a move into the page's own subpages, to another company, or under a page of another Space", async () => {
      const companyId = await seedCompany();
      const app = createApp(person("user-a", companyId));
      const space = await createSpace(app, companyId);
      const other = await createSpace(app, companyId, "Other");
      const people = await createPage(app, space.id, { title: "People" });
      const hiring = await createPage(app, space.id, { title: "Hiring", parentPageId: people.id });
      const interviews = await createPage(app, space.id, { title: "Interviews", parentPageId: hiring.id });
      const elsewhere = await createPage(app, other.id, { title: "Elsewhere" });

      for (const parentPageId of [people.id, hiring.id, interviews.id]) {
        const res = await move(app, space.id, people.id, { parentPageId });
        expect(res.status).toBe(422);
        expect(res.body.error).toBe(SPACE_PAGE_MOVE_LOOP_MESSAGE);
      }
      // Under a page of another Space while staying in this one.
      expect((await move(app, space.id, hiring.id, { parentPageId: elsewhere.id })).status).toBe(422);

      // Another company's Space, even for someone in both companies.
      const otherCompanyId = await seedCompany();
      const both = createApp({
        ...person("user-a", companyId),
        companyIds: [companyId, otherCompanyId],
        memberships: [
          { companyId, status: "active", membershipRole: "owner" },
          { companyId: otherCompanyId, status: "active", membershipRole: "owner" },
        ],
      });
      const foreign = await createSpace(both, otherCompanyId, "Foreign");
      expect((await move(both, space.id, hiring.id, { spaceId: foreign.id, parentPageId: null })).status).toBe(422);
      expect((await move(both, space.id, hiring.id, { spaceId: randomUUID(), parentPageId: null })).status).toBe(422);

      // A viewer cannot move anything.
      const viewer = createApp(person("user-v", companyId, "viewer"));
      expect((await move(viewer, space.id, hiring.id, { parentPageId: null })).status).toBe(403);

      expect(await treeOf(app, space.id)).toEqual([["People", [["Hiring", [["Interviews", []]]]]]]);
      expect(await treeOf(both, foreign.id)).toEqual([]);
    });

    it("does not let two moves at the same moment make a loop between them", async () => {
      const companyId = await seedCompany();
      const app = createApp(person("user-a", companyId));
      const space = await createSpace(app, companyId);
      const a = await createPage(app, space.id, { title: "A" });
      const b = await createPage(app, space.id, { title: "B" });

      // Another move holds the Space and has put A under B, but has not
      // finished yet.
      let held!: () => void;
      const holding = new Promise<void>((resolve) => { held = resolve; });
      let letItFinish!: () => void;
      const mayFinish = new Promise<void>((resolve) => { letItFinish = resolve; });
      const otherMove = db.transaction(async (tx) => {
        await tx.execute(sql`select ${spaces.id} from ${spaces} where ${spaces.id} = ${space.id} for update`);
        await tx.update(spacePages).set({ parentPageId: b.id }).where(eq(spacePages.id, a.id));
        held();
        await mayFinish;
      });
      await holding;

      // B under A, which would close the loop.
      const mine = move(app, space.id, b.id, { parentPageId: a.id }).then((res) => res);
      await new Promise((resolve) => setTimeout(resolve, 400));
      letItFinish();
      await otherMove;

      const res = await mine;
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error).toBe(SPACE_PAGE_MOVE_LOOP_MESSAGE);
      expect(await treeOf(app, space.id)).toEqual([["B", [["A", []]]]]);
    });
  });

  describe("trash", () => {
    it("sends a page with its subpages to the trash, refuses them as pages there, and brings them back together", async () => {
      const companyId = await seedCompany();
      const app = createApp(person("user-a", companyId));
      const viewer = createApp(person("user-v", companyId, "viewer"));
      const space = await createSpace(app, companyId);
      await createPage(app, space.id, { title: "Intro" });
      const people = await createPage(app, space.id, { title: "People" });
      const hiring = await createPage(app, space.id, { title: "Hiring", parentPageId: people.id });
      const interviews = await createPage(app, space.id, { title: "Interviews", parentPageId: hiring.id });

      expect((await request(viewer).delete(`/api/spaces/${space.id}/pages/${people.id}`)).status).toBe(403);
      const deleted = await request(app).delete(`/api/spaces/${space.id}/pages/${people.id}`);
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
      expect(deleted.body).toEqual({ pageId: people.id, parentPageId: null, subpageCount: 2 });
      expect(await treeOf(app, space.id)).toEqual([["Intro", []]]);
      expect((await request(app).get(`/api/companies/${companyId}/spaces`)).body[0].pageCount).toBe(1);

      // Refused as pages while in the trash.
      const subpagePath = `/api/spaces/${space.id}/pages/${interviews.id}`;
      expect((await request(app).get(`/api/spaces/${space.id}/pages/${people.id}`)).status).toBe(404);
      expect((await request(app).get(subpagePath)).status).toBe(404);
      expect((await request(app).get(`${subpagePath}/revisions`)).status).toBe(404);
      expect((await request(app).patch(subpagePath).send({ body: "x", baseRevisionId: interviews.latestRevisionId })).status).toBe(404);
      expect((await move(app, space.id, hiring.id, { parentPageId: null })).status).toBe(404);
      expect((await request(app).post(`/api/spaces/${space.id}/pages`).send({ title: "New", parentPageId: hiring.id })).status).toBe(422);

      const trash = await request(viewer).get(`/api/spaces/${space.id}/trash`);
      expect(trash.status).toBe(200);
      expect(trash.body.map((item: Record<string, unknown>) => [item.id, item.title, item.subpageCount])).toEqual([
        [people.id, "People", 2],
      ]);
      expect(trash.body[0].deletedAt).toBeTruthy();

      expect((await request(viewer).post(`/api/spaces/${space.id}/trash/${people.id}/restore`)).status).toBe(403);
      // Only what the trash lists can be restored, not a subpage that went with it.
      expect((await request(app).post(`/api/spaces/${space.id}/trash/${hiring.id}/restore`)).status).toBe(404);
      const restored = await request(app).post(`/api/spaces/${space.id}/trash/${people.id}/restore`);
      expect(restored.status, JSON.stringify(restored.body)).toBe(200);
      expect(restored.body).toEqual({ pageId: people.id, parentPageId: null, subpageCount: 2 });
      expect(await treeOf(app, space.id)).toEqual([["Intro", []], ["People", [["Hiring", [["Interviews", []]]]]]]);
      expect((await request(app).get(`/api/spaces/${space.id}/trash`)).body).toEqual([]);

      const logged = await db.select().from(activityLog).where(eq(activityLog.entityId, people.id));
      expect(logged.map((row) => [row.action, row.details]).filter(([action]) => action !== "space.page_created")).toEqual(
        expect.arrayContaining([
          ["space.page_deleted", { spaceId: space.id, pageId: people.id, subpageCount: 2 }],
          ["space.page_restored", { spaceId: space.id, pageId: people.id, parentPageId: null, subpageCount: 2 }],
        ]),
      );
    });

    it("restores a page to the top level of its Space when its parent is in the trash or gone", async () => {
      const companyId = await seedCompany();
      const app = createApp(person("user-a", companyId));
      const space = await createSpace(app, companyId);
      const other = await createSpace(app, companyId, "Other");
      const people = await createPage(app, space.id, { title: "People" });
      const hiring = await createPage(app, space.id, { title: "Hiring", parentPageId: people.id });
      const interviews = await createPage(app, space.id, { title: "Interviews", parentPageId: hiring.id });
      const handbook = await createPage(app, space.id, { title: "Handbook" });
      const chapter = await createPage(app, space.id, { title: "Chapter", parentPageId: handbook.id });

      // A subpage first, then its parent's parent: two entries in the trash.
      expect((await request(app).delete(`/api/spaces/${space.id}/pages/${interviews.id}`)).body.subpageCount).toBe(0);
      expect((await request(app).delete(`/api/spaces/${space.id}/pages/${people.id}`)).body.subpageCount).toBe(1);
      const trash = await request(app).get(`/api/spaces/${space.id}/trash`);
      expect(trash.body.map((item: Record<string, unknown>) => [item.title, item.subpageCount])).toEqual([
        ["People", 1],
        ["Interviews", 0],
      ]);

      // Its parent is in the trash, so it comes back at the top level.
      const back = await request(app).post(`/api/spaces/${space.id}/trash/${interviews.id}/restore`);
      expect(back.body).toEqual({ pageId: interviews.id, parentPageId: null, subpageCount: 0 });
      expect(await treeOf(app, space.id)).toEqual([["Handbook", [["Chapter", []]]], ["Interviews", []]]);
      // Its old parent comes back on its own, and leaves it where it is.
      await request(app).post(`/api/spaces/${space.id}/trash/${people.id}/restore`);
      expect(await treeOf(app, space.id)).toEqual([["People", [["Hiring", []]]], ["Handbook", [["Chapter", []]]], ["Interviews", []]]);

      // Its parent moved to another Space: gone from this one.
      await request(app).delete(`/api/spaces/${space.id}/pages/${chapter.id}`);
      expect((await move(app, space.id, handbook.id, { spaceId: other.id, parentPageId: null })).status).toBe(200);
      const fromGone = await request(app).post(`/api/spaces/${space.id}/trash/${chapter.id}/restore`);
      expect(fromGone.body).toEqual({ pageId: chapter.id, parentPageId: null, subpageCount: 0 });
      expect(await treeOf(app, space.id)).toEqual([["People", [["Hiring", []]]], ["Interviews", []], ["Chapter", []]]);
    });
  });

  it("keeps history, move and trash to the page's own Space, and to people of its company", async () => {
    const companyId = await seedCompany();
    const app = createApp(person("user-a", companyId));
    const space = await createSpace(app, companyId);
    const other = await createSpace(app, companyId, "Other");
    const page = await createPage(app, space.id, { title: "Refunds", body: "v1" });
    const trashed = await createPage(app, space.id, { title: "Draft" });
    await request(app).delete(`/api/spaces/${space.id}/pages/${trashed.id}`);

    // This Space's pages, asked for through another Space's address.
    const elsewhere = `/api/spaces/${other.id}/pages/${page.id}`;
    const throughOther = {
      history: request(app).get(`${elsewhere}/revisions`),
      version: request(app).get(`${elsewhere}/revisions/${page.latestRevisionId}`),
      restoreVersion: request(app).post(`${elsewhere}/revisions/${page.latestRevisionId}/restore`).send({ baseRevisionId: page.latestRevisionId }),
      move: request(app).post(`${elsewhere}/move`).send({ parentPageId: null }),
      delete: request(app).delete(elsewhere),
      restoreFromTrash: request(app).post(`/api/spaces/${other.id}/trash/${trashed.id}/restore`),
    };
    for (const [name, pending] of Object.entries(throughOther)) {
      expect((await pending).status, name).toBe(404);
    }
    expect((await request(app).get(`/api/spaces/${other.id}/trash`)).body).toEqual([]);

    // Someone from another company gets nothing.
    const outsider = createApp(person("user-x", randomUUID()));
    const pagePath = `/api/spaces/${space.id}/pages/${page.id}`;
    const fromOutside = {
      history: request(outsider).get(`${pagePath}/revisions`),
      restoreVersion: request(outsider).post(`${pagePath}/revisions/${page.latestRevisionId}/restore`).send({ baseRevisionId: page.latestRevisionId }),
      move: request(outsider).post(`${pagePath}/move`).send({ parentPageId: null }),
      delete: request(outsider).delete(pagePath),
      trash: request(outsider).get(`/api/spaces/${space.id}/trash`),
      restoreFromTrash: request(outsider).post(`/api/spaces/${space.id}/trash/${trashed.id}/restore`),
      archive: request(outsider).patch(`/api/spaces/${space.id}`).send({ archived: true }),
    };
    for (const [name, pending] of Object.entries(fromOutside)) {
      expect((await pending).status, name).toBe(403);
    }
    expect(await versionsOf(page.documentId)).toEqual([[1, "v1", null]]);
    expect(await treeOf(app, space.id)).toEqual([["Refunds", []]]);
  });

  it("finds where a page is now for an address that names the Space it was in", async () => {
    const companyId = await seedCompany();
    const app = createApp(person("user-a", companyId));
    const viewer = createApp(person("user-v", companyId, "viewer"));
    const space = await createSpace(app, companyId);
    const other = await createSpace(app, companyId, "Other");
    const page = await createPage(app, space.id, { title: "Refunds" });
    await move(app, space.id, page.id, { spaceId: other.id, parentPageId: null });

    const found = await request(viewer).get(`/api/companies/${companyId}/space-pages/${page.id}`);
    expect(found.status).toBe(200);
    expect(found.body).toEqual({ pageId: page.id, spaceId: other.id, spaceUrlKey: "other" });

    // Not for another company, nor once the page is in the trash.
    const outsider = createApp(person("user-x", randomUUID()));
    expect((await request(outsider).get(`/api/companies/${companyId}/space-pages/${page.id}`)).status).toBe(403);
    const otherCompanyId = await seedCompany();
    expect((await request(createApp(person("user-a", otherCompanyId))).get(`/api/companies/${otherCompanyId}/space-pages/${page.id}`)).status).toBe(404);
    await request(app).delete(`/api/spaces/${other.id}/pages/${page.id}`);
    expect((await request(app).get(`/api/companies/${companyId}/space-pages/${page.id}`)).status).toBe(404);
    expect((await request(app).get(`/api/companies/${companyId}/space-pages/not-a-page`)).status).toBe(404);
  });

  it("keeps names and page titles out of part 2's activity rows", async () => {
    const companyId = await seedCompany();
    const app = createApp(person("user-a", companyId));
    const space = await createSpace(app, companyId, "Layoffs 2027");
    const other = await createSpace(app, companyId, "Restructuring");
    const page = await createPage(app, space.id, { title: "Ann Smith severance terms", body: "Private" });
    await letTimePass(page.documentId, 30);
    const saved = await request(app)
      .patch(`/api/spaces/${space.id}/pages/${page.id}`)
      .send({ body: "Private, changed", baseRevisionId: page.latestRevisionId });
    await request(app)
      .post(`/api/spaces/${space.id}/pages/${page.id}/revisions/${page.latestRevisionId}/restore`)
      .send({ baseRevisionId: saved.body.latestRevisionId });
    await move(app, space.id, page.id, { spaceId: other.id, parentPageId: null });
    await request(app).delete(`/api/spaces/${other.id}/pages/${page.id}`);
    await request(app).post(`/api/spaces/${other.id}/trash/${page.id}/restore`);
    await request(app).patch(`/api/spaces/${space.id}`).send({ archived: true });

    const rows = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(new Set(rows.map((row) => row.action))).toEqual(
      new Set([
        "space.created",
        "space.page_created",
        "space.page_updated",
        "space.page_version_restored",
        "space.page_moved",
        "space.page_deleted",
        "space.page_restored",
        "space.archived",
      ]),
    );
    const logged = JSON.stringify(rows.map((row) => row.details));
    for (const words of ["Layoffs", "layoffs", "Restructuring", "restructuring", "Ann Smith", "Private"]) {
      expect(logged, words).not.toContain(words);
    }
  });
});
