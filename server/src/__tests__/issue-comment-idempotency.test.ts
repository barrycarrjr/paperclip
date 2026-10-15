import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueComments, issues } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping issue comment idempotency tests: ${support.reason}`);

describeDatabase("issue comment idempotency", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const issueId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-comment-idempotency-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Comment idempotency", issuePrefix: "CID" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Retrying agent" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Reply once", assigneeAgentId: agentId });
  });

  afterAll(async () => {
    await database?.cleanup();
  });

  it("returns one durable comment when concurrent requests use the same issue key", async () => {
    const service = issueService(db);
    const idempotencyKey = "ollama.mixed:v1_concurrent";
    const results = await Promise.all([
      service.addCommentIdempotent(issueId, "First generated answer", { agentId, idempotencyKey }),
      service.addCommentIdempotent(issueId, "Regenerated answer", { agentId, idempotencyKey }),
    ]);

    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(results[0].comment.id).toBe(results[1].comment.id);
    expect(results[0].comment.body).toBe(results[1].comment.body);
    const stored = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ idempotencyKey, authorAgentId: agentId });
  });

  it("does not let another actor reuse an existing issue comment key", async () => {
    const otherAgentId = randomUUID();
    await db.insert(agents).values({ id: otherAgentId, companyId, name: "Other agent" });
    await expect(issueService(db).addCommentIdempotent(issueId, "Different actor", {
      agentId: otherAgentId,
      idempotencyKey: "ollama.mixed:v1_concurrent",
    })).rejects.toMatchObject({ status: 409 });
  });
});
