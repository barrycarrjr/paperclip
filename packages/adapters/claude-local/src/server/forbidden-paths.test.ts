import { describe, expect, it } from "vitest";
import { buildClaudeForbiddenPathRules, buildClaudeForbiddenPathSettings } from "./forbidden-paths.js";

describe("buildClaudeForbiddenPathRules", () => {
  it("returns no rules for an empty, missing or malformed list", () => {
    expect(buildClaudeForbiddenPathRules([]).denyRules).toEqual([]);
    expect(buildClaudeForbiddenPathRules(null).denyRules).toEqual([]);
    expect(buildClaudeForbiddenPathRules("**/AGENTS.md").denyRules).toEqual([]);
    expect(buildClaudeForbiddenPathRules([42, "  ", null]).denyRules).toEqual([]);
  });

  it("denies each pattern as given and anchored at the filesystem root", () => {
    expect(buildClaudeForbiddenPathRules(["**/AGENTS.md", ".claude/agents/**"]).denyRules).toEqual([
      "Edit(**/AGENTS.md)",
      "Edit(//**/AGENTS.md)",
      "Edit(.claude/agents/**)",
      "Edit(//**/.claude/agents/**)",
    ]);
  });

  it("does not re-anchor patterns that are already absolute or home-relative", () => {
    expect(buildClaudeForbiddenPathRules(["//etc/hosts", "~/secrets/**"]).denyRules).toEqual([
      "Edit(//etc/hosts)",
      "Edit(~/secrets/**)",
    ]);
  });

  it("strips leading ./ and **/ before anchoring, and drops duplicates", () => {
    expect(buildClaudeForbiddenPathRules(["./SOUL.md", "**/SOUL.md", " ./SOUL.md "]).denyRules).toEqual([
      "Edit(./SOUL.md)",
      "Edit(//**/SOUL.md)",
      "Edit(**/SOUL.md)",
    ]);
  });

  it("skips patterns with parentheses rather than writing a broken rule", () => {
    const result = buildClaudeForbiddenPathRules(["notes(1).md", "**/AGENTS.md"]);
    expect(result.skipped).toEqual(["notes(1).md"]);
    expect(result.denyRules).toEqual(["Edit(**/AGENTS.md)", "Edit(//**/AGENTS.md)"]);
  });
});

describe("buildClaudeForbiddenPathSettings", () => {
  it("is null with no rules, and a permissions.deny JSON object otherwise", () => {
    expect(buildClaudeForbiddenPathSettings([])).toBeNull();
    expect(JSON.parse(buildClaudeForbiddenPathSettings(["Edit(**/AGENTS.md)"])!)).toEqual({
      permissions: { deny: ["Edit(**/AGENTS.md)"] },
    });
  });
});
