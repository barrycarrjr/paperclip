import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres secrets service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("secretService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("secrets-service");
    stopDb = started.stop;
    db = createDb(started.connectionString);
  });

  afterAll(async () => {
    if (stopDb) await stopDb();
  });

  it("includes agent env reference summaries without exposing adapter config", async () => {
    const companyId = randomUUID();
    const referencedAgentId = randomUUID();
    const unreferencedAgentId = randomUUID();
    const svc = secretService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const secret = await svc.create(companyId, {
      name: "OPENAI_API_KEY",
      provider: "local_encrypted",
      value: "test-value",
      description: "Used by Codex",
    });

    await db.insert(agents).values([
      {
        id: referencedAgentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {
          env: {
            OPENAI_API_KEY: {
              type: "secret_ref",
              secretId: secret.id,
              version: "latest",
            },
            SECOND_OPENAI_KEY: {
              type: "secret_ref",
              secretId: secret.id,
              version: "latest",
            },
            PLAIN_VALUE: {
              type: "plain",
              value: "visible",
            },
          },
        },
        runtimeConfig: {},
        permissions: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: unreferencedAgentId,
        companyId,
        name: "NoSecrets",
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: {
          env: {
            PLAIN_ONLY: {
              type: "plain",
              value: "ok",
            },
          },
        },
        runtimeConfig: {},
        permissions: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const listed = await svc.listWithAgentReferences(companyId);

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: secret.id,
      name: "OPENAI_API_KEY",
      agentReferences: [
        {
          agentId: referencedAgentId,
          agentName: "CodexCoder",
          envKeys: ["OPENAI_API_KEY", "SECOND_OPENAI_KEY"],
        },
      ],
    });
  });

  it("resolves secret_ref by secretName at persistence time", async () => {
    const companyId = randomUUID();
    const svc = secretService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "ByName Co",
      issuePrefix: "BYN",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const secret = await svc.create(companyId, {
      name: "WORKSNAPS_API_TOKEN",
      provider: "local_encrypted",
      value: "wsnap-token",
      description: null,
    });

    const normalized = await svc.normalizeAdapterConfigForPersistence(companyId, {
      env: {
        WORKSNAPS_API_TOKEN: { type: "secret_ref", secretName: "WORKSNAPS_API_TOKEN" },
      },
    });

    expect(normalized.env).toEqual({
      WORKSNAPS_API_TOKEN: {
        type: "secret_ref",
        secretId: secret.id,
        version: "latest",
      },
    });
  });

  it("rejects secret_ref by secretName when the named secret is missing", async () => {
    const companyId = randomUUID();
    const svc = secretService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "MissingName Co",
      issuePrefix: "MIS",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      svc.normalizeAdapterConfigForPersistence(companyId, {
        env: {
          NOT_THERE: { type: "secret_ref", secretName: "NOT_THERE" },
        },
      }),
    ).rejects.toThrow(/Secret not found in company: NOT_THERE/);
  });

  it("rejects secret_ref with both secretId and secretName", async () => {
    const companyId = randomUUID();
    const svc = secretService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Both Co",
      issuePrefix: "BTH",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const secret = await svc.create(companyId, {
      name: "DOUBLED",
      provider: "local_encrypted",
      value: "x",
      description: null,
    });

    await expect(
      svc.normalizeAdapterConfigForPersistence(companyId, {
        env: {
          DOUBLED: { type: "secret_ref", secretId: secret.id, secretName: "DOUBLED" },
        },
      }),
    ).rejects.toThrow(/Invalid environment binding for key: DOUBLED/);
  });
});
