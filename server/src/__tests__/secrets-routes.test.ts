import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  companies,
  companySecrets,
  companySecretVersions,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { secretRoutes } from "../routes/secrets.js";
import { errorHandler } from "../middleware/index.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres secret route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("secret routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  const priorMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;

  beforeAll(async () => {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = Buffer.alloc(32, 15).toString("base64");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-secret-routes-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (priorMasterKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY = priorMasterKey;
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "local_implicit",
        userId: null,
        companyIds: [companyId],
      };
      next();
    });
    app.use("/api", secretRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function createSecret(app: express.Express, name: string) {
    return request(app)
      .post(`/api/companies/${companyId}/secrets`)
      .send({ name, value: `value for ${name}` });
  }

  it("creates a secret under the name a renamed secret used to have", async () => {
    const app = createApp();
    const original = await createSecret(app, "Stripe key");
    expect(original.status, JSON.stringify(original.body)).toBe(201);
    const renamed = await request(app)
      .patch(`/api/secrets/${original.body.id}`)
      .send({ name: "Stripe key (old)" });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);

    const reused = await createSecret(app, "Stripe key");

    expect(reused.status, JSON.stringify(reused.body)).toBe(201);
    expect(reused.body.key).not.toBe(original.body.key);
    const listed = await request(app).get(`/api/companies/${companyId}/secrets`);
    expect(listed.body.map((secret: { name: string }) => secret.name).sort()).toEqual([
      "Stripe key",
      "Stripe key (old)",
    ]);
  });

  it("creates a secret named after the key migration 0102 gave an older secret", async () => {
    const app = createApp();
    const older = await createSecret(app, "Stripe Key");
    expect(older.status, JSON.stringify(older.body)).toBe(201);
    // The key migration 0102 filled in for secrets that existed before it.
    await db.execute(sql`
      UPDATE "company_secrets"
      SET "key" = LOWER(REGEXP_REPLACE("name", '[^a-zA-Z0-9_]+', '_', 'g'))
      WHERE "id" = ${older.body.id}
    `);

    const created = await createSecret(app, "stripe_key");

    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.name).toBe("stripe_key");
  });

  it("gives each new secret its own key when several names map to the same one", async () => {
    const app = createApp();
    const created: Awaited<ReturnType<typeof createSecret>>[] = [];
    for (const name of ["Stripe Key", "stripe-key", "STRIPE KEY!", "!!!"]) {
      created.push(await createSecret(app, name));
    }

    for (const response of created) {
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    }
    const keys = created.map((response) => response.body.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toBe("stripe-key");
    expect(keys[3]).toBe(created[3].body.id);
  });

  it("creates a secret whose key another secret took at the same moment", async () => {
    const app = createApp();
    const createVersion = localEncryptedProvider.createVersion;
    // The other secret is saved after this one's key check and before its
    // insert, as when two requests arrive together.
    const encrypt = vi.spyOn(localEncryptedProvider, "createVersion").mockImplementationOnce(async (input) => {
      await secretService(db).create(companyId, {
        name: "Stripe Key",
        provider: "local_encrypted",
        value: "the other value",
      });
      return createVersion.call(localEncryptedProvider, input);
    });

    try {
      const created = await createSecret(app, "stripe-key");

      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const keysByName = Object.fromEntries(
        (await db.select().from(companySecrets)).map((secret) => [secret.name, secret.key]),
      );
      expect(keysByName).toEqual({
        "Stripe Key": "stripe-key",
        "stripe-key": `stripe-key-${created.body.id}`,
      });
    } finally {
      encrypt.mockRestore();
    }
  });

  it("refuses a secret name longer than 200 characters, when created or renamed", async () => {
    const app = createApp();

    const tooLong = await createSecret(app, "K".repeat(201));
    expect(tooLong.status).toBe(400);

    const longest = await createSecret(app, "K".repeat(200));
    expect(longest.status, JSON.stringify(longest.body)).toBe(201);
    const renamed = await request(app)
      .patch(`/api/secrets/${longest.body.id}`)
      .send({ name: "R".repeat(201) });
    expect(renamed.status).toBe(400);
  });
});
