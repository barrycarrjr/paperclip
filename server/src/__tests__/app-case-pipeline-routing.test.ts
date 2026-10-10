import { createHash, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createApp } from "../app.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres app case routing tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Cases and pipeline items share seven /cases/:id addresses. These tests go
// through the whole app, so they also cover the order app.ts mounts the two
// routers in, which the per-router tests cannot see.
describeEmbeddedPostgres("app routing for the shared /cases addresses", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: Awaited<ReturnType<typeof createApp>>;

  const storage: StorageService = {
    provider: "local_disk",
    async putFile(input) {
      return {
        provider: "local_disk",
        objectKey: `${input.namespace}/${randomUUID()}`,
        contentType: input.contentType,
        byteSize: input.body.length,
        sha256: createHash("sha256").update(input.body).digest("hex"),
        originalFilename: input.originalFilename,
      };
    },
    async getObject() {
      throw new Error("not used");
    },
    async headObject() {
      return { exists: false };
    },
    async deleteObject() {},
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-app-case-routing-");
    db = createDb(tempDb.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableCases: true });
    app = await createApp(db, {
      uiMode: "none",
      serverPort: 0,
      storageService: storage,
      deploymentMode: "local_trusted",
      // The hostname guard is not under test here.
      deploymentExposure: "public",
      allowedHostnames: [],
      bindHost: "127.0.0.1",
      authReady: true,
      companyDeletionEnabled: false,
      pluginRuntimeEnabled: false,
    });
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(prefix: string) {
    const [company] = await db.insert(companies).values({
      name: `${prefix} Co`,
      issuePrefix: `${prefix}${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
    }).returning();
    return company!;
  }

  it("opens a case by id and by identifier", async () => {
    const company = await seedCompany("CAS");
    const http = request(app);
    const created = await http
      .post(`/api/companies/${company.id}/cases`)
      .send({ caseType: "blog_post", title: "Launch post" })
      .expect(201);
    const caseId = created.body.id as string;
    const identifier = created.body.identifier as string;
    expect(identifier).toBe(`${company.issuePrefix}-C1`);

    for (const ref of [caseId, identifier]) {
      const detail = await http.get(`/api/cases/${ref}`).expect(200);
      expect(detail.body).toMatchObject({ id: caseId, identifier, title: "Launch post" });
    }

    const patched = await http.patch(`/api/cases/${identifier}`).send({ status: "in_review" }).expect(200);
    expect(patched.body).toMatchObject({ id: caseId, status: "in_review" });

    const events = await http.get(`/api/cases/${identifier}/events`).expect(200);
    expect(events.body.map((event: { kind: string }) => event.kind)).toEqual(
      expect.arrayContaining(["created", "status_changed"]),
    );

    const first = await http.put(`/api/cases/${identifier}/documents/body`).send({ body: "# v1" }).expect(200);
    await http
      .put(`/api/cases/${caseId}/documents/body`)
      .send({ body: "# v2", baseRevisionId: first.body.revision.id })
      .expect(200);

    const document = await http.get(`/api/cases/${identifier}/documents/body`).expect(200);
    expect(document.body).toMatchObject({ key: "body", body: "# v2", latestRevisionNumber: 2 });

    const revisions = await http.get(`/api/cases/${identifier}/documents/body/revisions`).expect(200);
    expect(revisions.body.revisions.map((revision: { revisionNumber: number }) => revision.revisionNumber))
      .toEqual([2, 1]);

    const restored = await http
      .post(`/api/cases/${identifier}/documents/body/revisions/${first.body.revision.id}/restore`)
      .expect(200);
    expect(restored.body.document).toMatchObject({ key: "body", body: "# v1", latestRevisionNumber: 3 });
  });

  it("hands pipeline items on to the pipelines routes at the same addresses", async () => {
    const company = await seedCompany("PIP");
    const http = request(app);
    const pipeline = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({
        key: "content",
        name: "Content",
        stages: [
          { key: "intake", name: "Intake", kind: "open", position: 100 },
          { key: "done", name: "Done", kind: "done", position: 900 },
          { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(201);
    const ingested = await http
      .post(`/api/pipelines/${pipeline.body.id}/cases`)
      .send({ caseKey: "item-1", title: "Pipeline item" })
      .expect(201);
    const itemId = ingested.body.case.id as string;

    const detail = await http.get(`/api/cases/${itemId}`).expect(200);
    expect(detail.body.case).toMatchObject({ id: itemId, title: "Pipeline item" });
    expect(detail.body.pipeline.id).toBe(pipeline.body.id);

    const patched = await http
      .patch(`/api/cases/${itemId}`)
      .send({ title: "Pipeline item renamed", expectedVersion: 1 })
      .expect(200);
    expect(patched.body).toMatchObject({ id: itemId, title: "Pipeline item renamed" });

    const events = await http.get(`/api/cases/${itemId}/events`).expect(200);
    expect(Array.isArray(events.body.items)).toBe(true);
    expect(events.body.pagination).toBeTruthy();

    const first = await http.put(`/api/cases/${itemId}/documents/body`).send({ body: "Item v1" }).expect(200);
    await http
      .put(`/api/cases/${itemId}/documents/body`)
      .send({ body: "Item v2", baseRevisionId: first.body.revision.id })
      .expect(200);

    const document = await http.get(`/api/cases/${itemId}/documents/body`).expect(200);
    expect(document.body.link.caseId).toBe(itemId);
    expect(document.body.document.latestBody).toBe("Item v2");

    const revisions = await http.get(`/api/cases/${itemId}/documents/body/revisions`).expect(200);
    expect(revisions.body.map((revision: { revisionNumber: number }) => revision.revisionNumber)).toEqual([2, 1]);

    const restored = await http
      .post(`/api/cases/${itemId}/documents/body/revisions/${first.body.revision.id}/restore`)
      .expect(200);
    expect(restored.body.document.latestBody).toBe("Item v1");
    expect(restored.body.restoredFromRevisionNumber).toBe(1);
  });

  it("answers 404, not 500, for a case or pipeline id that matches nothing", async () => {
    const http = request(app);
    // What a case page loads for an identifier no case has, then a pipeline
    // address with an id that is not a uuid.
    for (const path of [
      "/api/cases/NOPE-C404",
      "/api/cases/NOPE-C404/events",
      "/api/cases/NOPE-C404/documents/body",
      "/api/pipelines/not-a-pipeline",
    ]) {
      const response = await http.get(path);
      expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBe(404);
    }
  });
});
