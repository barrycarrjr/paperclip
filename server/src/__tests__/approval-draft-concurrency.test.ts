import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { approvals, companies, createDb } from "@paperclipai/db";
import { approvalService } from "../services/approvals.ts";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.ts";

async function closeDbClient(db: ReturnType<typeof createDb> | undefined) {
  await db?.$client?.end?.({ timeout: 0 });
}

describe("approvalService pending draft concurrency", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-draft-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(approvals);
    await db.delete(companies);
  });

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  it("returns one shared pending draft when identical requests race", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Draft Co",
      issuePrefix: `D${companyId.slice(0, 5).toUpperCase()}`,
    });
    const service = approvalService(db);
    const dedupeKey = "same-draft";
    const input = {
      type: "outbound_tool_draft",
      status: "pending",
      dedupeKey,
      payload: {
        toolName: "email-tools:email_send",
        parameters: { to: "customer@example.com", body: "Hello" },
      },
      requestedByAgentId: null,
      requestedByUserId: "user-1",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
    };

    const results = await Promise.all([
      service.createPendingDraft(companyId, input),
      service.createPendingDraft(companyId, input),
    ]);

    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(new Set(results.map((result) => result.approval.id))).toHaveLength(1);
    expect(await service.list(companyId, "pending")).toHaveLength(1);
  });
});
