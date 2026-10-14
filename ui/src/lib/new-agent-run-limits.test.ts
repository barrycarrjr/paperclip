import { describe, expect, it } from "vitest";
import { buildClaudeLocalConfig } from "@paperclipai/adapter-claude-local/ui";
import { buildCodexLocalConfig } from "@paperclipai/adapter-codex-local/ui";
import { buildCursorLocalConfig } from "@paperclipai/adapter-cursor-local/ui";
import { buildGeminiLocalConfig } from "@paperclipai/adapter-gemini-local/ui";
import { buildGrokLocalConfig } from "@paperclipai/adapter-grok-local/ui";
import { buildKimiLocalConfig } from "@paperclipai/adapter-kimi-local/ui";
import { buildOpenCodeLocalConfig } from "@paperclipai/adapter-opencode-local/ui";
import { buildPiLocalConfig } from "@paperclipai/adapter-pi-local/ui";
import { buildHermesConfig } from "@paperclipai/hermes-paperclip-adapter/ui";
import { buildProcessConfig } from "../adapters/process/build-config";
import { buildAiderLocalConfig } from "../adapters/aider-local/build-config";
import { buildOllamaLocalConfig } from "../adapters/ollama-local/build-config";
import { defaultCreateValues } from "../components/agent-config-defaults";
import { buildNewAgentHirePayload } from "./new-agent-hire-payload";

const builders = [
  ["claude_local", buildClaudeLocalConfig],
  ["codex_local", buildCodexLocalConfig],
  ["cursor", buildCursorLocalConfig],
  ["gemini_local", buildGeminiLocalConfig],
  ["grok_local", buildGrokLocalConfig],
  ["kimi_local", buildKimiLocalConfig],
  ["opencode_local", buildOpenCodeLocalConfig],
  ["pi_local", buildPiLocalConfig],
  ["process", buildProcessConfig],
  ["aider_local", buildAiderLocalConfig],
  ["ollama_local", buildOllamaLocalConfig],
] as const;

describe("new local agent run limits", () => {
  it.each(builders)("sends finite default caps when hiring with %s", (adapterType, build) => {
    const configValues = { ...defaultCreateValues, adapterType };
    const payload = buildNewAgentHirePayload({
      name: "New agent",
      effectiveRole: "general",
      configValues,
      adapterConfig: build(configValues),
    });
    expect(payload.adapterConfig).toMatchObject({ timeoutSec: 300, maxTurnsPerRun: 100 });
  });

  it.each(builders)("preserves an explicitly chosen zero turn cap with %s", (adapterType, build) => {
    expect(build({ ...defaultCreateValues, adapterType, maxTurnsPerRun: 0 }).maxTurnsPerRun).toBe(0);
  });

  it("keeps Hermes's computed timeout as the turn cap grows", () => {
    expect(buildHermesConfig(defaultCreateValues)).toMatchObject({ maxTurnsPerRun: 100, timeoutSec: 2000 });
    expect(buildHermesConfig({ ...defaultCreateValues, maxTurnsPerRun: 200 })).toMatchObject({ maxTurnsPerRun: 200, timeoutSec: 4000 });
  });
});
