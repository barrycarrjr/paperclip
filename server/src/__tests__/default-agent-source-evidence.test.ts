import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SOURCE_EVIDENCE_INSTRUCTIONS } from "@paperclipai/adapter-utils/source-evidence";
import { loadDefaultAgentInstructionsBundle } from "../services/default-agent-instructions.js";

describe("default onboarding source evidence", () => {
  it.each(["default", "ceo"] as const)("adds the guidance when composing the %s instruction bundle without rewriting its source", async (role) => {
    const sourceUrl = new URL(`../onboarding-assets/${role}/AGENTS.md`, import.meta.url);
    const original = await fs.readFile(sourceUrl, "utf8");
    const bundle = await loadDefaultAgentInstructionsBundle(role);
    expect(bundle["AGENTS.md"]).toBe(`${original}\n\n${SOURCE_EVIDENCE_INSTRUCTIONS}`);
    expect(await fs.readFile(sourceUrl, "utf8")).toBe(original);
    const again = await loadDefaultAgentInstructionsBundle(role);
    expect(again).toEqual(bundle);
    expect(bundle["AGENTS.md"].split(SOURCE_EVIDENCE_INSTRUCTIONS)).toHaveLength(2);
    if (role === "ceo") {
      expect(bundle["HEARTBEAT.md"]).toBe(await fs.readFile(new URL("../onboarding-assets/ceo/HEARTBEAT.md", import.meta.url), "utf8"));
    }
  });
});
