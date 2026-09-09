/**
 * Runtime check: the new operation endpoints through the WHOLE app.
 *
 * The other operation tests mount `pluginRoutes` on a bare Express instance
 * with a hand-written actor. That proves the handlers, and misses everything
 * around them — body parsing limits, the host guard, the actor middleware, the
 * error handler, and whether the route is even reachable at the path the UI
 * would call. Those are exactly the things that pass unit tests and fail in
 * the browser.
 *
 * So this one boots `createApp` against a throwaway migrated database and
 * makes real HTTP requests. It also proves the migrations apply, since the
 * database it runs against is built by running them.
 *
 * @see PLUGIN_SPEC.md §11.5 — Operations
 * @see PLUGIN_SPEC.md §11.8 — Operator control over operations
 */

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, plugins, pluginOperationCalls } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { getTestDatabaseSupport, startTestDatabase } from "./helpers/test-postgres.js";

const databaseSupport = await getTestDatabaseSupport();
const describeWithDatabase = databaseSupport.supported ? describe : describe.skip;

if (!databaseSupport.supported) {
  console.warn(
    `Skipping plugin operations runtime check: ${databaseSupport.reason ?? "no test database available"}`,
  );
}

const manifest: PaperclipPluginManifestV1 = {
  id: "acme.runtime-ops",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Runtime Ops",
  description: "Operations used by the runtime check",
  author: "Acme",
  categories: ["automation"],
  capabilities: ["agent.tools.register", "ui.action.register"],
  entrypoints: { worker: "./dist/worker.js" },
  operations: [
    {
      key: "send-invoice",
      displayName: "Send invoice",
      description: "Email an invoice to the customer.",
      parametersSchema: { type: "object" },
      writes: true,
    },
    {
      key: "pick-file",
      displayName: "Pick a file",
      description: "Open a file picker.",
      parametersSchema: { type: "object" },
      audience: "users",
    },
  ],
};

describeWithDatabase("plugin operations — through the running app", () => {
  let tempDb: Awaited<ReturnType<typeof startTestDatabase>> | null = null;
  let app: Awaited<ReturnType<typeof import("../app.js").createApp>>;
  let pluginRowId: string;

  beforeAll(async () => {
    tempDb = await startTestDatabase("paperclip-plugin-ops-runtime-");
    const db = createDb(tempDb.connectionString);

    pluginRowId = randomUUID();
    await db.insert(plugins).values({
      id: pluginRowId,
      pluginKey: manifest.id,
      packageName: "@acme/plugin-runtime-ops",
      version: manifest.version,
      apiVersion: 1,
      categories: manifest.categories,
      manifestJson: manifest,
      status: "ready",
    });

    const { createApp } = await import("../app.js");
    app = await createApp(db as never, {
      uiMode: "none" as never,
      serverPort: 0,
      storageService: {} as never,
      // Trusted-local skips the auth handshake, so the request arrives as an
      // instance admin — which is what these endpoints require and what a
      // single-user local install actually looks like.
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      // supertest dials the loopback interface and sends whatever Node gives
      // it as the Host header, which is `[::1]` on this stack. The private
      // hostname guard rejects an unlisted host before any route runs, so
      // without these the whole file fails with a hostname error and proves
      // nothing about the routes. Catching that is the reason this file goes
      // through the real app rather than a bare router.
      allowedHostnames: ["[::1]", "::1", "localhost", "127.0.0.1"],
      bindHost: "127.0.0.1",
      authReady: false,
      companyDeletionEnabled: false,
      heartbeatSchedulerEnabled: false,
    });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("applies the migrations that back these features", async () => {
    const db = createDb(tempDb!.connectionString);
    // Reading the table proves 0098 ran; reading the column proves 0099 did.
    // A missing migration is the classic thing a mounted-router test cannot
    // see, because it never touches a database at all.
    await expect(db.select().from(pluginOperationCalls)).resolves.toEqual([]);
    const rows = await db.select().from(plugins);
    expect(rows[0]?.operationPolicyJson).toEqual({});
  });

  it("serves the operations list at the path the settings screen calls", async () => {
    const res = await request(app as never).get(`/api/plugins/${pluginRowId}/operations`);

    expect(res.status).toBe(200);
    expect(res.body.operations.map((o: { key: string }) => o.key).sort())
      .toEqual(["pick-file", "send-invoice"]);
    const pickFile = res.body.operations.find((o: { key: string }) => o.key === "pick-file");
    expect(pickFile.declaredAudience).toBe("users");
    expect(pickFile.effective.audience).toBe("users");
  });

  it("saves a narrowing override and reads it back", async () => {
    const put = await request(app as never)
      .put(`/api/plugins/${pluginRowId}/operations/policy`)
      .send({ policy: { "send-invoice": { requiresApproval: true, audience: "agents" } } });

    expect(put.status).toBe(200);

    const get = await request(app as never).get(`/api/plugins/${pluginRowId}/operations`);
    const invoice = get.body.operations.find((o: { key: string }) => o.key === "send-invoice");
    expect(invoice.effective).toMatchObject({ audience: "agents", requiresApproval: true });
  });

  it("refuses an override that would widen, over real HTTP", async () => {
    const res = await request(app as never)
      .put(`/api/plugins/${pluginRowId}/operations/policy`)
      .send({ policy: { "pick-file": { audience: "both" } } });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("can only narrow");
  });

  it("refuses a bridge action for a plugin whose package will not load", async () => {
    // This row is a fixture, not a real installed package, so the running app
    // never gets a worker for it and the route stops at the readiness check
    // before reaching the audience guard.
    //
    // Which is the honest thing for this file to assert. The audience guard
    // itself is covered in plugin-operation-policy-routes.test.ts with a
    // ready plugin; faking readiness here to reach it would mean asserting
    // against a state the running app cannot actually be in.
    const res = await request(app as never)
      .post(`/api/plugins/${pluginRowId}/actions/send-invoice`)
      .send({});

    expect(res.status).toBe(502);
    expect(res.body.code).toBe("WORKER_UNAVAILABLE");
  });

  it("answers 404 for a plugin that is not installed", async () => {
    const res = await request(app as never)
      .get(`/api/plugins/${randomUUID()}/operations`);

    expect(res.status).toBe(404);
  });
});
