import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companyAgentDefaults, createDb, instanceSettings } from "@paperclipai/db";
import { companyAgentDefaultsService } from "../services/company-agent-defaults.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.ts";

async function closeDbClient(db: ReturnType<typeof createDb> | undefined) {
  await db?.$client?.end?.({ timeout: 0 });
}

describe("companyAgentDefaultsService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof companyAgentDefaultsService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let otherCompanyId = "";

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-company-agent-defaults-");
    db = createDb(started.connectionString);
    svc = companyAgentDefaultsService(db);
    tempDb = started;
  }, 120_000);

  afterEach(async () => {
    await db.delete(companyAgentDefaults);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  async function seedCompanies() {
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Strict Co", issuePrefix: `S${companyId.slice(0, 5).toUpperCase()}` },
      { id: otherCompanyId, name: "Other Co", issuePrefix: `O${otherCompanyId.slice(0, 5).toUpperCase()}` },
    ]);
  }

  it("returns empty defaults for a company with no row", async () => {
    await seedCompanies();
    expect(await svc.get(companyId)).toEqual({ skipPermissionsByAdapterType: {} });
  });

  it("stores per-company values, keeps companies apart and clears on null", async () => {
    await seedCompanies();
    const first = await svc.update(companyId, { skipPermissionsByAdapterType: { claude_local: false, codex_local: false } });
    expect(first.previous).toEqual({ skipPermissionsByAdapterType: {} });
    expect(first.next).toEqual({ skipPermissionsByAdapterType: { claude_local: false, codex_local: false } });

    const second = await svc.update(companyId, { skipPermissionsByAdapterType: { codex_local: null } });
    expect(second.next).toEqual({ skipPermissionsByAdapterType: { claude_local: false } });
    expect(await svc.get(otherCompanyId)).toEqual({ skipPermissionsByAdapterType: {} });
  });

  it("fills the inherited value into a run config in the documented order", async () => {
    await seedCompanies();
    await instanceSettingsService(db).updateAgentDefaults({
      skipPermissionsByAdapterType: { claude_local: true, codex_local: false },
    });
    await svc.update(companyId, { skipPermissionsByAdapterType: { claude_local: false } });

    const companyWins: Record<string, unknown> = {};
    expect(
      await svc.applyRunPermissionDefault({ companyId, adapterType: "claude_local", config: companyWins }),
    ).toMatchObject({ source: "company", skipPermissions: false });
    expect(companyWins.dangerouslySkipPermissions).toBe(false);

    const instanceWins: Record<string, unknown> = {};
    await svc.applyRunPermissionDefault({ companyId: otherCompanyId, adapterType: "claude_local", config: instanceWins });
    expect(instanceWins.dangerouslySkipPermissions).toBe(true);

    const codex: Record<string, unknown> = {};
    await svc.applyRunPermissionDefault({ companyId, adapterType: "codex_local", config: codex });
    expect(codex.dangerouslyBypassApprovalsAndSandbox).toBe(false);

    const codeDefault: Record<string, unknown> = {};
    await svc.applyRunPermissionDefault({ companyId, adapterType: "opencode_local", config: codeDefault });
    expect(codeDefault.dangerouslySkipPermissions).toBe(true);

    const agentOwn: Record<string, unknown> = { dangerouslySkipPermissions: true };
    expect(
      await svc.applyRunPermissionDefault({ companyId, adapterType: "claude_local", config: agentOwn }),
    ).toMatchObject({ source: "agent" });
    expect(agentOwn.dangerouslySkipPermissions).toBe(true);

    const other: Record<string, unknown> = {};
    expect(await svc.applyRunPermissionDefault({ companyId, adapterType: "http", config: other })).toBeNull();
    expect(other).toEqual({});
  });

  it("removes the row when the company is deleted", async () => {
    await seedCompanies();
    await svc.update(companyId, { skipPermissionsByAdapterType: { claude_local: false } });
    await db.delete(companies);
    expect(await db.select().from(companyAgentDefaults)).toEqual([]);
  });
});
