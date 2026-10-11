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
    }
    expect(await revisionsOf(page.documentId)).toHaveLength(1);
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
});
