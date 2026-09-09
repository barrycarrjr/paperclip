/**
 * Repeat-safe operations.
 *
 * The failure being prevented: an agent calls a plugin operation that sends an
 * email, the response is lost, the agent calls again, and the email goes out
 * twice. These tests run against a real database because the whole mechanism
 * is a unique index doing the deciding — an in-memory stand-in would prove
 * nothing about the race it exists to settle.
 *
 * @see PLUGIN_SPEC.md §11.7 — Repeat-safe operations
 */

import { randomUUID } from "node:crypto";
import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, pluginOperationCalls } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { getTestDatabaseSupport, startTestDatabase } from "./helpers/test-postgres.js";
import {
  createPluginOperationIdempotencyStore,
  deriveIdempotencyKey,
  STALE_CLAIM_MS,
  type PluginOperationIdempotencyStore,
} from "../services/plugin-operation-idempotency.js";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";

const databaseSupport = await getTestDatabaseSupport();
const describeWithDatabase = databaseSupport.supported ? describe : describe.skip;

if (!databaseSupport.supported) {
  console.warn(
    `Skipping plugin idempotency tests on this host: ${databaseSupport.reason ?? "no test database available"}`,
  );
}

function manifest(writes: boolean): PaperclipPluginManifestV1 {
  return {
    id: "acme.mail",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Mail",
    description: "Sends mail",
    author: "Acme",
    categories: ["automation"],
    capabilities: ["agent.tools.register", "ui.action.register"],
    entrypoints: { worker: "./dist/worker.js" },
    operations: [{
      key: "send",
      displayName: "Send",
      description: "Send an email.",
      parametersSchema: { type: "object" },
      writes,
    }],
  };
}

describe("idempotency key derivation", () => {
  it("gives the same key to the same call however the arguments are ordered", () => {
    const a = deriveIdempotencyKey({
      runId: "run-1",
      namespacedName: "acme.mail:send",
      parameters: { to: "a@example.com", subject: "hi" },
    });
    const b = deriveIdempotencyKey({
      runId: "run-1",
      namespacedName: "acme.mail:send",
      parameters: { subject: "hi", to: "a@example.com" },
    });

    // Key order varies between JSON producers. If it changed the hash, the
    // same retried call would slip through as a new one.
    expect(a).toBe(b);
  });

  it("separates different arguments, different tools, and different runs", () => {
    const base = { runId: "run-1", namespacedName: "acme.mail:send", parameters: { to: "a" } };
    const keys = new Set([
      deriveIdempotencyKey(base),
      deriveIdempotencyKey({ ...base, parameters: { to: "b" } }),
      deriveIdempotencyKey({ ...base, namespacedName: "acme.mail:other" }),
      deriveIdempotencyKey({ ...base, runId: "run-2" }),
    ]);

    // A second run doing the same thing is a legitimate repeat, not a retry.
    expect(keys.size).toBe(4);
  });

  it("treats nested arguments consistently too", () => {
    const a = deriveIdempotencyKey({
      runId: "r", namespacedName: "t", parameters: { o: { x: 1, y: [2, { p: 3, q: 4 }] } },
    });
    const b = deriveIdempotencyKey({
      runId: "r", namespacedName: "t", parameters: { o: { y: [2, { q: 4, p: 3 }], x: 1 } },
    });
    expect(a).toBe(b);
  });
});

describeWithDatabase("plugin operation repeat protection", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startTestDatabase>> | null = null;
  let store: PluginOperationIdempotencyStore;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startTestDatabase("paperclip-plugin-idem-");
    db = createDb(tempDb.connectionString);
    store = createPluginOperationIdempotencyStore(db);
  }, 90_000);

  afterEach(async () => {
    await db.delete(pluginOperationCalls);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // `companies.issue_prefix` is unique and defaults to the same value for
  // every row, so two companies in one test need distinct prefixes or the
  // second insert fails on an index that has nothing to do with what is being
  // tested.
  let companyCounter = 0;

  async function seedCompany(): Promise<string> {
    const id = randomUUID();
    companyCounter += 1;
    await db.insert(companies).values({
      id,
      name: `Test Co ${companyCounter}`,
      issuePrefix: `T${String(companyCounter).padStart(2, "0")}`,
    });
    return id;
  }

  function key(idempotencyKey: string, company: string | null) {
    return {
      pluginId: "acme.mail",
      operationKey: "send",
      idempotencyKey,
      companyId: company,
    };
  }

  describe("the store", () => {
    it("lets exactly one of two racing claims through", async () => {
      companyId = await seedCompany();
      const k = key("k1", companyId);

      // Both claims are issued before either resolves, so the database decides
      // the winner. A read-then-write would let both through here.
      const [first, second] = await Promise.all([store.claim(k), store.claim(k)]);

      const kinds = [first.kind, second.kind].sort();
      expect(kinds).toEqual(["claimed", "in_flight"]);
    });

    it("replays a settled result instead of running again", async () => {
      companyId = await seedCompany();
      const k = key("k2", companyId);

      expect((await store.claim(k)).kind).toBe("claimed");
      await store.settle(k, { content: "sent", data: { messageId: "m-1" } }, true);

      const again = await store.claim(k);
      expect(again.kind).toBe("replay");
      if (again.kind === "replay") {
        expect(again.result).toEqual({ content: "sent", data: { messageId: "m-1" } });
      }
    });

    it("replays a failure rather than retrying it", async () => {
      companyId = await seedCompany();
      const k = key("k3", companyId);

      await store.claim(k);
      await store.settle(k, { error: "Mailbox rejected the message." }, false);

      const again = await store.claim(k);
      // Silently retrying could succeed the second time, and the caller would
      // never learn the first attempt had also fired.
      expect(again.kind).toBe("replay");
      if (again.kind === "replay") {
        expect(again.result.error).toBe("Mailbox rejected the message.");
      }
    });

    it("frees the key again when a claim is released", async () => {
      companyId = await seedCompany();
      const k = key("k4", companyId);

      await store.claim(k);
      await store.release(k);

      expect((await store.claim(k)).kind).toBe("claimed");
    });

    it("takes over a claim left behind by a killed worker", async () => {
      companyId = await seedCompany();
      const k = key("k5", companyId);
      await store.claim(k);

      // Age the claim by moving its own timestamp back, NOT by moving the
      // clock: fake timers freeze the ones the Postgres driver runs on, so
      // every query after that never settles and the suite hangs rather than
      // fails.
      await db
        .update(pluginOperationCalls)
        .set({ startedAt: new Date(Date.now() - STALE_CLAIM_MS - 60_000) })
        .where(eq(pluginOperationCalls.idempotencyKey, "k5"));

      // Without the takeover the key would stay locked and the operation would
      // become permanently unrunnable.
      expect((await store.claim(k)).kind).toBe("claimed");
    });

    it("keeps two companies' identical calls apart", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();

      expect((await store.claim(key("same", companyA))).kind).toBe("claimed");
      expect((await store.claim(key("same", companyB))).kind).toBe("claimed");
    });

    it("still deduplicates a global call with no company", async () => {
      // Postgres treats NULLs as distinct in a unique index, so a single index
      // over a nullable company would let every global call repeat freely.
      expect((await store.claim(key("global", null))).kind).toBe("claimed");
      expect((await store.claim(key("global", null))).kind).toBe("in_flight");
    });

    it("purges rows past their replay window", async () => {
      companyId = await seedCompany();
      await store.claim(key("old", companyId), { replayWindowMs: -1 });

      expect(await store.purgeExpired()).toBe(1);
      expect((await store.claim(key("old", companyId))).kind).toBe("claimed");
    });
  });

  describe("the dispatcher", () => {
    function dispatcherFor(opts: {
      writes: boolean;
      onCall: () => Promise<unknown>;
      withStore?: boolean;
    }) {
      const workerManager = {
        isRunning: () => true,
        call: async () => opts.onCall(),
      };
      const dispatcher = createPluginToolDispatcher({
        workerManager: workerManager as never,
        ...(opts.withStore === false ? {} : { idempotencyStore: store }),
      });
      dispatcher.registerPluginTools("acme.mail", manifest(opts.writes), "acme.mail");
      return dispatcher;
    }

    const runContext = (companyIdValue: string, runId = "run-1") => ({
      agentId: "agent-1",
      runId,
      companyId: companyIdValue,
    });

    it("runs a writing operation once when the agent calls it twice with the same arguments", async () => {
      companyId = await seedCompany();
      let calls = 0;
      const dispatcher = dispatcherFor({
        writes: true,
        onCall: async () => {
          calls += 1;
          return { content: `sent ${calls}` };
        },
      });

      const first = await dispatcher.executeTool("acme.mail:send", { to: "a@b.c" }, runContext(companyId));
      const second = await dispatcher.executeTool("acme.mail:send", { to: "a@b.c" }, runContext(companyId));

      // This is the whole point: the agent got an answer both times, and the
      // email went out once.
      expect(calls).toBe(1);
      expect(second.result).toEqual(first.result);
    });

    it("lets a different run send the same email", async () => {
      companyId = await seedCompany();
      let calls = 0;
      const dispatcher = dispatcherFor({
        writes: true,
        onCall: async () => { calls += 1; return { content: "sent" }; },
      });

      await dispatcher.executeTool("acme.mail:send", { to: "a@b.c" }, runContext(companyId, "run-1"));
      await dispatcher.executeTool("acme.mail:send", { to: "a@b.c" }, runContext(companyId, "run-2"));

      expect(calls).toBe(2);
    });

    it("lets one run send two different emails", async () => {
      companyId = await seedCompany();
      let calls = 0;
      const dispatcher = dispatcherFor({
        writes: true,
        onCall: async () => { calls += 1; return { content: "sent" }; },
      });

      await dispatcher.executeTool("acme.mail:send", { to: "a@b.c" }, runContext(companyId));
      await dispatcher.executeTool("acme.mail:send", { to: "d@e.f" }, runContext(companyId));

      expect(calls).toBe(2);
    });

    it("honours an explicit key over the derived one", async () => {
      companyId = await seedCompany();
      let calls = 0;
      const dispatcher = dispatcherFor({
        writes: true,
        onCall: async () => { calls += 1; return { content: "sent" }; },
      });

      const ctx = { ...runContext(companyId), idempotencyKey: "invoice-2026-09" };
      await dispatcher.executeTool("acme.mail:send", { to: "a@b.c" }, ctx);
      // Different arguments, different run — but the caller says it is the
      // same call, and it is the caller who knows.
      await dispatcher.executeTool("acme.mail:send", { to: "z@z.z" }, { ...ctx, runId: "run-9" });

      expect(calls).toBe(1);
    });

    it("passes the key down to the handler", async () => {
      companyId = await seedCompany();
      let seenKey: string | undefined;
      const workerManager = {
        isRunning: () => true,
        call: async (_id: string, _method: string, params: { runContext?: { idempotencyKey?: string } }) => {
          seenKey = params.runContext?.idempotencyKey;
          return { content: "sent" };
        },
      };
      const dispatcher = createPluginToolDispatcher({
        workerManager: workerManager as never,
        idempotencyStore: store,
      });
      dispatcher.registerPluginTools("acme.mail", manifest(true), "acme.mail");

      await dispatcher.executeTool("acme.mail:send", { to: "a@b.c" }, runContext(companyId));

      // The plugin needs it to pass on to whatever it calls, so the protection
      // reaches past Paperclip's own boundary.
      expect(seenKey).toBeTruthy();
    });

    it("does not claim anything for a read-only operation", async () => {
      companyId = await seedCompany();
      let calls = 0;
      const dispatcher = dispatcherFor({
        writes: false,
        onCall: async () => { calls += 1; return { content: "read" }; },
      });

      await dispatcher.executeTool("acme.mail:send", { to: "a@b.c" }, runContext(companyId));
      await dispatcher.executeTool("acme.mail:send", { to: "a@b.c" }, runContext(companyId));

      // A read costs nothing to repeat, and claiming one would be a database
      // write per lookup.
      expect(calls).toBe(2);
      expect(await db.select().from(pluginOperationCalls)).toHaveLength(0);
    });

    it("frees the key when the call blows up instead of returning", async () => {
      companyId = await seedCompany();
      let calls = 0;
      const dispatcher = dispatcherFor({
        writes: true,
        onCall: async () => {
          calls += 1;
          if (calls === 1) throw new Error("worker died");
          return { content: "sent" };
        },
      });

      await expect(
        dispatcher.executeTool("acme.mail:send", { to: "a@b.c" }, runContext(companyId)),
      ).rejects.toThrow("worker died");

      // Nothing ran, so a later attempt must be allowed through. Recording the
      // crash as a failure would replay it to a caller who could have
      // succeeded.
      const retry = await dispatcher.executeTool("acme.mail:send", { to: "a@b.c" }, runContext(companyId));
      expect(retry.result).toEqual({ content: "sent" });
      expect(calls).toBe(2);
    });

    it("refuses a second caller while the first is still running", async () => {
      companyId = await seedCompany();
      let release: (() => void) | null = null;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const dispatcher = dispatcherFor({
        writes: true,
        onCall: async () => { await gate; return { content: "sent" }; },
      });

      const inFlight = dispatcher.executeTool("acme.mail:send", { to: "a@b.c" }, runContext(companyId));
      const second = await dispatcher.executeTool("acme.mail:send", { to: "a@b.c" }, runContext(companyId));

      // Refused, not queued: there is no result to replay yet, and waiting
      // would turn one slow call into two.
      expect(second.result.failure?.code).toBe("unavailable");
      expect(second.result.error).toContain("already running");

      release?.();
      await inFlight;
    });

    it("runs writing operations unprotected when no store is configured", async () => {
      companyId = await seedCompany();
      let calls = 0;
      const dispatcher = dispatcherFor({
        writes: true,
        withStore: false,
        onCall: async () => { calls += 1; return { content: "sent" }; },
      });

      await dispatcher.executeTool("acme.mail:send", { to: "a@b.c" }, runContext(companyId));
      await dispatcher.executeTool("acme.mail:send", { to: "a@b.c" }, runContext(companyId));

      // Same behaviour as before repeat protection existed, for a host with no
      // database behind it.
      expect(calls).toBe(2);
    });
  });
});
