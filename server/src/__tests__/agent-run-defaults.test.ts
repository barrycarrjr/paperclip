import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { agentService } from "../services/agents.js";

function fakeDb() {
  const inserted: Record<string, unknown>[] = [];
  const db = {
    select: () => ({ from: () => ({ where: async () => [] }) }),
    insert: () => ({ values: (input: Record<string, unknown>) => {
      inserted.push(input);
      return { returning: async () => [{ id: "new-agent", ...input }] };
    } }),
    update: vi.fn(),
  };
  return { db: db as unknown as Db, inserted };
}

describe("agent creation run defaults", () => {
  it.each(["process", "claude_local", "codex_local", "cursor", "gemini_local", "grok_local", "kimi_local", "opencode_local", "pi_local", "aider_local", "ollama_local"])(
    "persists finite missing caps for %s", async (adapterType) => {
      const { db, inserted } = fakeDb();
      const agent = await agentService(db).create("company-1", { name: "New agent", adapterType, adapterConfig: { model: "chosen" } });
      expect(inserted[0].adapterConfig).toEqual({ model: "chosen", timeoutSec: 300, maxTurnsPerRun: 100 });
      expect(agent.adapterConfig).toEqual(inserted[0].adapterConfig);
    },
  );

  it.each([{ timeoutSec: 0, maxTurnsPerRun: 0 }, { timeoutSec: 900, maxTurnsPerRun: 250 }])(
    "preserves explicitly supplied caps %j", async (adapterConfig) => {
      const { db, inserted } = fakeDb();
      await agentService(db).create("company-1", { name: "New agent", adapterType: "claude_local", adapterConfig });
      expect(inserted[0].adapterConfig).toEqual(adapterConfig);
    },
  );

  it.each(["http", "cursor_cloud", "hermes_local", "hermes_gateway", "openclaw_gateway", "external_adapter"])(
    "preserves specialized adapter defaults for %s", async (adapterType) => {
      const { db, inserted } = fakeDb();
      await agentService(db).create("company-1", { name: "New agent", adapterType, adapterConfig: {} });
      expect(inserted[0].adapterConfig).toEqual({});
    },
  );
});
