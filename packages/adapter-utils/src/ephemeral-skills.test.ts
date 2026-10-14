import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildEphemeralProcedureSkillSnapshot, loadEphemeralProcedures, requireCompleteEphemeralProcedures, renderEphemeralProcedureContext, EPHEMERAL_PROCEDURE_LIMITS } from "./ephemeral-skills.js";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture(files: Record<string, string> = { "SKILL.md": "Read [terms](references/terms.md).", "references/terms.md": "Full terms, final paragraph." }) {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-procedure-test-")); roots.push(source);
  for (const [name, content] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(source, name)), { recursive: true }); await fs.writeFile(path.join(source, name), content); }
  return { source, config: { paperclipRuntimeSkills: [{ key: "company/terms", runtimeName: "terms", source }, { key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", source: path.join(source, "not-read"), required: true }], paperclipSkillSync: { desiredSkills: ["terms"] } } };
}
describe("complete ephemeral procedure bundles", () => {
  it("loads full selected company content, resolves aliases, and leaves native bundled contracts alone", async () => {
    const { config } = await fixture(); const bundle = await loadEphemeralProcedures(config, import.meta.dirname);
    requireCompleteEphemeralProcedures(bundle);
    expect(bundle.requestedKeys).toEqual(["company/terms"]);
    expect(renderEphemeralProcedureContext(bundle.procedures)).toContain("Full terms, final paragraph.");
    const snapshot = await buildEphemeralProcedureSkillSnapshot({ agentId: "a", companyId: "c", adapterType: "ollama_local", config }, import.meta.dirname, { applicationDetail: "Complete text next run." });
    expect(snapshot.mode).toBe("ephemeral");
    expect(snapshot.entries.map(entry => [entry.key, entry.state, entry.targetPath])).toEqual([["company/terms", "configured", null], ["paperclipai/paperclip/paperclip", "available", null]]);
  });
  it("does not read unattached sources or implicitly load required bodies", async () => {
    const { config } = await fixture(); delete (config as Partial<typeof config>).paperclipSkillSync;
    expect((await loadEphemeralProcedures(config, import.meta.dirname)).procedures).toEqual([]);
    config.paperclipSkillSync = { desiredSkills: [] };
    expect((await loadEphemeralProcedures(config, import.meta.dirname)).requestedKeys).toEqual([]);
  });
  it.each([
    [{ "SKILL.md": "[missing](missing.md)" }, "missing"],
    [{ "SKILL.md": "[details][guide]\n\n[guide]: references/missing.md" }, "missing"],
    [{ "SKILL.md": "[escape](../terms.md)" }, "missing"],
    [{ "SKILL.md": "[absolute](file:///etc/passwd)" }, "escaping"],
    [{ "SKILL.md": "Run `scripts/run.py`.", "scripts/run.py": "print('secret')" }, "unsupported"],
    [{ "SKILL.md": "body", "asset.txt": "\0binary" }, "binary"],
    [{ "README.md": "missing main" }, "SKILL.md"],
  ])("rejects incomplete or unavailable resources without partial success %s", async (files, message) => {
    const { config } = await fixture(files); const bundle = await loadEphemeralProcedures(config, import.meta.dirname);
    expect(bundle.procedures).toEqual([]); expect(() => requireCompleteEphemeralProcedures(bundle)).toThrow(message);
  });
  it("reads through short reads to EOF and still rejects oversized content", async () => {
    const original = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      const read = handle.read.bind(handle);
      handle.read = ((buffer: Buffer, offset: number, length: number, position: number) => read(buffer, offset, Math.min(length, 37), position)) as typeof handle.read;
      return handle;
    });
    const complete = await fixture({ "SKILL.md": "x".repeat(1000) + "LAST" });
    expect((await loadEphemeralProcedures(complete.config, import.meta.dirname)).procedures[0]?.files[0]?.content).toHaveLength(1004);
    const oversize = await fixture({ "SKILL.md": "x".repeat(EPHEMERAL_PROCEDURE_LIMITS.fileBytes + 2) });
    expect((await loadEphemeralProcedures(oversize.config, import.meta.dirname)).errors[0]?.message).toContain("per-file");
  });
  it("rejects unknown selected keys and hides filesystem error paths", async () => {
    const { config } = await fixture(); config.paperclipSkillSync.desiredSkills = ["unknown"];
    const bundle = await loadEphemeralProcedures(config, import.meta.dirname);
    expect(() => requireCompleteEphemeralProcedures(bundle)).toThrow("unavailable");
    config.paperclipRuntimeSkills[0]!.source = "/private/secret-directory"; config.paperclipSkillSync.desiredSkills = ["terms"];
    expect(JSON.stringify((await loadEphemeralProcedures(config, import.meta.dirname)).errors)).not.toContain("secret-directory");
  });
  it("rejects a linked resource directory", async () => {
    const { source, config } = await fixture({ "SKILL.md": "body" }); const outside = await fixture({ "SKILL.md": "private" });
    await fs.symlink(outside.source, path.join(source, "references"), "junction");
    const awaited = await loadEphemeralProcedures(config, import.meta.dirname);
    expect(() => requireCompleteEphemeralProcedures(awaited)).toThrow();
    expect(awaited.errors[0]?.message).toContain("linked");
  });
  it("loads an explicitly selected required company procedure", async () => {
    const { config } = await fixture(); config.paperclipRuntimeSkills[0]!.required = true;
    expect((await loadEphemeralProcedures(config, import.meta.dirname)).procedures[0]?.key).toBe("company/terms");
  });
  it("loads a required company procedure without an explicit preference", async () => {
    const { config } = await fixture(); config.paperclipRuntimeSkills[0]!.required = true;
    delete (config as Partial<typeof config>).paperclipSkillSync;
    const bundle = await loadEphemeralProcedures(config, import.meta.dirname);
    requireCompleteEphemeralProcedures(bundle);
    expect(bundle.requestedKeys).toEqual(["company/terms"]);
    expect(bundle.procedures[0]?.key).toBe("company/terms");
    expect(renderEphemeralProcedureContext(bundle.procedures)).toContain("Full terms, final paragraph.");
  });
  it("keeps normal and angle-bracket web citations without claiming document retrieval", async () => {
    const { config } = await fixture({ "SKILL.md": "[web](<https://example.invalid/guide>)\n[web][source]\n[source]: <https://example.invalid/guide>\n[mail](<mailto:team@example.invalid>)" });
    const bundle = await loadEphemeralProcedures(config, import.meta.dirname);
    expect(bundle.errors).toEqual([]); expect(bundle.procedures).toHaveLength(1);
  });
  it("bounds per-file UTF-8 bytes and total complete text", async () => {
    const { config } = await fixture({ "SKILL.md": "é".repeat(EPHEMERAL_PROCEDURE_LIMITS.fileBytes) });
    expect((await loadEphemeralProcedures(config, import.meta.dirname)).errors[0]?.message).toContain("per-file");
    const total = await fixture({ "SKILL.md": "a".repeat(60_000), "a.txt": "a".repeat(60_000), "b.txt": "a".repeat(60_000) });
    expect((await loadEphemeralProcedures(total.config, import.meta.dirname)).errors[0]?.message).toContain("total");
  });
  it("bounds selected procedures, directory depth and resource count", async () => {
    const depth = await fixture({ "SKILL.md": "body", "a/b/c/d/e/deep.md": "too deep" });
    expect((await loadEphemeralProcedures(depth.config, import.meta.dirname)).errors[0]?.message).toContain("depth");
    const count = await fixture(Object.fromEntries([["SKILL.md", "body"], ...Array.from({ length: 65 }, (_, i) => [`${i}.md`, "resource"])]));
    expect((await loadEphemeralProcedures(count.config, import.meta.dirname)).errors[0]?.message).toContain("count");
    const many = await fixture(); many.config.paperclipSkillSync.desiredSkills = Array.from({ length: 9 }, (_, i) => `company/${i}`);
    expect((await loadEphemeralProcedures(many.config, import.meta.dirname)).errors[0]?.message).toContain("Too many");
  });
  it("rejects invalid UTF-8 rather than replacing bytes silently", async () => {
    const { source, config } = await fixture({ "SKILL.md": "body" }); await fs.writeFile(path.join(source, "SKILL.md"), Buffer.from([0xc3, 0x28]));
    expect((await loadEphemeralProcedures(config, import.meta.dirname)).errors[0]?.message).toContain("UTF-8");
  });
  it("rejects a changed file during bounded reading", async () => {
    const { source, config } = await fixture({ "SKILL.md": "original" }); const original = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args); const read = handle.read.bind(handle); let changed = false;
      handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await read(buffer, offset, length, position);
        if (!changed) { changed = true; await fs.appendFile(path.join(source, "SKILL.md"), "changed"); }
        return result;
      }) as typeof handle.read; return handle;
    });
    expect((await loadEphemeralProcedures(config, import.meta.dirname)).errors[0]?.message).toContain("changed");
  });
});
