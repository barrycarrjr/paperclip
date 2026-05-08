import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, instanceSettings } from "@paperclipai/db";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.ts";

async function closeDbClient(db: ReturnType<typeof createDb> | undefined) {
  await db?.$client?.end?.({ timeout: 0 });
}

describe("instanceSettingsService — agent defaults", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof instanceSettingsService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-instance-agent-defaults-");
    db = createDb(started.connectionString);
    svc = instanceSettingsService(db);
    tempDb = started;
  }, 120_000);

  afterEach(async () => {
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  it("returns an empty default when nothing has been configured", async () => {
    const result = await svc.getAgentDefaults();
    expect(result).toEqual({ defaultModelByAdapterType: {} });
  });

  it("persists a default model for an adapter type", async () => {
    await svc.updateAgentDefaults({
      defaultModelByAdapterType: { claude_local: "claude-opus-4-7" },
    });

    const result = await svc.getAgentDefaults();
    expect(result).toEqual({
      defaultModelByAdapterType: { claude_local: "claude-opus-4-7" },
    });
  });

  it("merges a new adapter type into existing defaults instead of replacing", async () => {
    await svc.updateAgentDefaults({
      defaultModelByAdapterType: { claude_local: "claude-opus-4-7" },
    });
    await svc.updateAgentDefaults({
      defaultModelByAdapterType: { codex_local: "gpt-5" },
    });

    const result = await svc.getAgentDefaults();
    expect(result).toEqual({
      defaultModelByAdapterType: {
        claude_local: "claude-opus-4-7",
        codex_local: "gpt-5",
      },
    });
  });

  it("clears an entry when an empty string is sent for that adapter type", async () => {
    await svc.updateAgentDefaults({
      defaultModelByAdapterType: {
        claude_local: "claude-opus-4-7",
        codex_local: "gpt-5",
      },
    });

    await svc.updateAgentDefaults({
      defaultModelByAdapterType: { claude_local: "" },
    });

    const result = await svc.getAgentDefaults();
    expect(result).toEqual({
      defaultModelByAdapterType: { codex_local: "gpt-5" },
    });
  });

  it("preserves other settings sections when updating agent defaults", async () => {
    await svc.updateGeneral({ keyboardShortcuts: true });
    await svc.updateAgentDefaults({
      defaultModelByAdapterType: { claude_local: "claude-opus-4-7" },
    });

    const all = await svc.get();
    expect(all.general.keyboardShortcuts).toBe(true);
    expect(all.agentDefaults.defaultModelByAdapterType).toEqual({
      claude_local: "claude-opus-4-7",
    });
  });

  it("round-trips defaults across service instances reading the same DB", async () => {
    await svc.updateAgentDefaults({
      defaultModelByAdapterType: { claude_local: "claude-opus-4-7" },
    });

    const fresh = instanceSettingsService(db);
    const result = await fresh.getAgentDefaults();
    expect(result).toEqual({
      defaultModelByAdapterType: { claude_local: "claude-opus-4-7" },
    });
  });
});
