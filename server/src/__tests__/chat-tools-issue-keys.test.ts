import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueComments, issues } from "@paperclipai/db";
import { loadPersonalCompanyIndex } from "../services/personal-companies.js";
import { executeChatTool, getChatTool, type ToolContext } from "../services/chat-tools.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping issue-key tests: ${support.reason}`);

describeDatabase("chat tools resolve issue keys against PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let ctx: ToolContext;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const issueId = randomUUID();
  const otherIssueId = randomUUID();
  const personalCompanyId = randomUUID();
  const personalIssueId = randomUUID();
  const personalAgentId = randomUUID();

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-chat-issue-keys-");
    db = createDb(database.connectionString);
    await db.insert(companies).values([
      { id: companyId, name: "Issue keys", issuePrefix: "KEY" },
      { id: otherCompanyId, name: "Other company", issuePrefix: "OTHER" },
      { id: personalCompanyId, name: "Personal", issuePrefix: "ME", kind: "personal", ownerUserId: "owner-1" },
    ]);
    await db.insert(issues).values([
      { id: issueId, companyId, identifier: "KEY-12", title: "Readable issue", status: "todo" },
      { id: otherIssueId, companyId: otherCompanyId, identifier: "OTHER-1", title: "Private issue" },
      { id: personalIssueId, companyId: personalCompanyId, identifier: "ME-1", title: "Personal issue" },
    ]);
    await db.insert(agents).values({ id: personalAgentId, companyId: personalCompanyId, name: "Personal agent" });
    await loadPersonalCompanyIndex(db);
    await db.insert(issueComments).values({ companyId, issueId, body: "Existing comment", authorUserId: "user-1" });
    ctx = {
      db,
      actor: { userId: "user-1", isInstanceAdmin: false, companyIds: [companyId] },
      defaultCompanyId: companyId,
    };
  });

  afterAll(async () => {
    await database?.cleanup();
  });

  it.each(["KEY-12", " key-12 ", issueId])("reads the issue and its comments using %s", async (reference) => {
    const result = await executeChatTool("get_issue", { issueId: reference }, ctx);
    expect(result).toMatchObject({
      ok: true,
      result: {
        issue: { id: issueId, identifier: "KEY-12" },
        comments: expect.arrayContaining([expect.objectContaining({ body: "Existing comment" })]),
      },
    });
  });

  it("updates by key and stores the accompanying comment with the resolved UUID", async () => {
    const result = await executeChatTool("update_issue", {
      issueId: " key-12 ", priority: "high", comment: "Raised priority using the key.",
    }, ctx);
    expect(result).toMatchObject({ ok: true, result: { issue: { id: issueId, priority: "high" } } });
    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(row.priority).toBe("high");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toEqual(expect.arrayContaining([
      expect.objectContaining({ issueId, body: "Raised priority using the key.", authorUserId: "user-1" }),
    ]));
  });

  it("adds a comment by key using the resolved UUID", async () => {
    const result = await executeChatTool("add_comment", { issueId: "KEY-12", body: "Added using the key." }, ctx);
    expect(result).toMatchObject({ ok: true, result: { comment: { issueId, body: "Added using the key." } } });
  });

  for (const name of ["get_issue", "update_issue", "add_comment"]) {
    const input = { priority: "low", body: "Must not be posted." };

    it.each(["KEY-999", "not-an-issue", randomUUID()])(`${name} reports a missing issue for %s`, async (reference) => {
      const result = await executeChatTool(name, { ...input, issueId: reference }, ctx);
      expect(result).toEqual({ ok: false, error: `Issue ${reference} not found` });
    });

    it(`${name} refuses another company's issue by key`, async () => {
      const result = await executeChatTool(name, { ...input, issueId: "OTHER-1" }, ctx);
      expect(result).toEqual({ ok: false, error: `No access to company ${otherCompanyId}` });
      const [row] = await db.select().from(issues).where(eq(issues.id, otherIssueId));
      expect(row.priority).toBe("medium");
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, otherIssueId))).toEqual([]);
    });

    it(`${name} advertises that issueId accepts a UUID or issue key`, () => {
      expect(getChatTool(name)?.spec.input_schema.properties.issueId).toMatchObject({
        description: expect.stringMatching(/UUID.*issue key/),
      });
    });
  }

  it.each(["update_issue", "add_comment"])("%s keeps viewer access read-only when called by key", async (name) => {
    const [before] = await db.select().from(issues).where(eq(issues.id, issueId));
    const result = await executeChatTool(name, {
      issueId: "KEY-12", priority: "low", body: "Must not be posted.",
    }, {
      ...ctx,
      actor: { ...ctx.actor, memberships: [{ companyId, membershipRole: "viewer", status: "active" }] },
    });
    expect(result).toEqual({ ok: false, error: "Viewer access is read-only" });
    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(row.priority).toBe(before.priority);
    expect(await db.select().from(issueComments).where(eq(issueComments.body, "Must not be posted."))).toEqual([]);
  });

  function personalAgentContext(): ToolContext {
    return {
      db,
      actor: {
        userId: `agent:${personalAgentId}`, isInstanceAdmin: false,
        companyIds: [personalCompanyId], agentCompanyId: personalCompanyId,
      },
      defaultCompanyId: personalCompanyId,
    };
  }

  it("lets an agent list companies and issues inside its own Personal company", async () => {
    const ownCtx = personalAgentContext();
    expect(await executeChatTool("list_companies", {}, ownCtx)).toMatchObject({
      ok: true, result: { companies: [expect.objectContaining({ id: personalCompanyId })] },
    });
    expect(await executeChatTool("list_issues", {}, ownCtx)).toMatchObject({
      ok: true, result: { issues: [expect.objectContaining({ id: personalIssueId })] },
    });
  });

  it("lets an agent read, update and comment on its own Personal issue by key", async () => {
    const ownCtx = personalAgentContext();
    expect(await executeChatTool("get_issue", { issueId: "ME-1" }, ownCtx)).toMatchObject({ ok: true });
    expect(await executeChatTool("update_issue", {
      issueId: "ME-1", status: "blocked", comment: "Waiting for the owner.",
    }, ownCtx)).toMatchObject({ ok: true, result: { issue: { status: "blocked" } } });
    expect(await executeChatTool("add_comment", {
      issueId: "ME-1", body: "Agent's own comment.",
    }, ownCtx)).toMatchObject({ ok: true });
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, personalIssueId));
    expect(comments).toHaveLength(2);
    expect(comments.every((row) => row.authorAgentId === personalAgentId && row.authorUserId === null)).toBe(true);
  });

  for (const [name, input] of Object.entries({
    list_issues: { companyId: personalCompanyId },
    get_issue: { issueId: "ME-1" },
    update_issue: { issueId: "ME-1", status: "done" },
    add_comment: { issueId: "ME-1", body: "Unauthorized comment." },
  })) {
    it(`${name} keeps other agents and users out of Personal`, async () => {
      const outsiders = [
        { ...ctx.actor, userId: `agent:${randomUUID()}`, agentCompanyId: companyId, isPortfolioRootUserAdmin: true },
        { ...ctx.actor, userId: "other-owner", companyIds: [personalCompanyId], isInstanceAdmin: true },
        // A user id that resembles an agent is not evidence of an agent run.
        { ...ctx.actor, userId: `agent:${personalAgentId}`, companyIds: [personalCompanyId] },
      ];
      for (const actor of outsiders) {
        expect(await executeChatTool(name, input, { ...ctx, actor })).toEqual({
          ok: false, error: "This is someone's personal company",
        });
      }
    });
  }

  it("still lets the owner read Personal and hides it from other company listings", async () => {
    expect(await executeChatTool("get_issue", { issueId: "ME-1" }, {
      ...ctx, actor: { ...ctx.actor, userId: "owner-1", companyIds: [personalCompanyId] },
    })).toMatchObject({ ok: true });
    const result = await executeChatTool("list_companies", {}, {
      ...ctx, actor: { ...ctx.actor, isInstanceAdmin: true },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.result as { companies: Array<{ id: string }> }).companies.map((row) => row.id))
        .not.toContain(personalCompanyId);
    }
  });
});
