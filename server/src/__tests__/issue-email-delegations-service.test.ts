import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, issueEmailDelegations, issues } from "@paperclipai/db";
import { EMAIL_HANDOFF_ORIGIN_KIND, buildEmailHandoffOriginId } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueEmailDelegationService } from "../services/issue-email-delegations.ts";
import { HttpError } from "../errors.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres email delegation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue email delegation service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let service!: ReturnType<typeof issueEmailDelegationService>;

  let companyId!: string;
  let otherCompanyId!: string;
  let issueId!: string;

  const sourceKey = buildEmailHandoffOriginId({
    pluginId: "email-tools",
    mailbox: "personal",
    messageId: "<abc@example.com>",
  })!;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-email-delegations-");
    db = createDb(tempDb.connectionString);
    service = issueEmailDelegationService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueEmailDelegations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    for (const [id, name] of [
      [companyId, "Acme"],
      [otherCompanyId, "Other"],
    ] as const) {
      await db.insert(companies).values({
        id,
        name,
        issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
    }
    issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Customer asked about an invoice",
      status: "todo",
      originKind: EMAIL_HANDOFF_ORIGIN_KIND,
      originId: sourceKey,
    });
  }

  async function delegate(overrides: Partial<Parameters<typeof service.create>[0]> = {}) {
    return service.create({
      issueId,
      companyId,
      pluginId: "email-tools",
      sourceKey,
      mailbox: "personal",
      messageId: "<abc@example.com>",
      ...overrides,
    });
  }

  it("records a handover", async () => {
    await seed();
    const { delegation, created } = await delegate();

    expect(created).toBe(true);
    expect(delegation.status).toBe("delegated");
    expect(delegation.version).toBe(0);
    expect(delegation.replyState).toBe("none");
    expect(delegation.sourceKey).toBe(sourceKey);
    expect(delegation.acknowledgedAt).toBeNull();
    expect(delegation.resolvedAt).toBeNull();
  });

  it("does not hand the same email over twice", async () => {
    await seed();
    const first = await delegate();
    const second = await delegate();

    expect(second.created).toBe(false);
    expect(second.delegation.id).toBe(first.delegation.id);

    const rows = await db.select().from(issueEmailDelegations);
    expect(rows).toHaveLength(1);
  });

  it("lets the database settle a genuine race rather than creating two", async () => {
    await seed();
    // Both calls read "no open delegation" before either writes, which is the
    // case the read-first fast path cannot catch. The partial unique index is
    // the real guard, and the loser must come back with the winner's row, not
    // an error.
    const [a, b] = await Promise.all([delegate(), delegate()]);

    expect(a.delegation.id).toBe(b.delegation.id);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);

    const rows = await db.select().from(issueEmailDelegations);
    expect(rows).toHaveLength(1);
  });

  it("lets the same email be handed over again once the first is finished", async () => {
    await seed();
    const first = await delegate();
    await service.transition({
      companyId,
      delegationId: first.delegation.id,
      to: "resolved",
    });

    const second = await delegate();
    expect(second.created).toBe(true);
    expect(second.delegation.id).not.toBe(first.delegation.id);
  });

  it("does not let one company's email block another's", async () => {
    await seed();
    await delegate();

    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId,
      companyId: otherCompanyId,
      title: "Unrelated",
      status: "todo",
    });
    const other = await delegate({ companyId: otherCompanyId, issueId: otherIssueId });

    expect(other.created).toBe(true);
  });

  it("stamps acknowledgedAt and resolvedAt as it moves", async () => {
    await seed();
    const { delegation } = await delegate();

    const acknowledged = await service.transition({
      companyId,
      delegationId: delegation.id,
      to: "acknowledged",
    });
    expect(acknowledged.acknowledgedAt).toBeInstanceOf(Date);
    expect(acknowledged.resolvedAt).toBeNull();
    expect(acknowledged.version).toBe(1);

    const resolved = await service.transition({
      companyId,
      delegationId: delegation.id,
      to: "resolved",
      resolutionNote: "Refund issued",
    });
    expect(resolved.resolvedAt).toBeInstanceOf(Date);
    expect(resolved.resolutionNote).toBe("Refund issued");
    // The original acknowledgement time survives later moves.
    expect(resolved.acknowledgedAt?.getTime()).toBe(acknowledged.acknowledgedAt?.getTime());
  });

  it("refuses a transition the state machine disallows", async () => {
    await seed();
    const { delegation } = await delegate();
    await service.transition({ companyId, delegationId: delegation.id, to: "resolved" });

    await expect(
      service.transition({ companyId, delegationId: delegation.id, to: "in_progress" }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("requires a reason to hand work back", async () => {
    await seed();
    const { delegation } = await delegate();

    await expect(
      service.transition({ companyId, delegationId: delegation.id, to: "handed_back" }),
    ).rejects.toMatchObject({ status: 422 });

    const handedBack = await service.transition({
      companyId,
      delegationId: delegation.id,
      to: "handed_back",
      handedBackReason: "Needs billing access I do not have",
    });
    expect(handedBack.handedBackReason).toBe("Needs billing access I do not have");
  });

  it("does not let a stale write overwrite a fresher one", async () => {
    await seed();
    const { delegation } = await delegate();
    const staleVersion = delegation.version;

    await service.transition({
      companyId,
      delegationId: delegation.id,
      to: "handed_back",
      handedBackReason: "Wrong team",
    });

    // A resolve that was decided before the handback landed must lose.
    await expect(
      service.transition({
        companyId,
        delegationId: delegation.id,
        to: "resolved",
        expectedVersion: staleVersion,
      }),
    ).rejects.toBeInstanceOf(HttpError);

    const [row] = await db.select().from(issueEmailDelegations);
    expect(row.status).toBe("handed_back");
  });

  it("refuses to touch another company's delegation", async () => {
    await seed();
    const { delegation } = await delegate();

    await expect(
      service.transition({
        companyId: otherCompanyId,
        delegationId: delegation.id,
        to: "acknowledged",
      }),
    ).rejects.toMatchObject({ status: 404 });

    expect(await service.findById(otherCompanyId, delegation.id)).toBeNull();
  });

  it("chains a re-delegation instead of overwriting the first", async () => {
    await seed();
    const { delegation: first } = await delegate();
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Second agent",
      role: "worker",
    });

    const second = await service.reDelegate({
      companyId,
      delegationId: first.id,
      issueId,
      delegatedToAgentId: agentId,
    });

    expect(second.id).not.toBe(first.id);
    expect(second.previousDelegationId).toBe(first.id);
    expect(second.status).toBe("delegated");
    expect(second.delegatedToAgentId).toBe(agentId);

    const history = await service.listForIssue(companyId, issueId);
    expect(history).toHaveLength(2);
    expect(history.map((row) => row.status).sort()).toEqual(["delegated", "re_delegated"]);
  });

  it("finds the open delegation for an email and ignores finished ones", async () => {
    await seed();
    const { delegation } = await delegate();
    expect((await service.findOpenBySourceKey(companyId, sourceKey))?.id).toBe(delegation.id);

    await service.transition({ companyId, delegationId: delegation.id, to: "resolved" });
    expect(await service.findOpenBySourceKey(companyId, sourceKey)).toBeNull();
  });

  it("records what happened to the reply separately from the state", async () => {
    await seed();
    const { delegation } = await delegate();
    await service.transition({ companyId, delegationId: delegation.id, to: "resolved" });

    await service.setReplyState({
      companyId,
      delegationId: delegation.id,
      replyState: "failed",
      replyError: "Mailbox rejected the message",
    });

    const row = await service.findById(companyId, delegation.id);
    expect(row?.status).toBe("resolved");
    expect(row?.replyState).toBe("failed");
    expect(row?.replyError).toBe("Mailbox rejected the message");
  });

  it("lists handovers nobody has picked up", async () => {
    await seed();
    const { delegation } = await delegate();
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await db
      .update(issueEmailDelegations)
      .set({ delegatedAt: old })
      .where(eq(issueEmailDelegations.id, delegation.id));

    const stale = await service.listStale({
      companyId,
      before: new Date(Date.now() - 30 * 60 * 1000),
    });
    expect(stale.map((row) => row.id)).toEqual([delegation.id]);

    // Once an agent picks it up, slowness stops being the handover's problem.
    await service.transition({ companyId, delegationId: delegation.id, to: "acknowledged" });
    expect(
      await service.listStale({ companyId, before: new Date(Date.now() - 30 * 60 * 1000) }),
    ).toHaveLength(0);
  });

  it("finds email issues that never got a delegation row", async () => {
    await seed();
    const gaps = await service.listIssuesMissingDelegation({
      companyId,
      originKind: EMAIL_HANDOFF_ORIGIN_KIND,
    });
    expect(gaps.map((row) => row.id)).toEqual([issueId]);

    await delegate();
    expect(
      await service.listIssuesMissingDelegation({
        companyId,
        originKind: EMAIL_HANDOFF_ORIGIN_KIND,
      }),
    ).toHaveLength(0);
  });
});
