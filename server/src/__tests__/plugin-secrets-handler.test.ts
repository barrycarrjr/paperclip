import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, pluginConfig, plugins } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createPluginSecretsHandler } from "../services/plugin-secrets-handler.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin secrets handler tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * The enumeration budget in plugin-secrets-handler.ts. Kept as a local literal
 * so a change to the production constant has to be a deliberate edit here too.
 */
const UNKNOWN_REF_LIMIT = 30;

describeEmbeddedPostgres("plugin secrets handler rate limiting", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-secrets-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(pluginConfig);
    await db.delete(plugins);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function manifest(pluginKey: string): PaperclipPluginManifestV1 {
    return {
      id: pluginKey,
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Secrets Test",
      description: "Exercises the host-side secret resolution handler.",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: ["secrets.read-ref"],
      entrypoints: { worker: "./dist/worker.js" },
    };
  }

  /**
   * Install a plugin whose config points at one real secret, mirroring an
   * email plugin holding an IMAP password.
   */
  async function installPluginWithSecret() {
    const companyId = randomUUID();
    const suffix = companyId.replace(/-/g, "").slice(0, 8).toUpperCase();
    await db.insert(companies).values({
      id: companyId,
      name: `Acme ${suffix}`,
      // issue_prefix carries a unique index, so each fixture company needs
      // its own value or the second insert in a file collides.
      issuePrefix: suffix,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const secret = await secretService(db).create(companyId, {
      name: "IMAP_PERSONAL_PASS",
      provider: "local_encrypted",
      value: "hunter2",
    });

    const pluginId = randomUUID();
    const pluginKey = `paperclip.secretstest.${pluginId.slice(0, 8)}`;
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey,
      packageName: pluginKey,
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: manifest(pluginKey),
      status: "ready",
      installOrder: 1,
    });
    await db.insert(pluginConfig).values({
      id: randomUUID(),
      pluginId,
      configJson: { mailboxes: [{ key: "personal", pass: secret.id }] },
    });

    return { pluginId, secretRef: secret.id };
  }

  it("resolves a configured secret far more often than the enumeration budget", async () => {
    const { pluginId, secretRef } = await installPluginWithSecret();
    const handler = createPluginSecretsHandler({ db, pluginId });

    // A mail plugin resolves its password on every IMAP connection. Bursting
    // well past the enumeration budget is normal traffic, not an attack. This
    // used to start failing at attempt 31 and surfaced to the operator as a
    // bridge 502 mid-triage.
    for (let i = 0; i < UNKNOWN_REF_LIMIT * 3; i++) {
      await expect(handler.resolve({ secretRef })).resolves.toBe("hunter2");
    }
  });

  it("still cuts off enumeration of refs outside the plugin's config", async () => {
    const { pluginId } = await installPluginWithSecret();
    const handler = createPluginSecretsHandler({ db, pluginId });

    // Unknown refs report "not found" until the budget is spent.
    for (let i = 0; i < UNKNOWN_REF_LIMIT; i++) {
      await expect(handler.resolve({ secretRef: randomUUID() })).rejects.toThrow(
        /Secret not found/,
      );
    }

    await expect(handler.resolve({ secretRef: randomUUID() })).rejects.toThrow(
      /Rate limit exceeded/,
    );
  });

  it("charges malformed refs against the enumeration budget", async () => {
    const { pluginId } = await installPluginWithSecret();
    const handler = createPluginSecretsHandler({ db, pluginId });

    for (let i = 0; i < UNKNOWN_REF_LIMIT; i++) {
      await expect(handler.resolve({ secretRef: `not-a-uuid-${i}` })).rejects.toThrow(
        /Invalid secret reference/,
      );
    }

    await expect(handler.resolve({ secretRef: "not-a-uuid-final" })).rejects.toThrow(
      /Rate limit exceeded/,
    );
  });

  it("keeps a spent enumeration budget from blocking the plugin's own secret", async () => {
    const { pluginId, secretRef } = await installPluginWithSecret();
    const handler = createPluginSecretsHandler({ db, pluginId });

    for (let i = 0; i < UNKNOWN_REF_LIMIT + 5; i++) {
      await handler.resolve({ secretRef: randomUUID() }).catch(() => undefined);
    }

    await expect(handler.resolve({ secretRef })).resolves.toBe("hunter2");
  });
});
