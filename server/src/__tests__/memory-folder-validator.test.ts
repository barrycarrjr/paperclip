import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ACTIVE_NOTE_STALE_DAYS,
  readMemoryFolderFileSafely,
  regenerateKnowledgeBaseIndex,
  validateKnowledgeBase,
  validateMemoryFileHeader,
  writeMemoryFolderFileAtomically,
} from "../services/memory-folder-validator.js";

function note(fields: string, body: string): string {
  return `---\n${fields.trim()}\n---\n${body.trim()}\n`;
}

let folder: string;

beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-kb-validator-"));
});

afterEach(async () => {
  await fs.rm(folder, { recursive: true, force: true });
});

describe("memory note frontmatter", () => {
  it("requires the canonical fields without removing lenient legacy readability", () => {
    expect(validateMemoryFileHeader("Legacy body only.\n")).toMatchObject({
      valid: false,
      problems: expect.arrayContaining([
        "missing opening frontmatter delimiter",
        "required field name is missing",
        "required field kind is missing",
        "required field updated is missing",
      ]),
    });
    expect(validateMemoryFileHeader(note("name: Current\nkind: reference\nupdated: 2026-10-14", "Body"))).toMatchObject({ valid: true });
    expect(validateMemoryFileHeader(note("name: Bad\nkind: banana\nupdated: someday", "Body"))).toMatchObject({ valid: false });
    expect(validateMemoryFileHeader(note("name: Bad date\nkind: reference\nupdated: 2026-02-31", "Body"))).toMatchObject({ valid: false });
  });
});

describe("knowledge-base validation", () => {
  it("refuses a configured-root junction swap before reading outside the root", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-kb-read-outside-"));
    const held = `${folder}-held`;
    const fileName = "note.md";
    await fs.writeFile(path.join(folder, fileName), "INSIDE\n", "utf8");
    await fs.writeFile(path.join(outside, fileName), "OUTSIDE\n", "utf8");
    const realpath = fs.realpath.bind(fs);
    let rootRealpathCalls = 0;
    const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
      const result = await realpath(...args);
      if (String(args[0]) === folder && ++rootRealpathCalls === 2) {
        await fs.rename(folder, held);
        await fs.symlink(outside, folder, process.platform === "win32" ? "junction" : "dir");
      }
      return result;
    });
    try {
      await expect(readMemoryFolderFileSafely(folder, path.join(folder, fileName))).rejects.toThrow(/folder changed/);
    } finally {
      realpathSpy.mockRestore();
      try {
        await fs.unlink(folder);
      } catch {
        // The swap may have failed before the junction was created.
      }
      try {
        await fs.rename(held, folder);
      } catch {
        // The original directory may not have moved.
      }
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("reports every deterministic finding type and excludes generated, archived, and superseded notes", async () => {
    await fs.mkdir(path.join(folder, "09-Archive"));
    await fs.mkdir(path.join(folder, "Archived"));
    await fs.mkdir(path.join(folder, "_Superseded"));
    await fs.mkdir(path.join(folder, "superseded"));
    await fs.writeFile(
      path.join(folder, "active.md"),
      note(
        "name: Active\nkind: project\nstatus: active\nupdated: 2026-01-01\ndriveId: bad id",
        "[Known](known.md)\n[Missing](missing.md)\n- [ ] GAP: confirm owner",
      ),
    );
    await fs.writeFile(
      path.join(folder, "known.md"),
      note("name: Known\nkind: reference\nupdated: 2026-10-10", "[[active]]"),
    );
    await fs.writeFile(
      path.join(folder, "orphan.md"),
      note("name: Orphan\nkind: reference\nupdated: 2026-10-10", "No links."),
    );
    await fs.writeFile(
      path.join(folder, "09-Archive", "old.md"),
      note("name: Old\nkind: reference\nstatus: active\nupdated: 2020-01-01", "Archived by path."),
    );
    await fs.writeFile(
      path.join(folder, "Archived", "old.md"),
      note("name: Old archived\nkind: reference\nupdated: 2020-01-01", "Archived by path."),
    );
    await fs.writeFile(
      path.join(folder, "_Superseded", "old.md"),
      note("name: Old underscore\nkind: reference\nstatus: active\nupdated: 2020-01-01", "Superseded by path."),
    );
    await fs.writeFile(
      path.join(folder, "superseded", "old.md"),
      note("name: Old plain\nkind: reference\nstatus: active\nupdated: 2020-01-01", "Superseded by path."),
    );
    await fs.writeFile(
      path.join(folder, "superseded.md"),
      note("name: Superseded\nkind: reference\nstatus: superseded\nupdated: 2020-01-01", "Old."),
    );
    await fs.writeFile(path.join(folder, "malformed.md"), "Readable legacy text.\n");
    await fs.writeFile(path.join(folder, "MEMORY.md"), "[Missing](does-not-exist.md)\nGAP: ignored\n");

    const first = await validateKnowledgeBase(folder, "manual", { now: new Date("2026-10-14T00:00:00Z") });
    const second = await validateKnowledgeBase(folder, "manual", { now: new Date("2026-10-14T00:00:00Z") });
    expect(second).toEqual(first);
    expect(first.error).toBeNull();
    expect(first.filesScanned).toBe(9);
    expect(new Set(first.findings.map((item) => item.kind))).toEqual(new Set([
      "broken_relative_link",
      "invalid_drive_id",
      "malformed_frontmatter",
      "open_gap",
      "orphan_note",
      "stale_active_note",
    ]));
    expect(first.findings.filter((item) => item.kind === "orphan_note").map((item) => item.path)).toEqual(["orphan.md"]);
    expect(first.findings.filter((item) => item.kind === "stale_active_note").map((item) => item.path)).toEqual(["active.md"]);
    expect(first.findings.filter((item) => item.kind === "invalid_drive_id").map((item) => item.path)).toEqual(["active.md"]);
    expect(first.findings.filter((item) => item.kind === "malformed_frontmatter").map((item) => item.path)).toEqual(["malformed.md"]);
    expect(first.findings.every((item) => item.path !== "MEMORY.md")).toBe(true);
    expect(DEFAULT_ACTIVE_NOTE_STALE_DAYS).toBe(90);
  });

  it("treats traversal and absolute filesystem links as broken", async () => {
    await fs.writeFile(
      path.join(folder, "links.md"),
      note(
        "name: Links\nkind: reference\nupdated: 2026-10-14",
        "[Outside](../secret.md)\n[Absolute](/tmp/secret.md)\n[Windows](C:\\private\\secret.md)\n[UNC](\\\\server\\share\\secret.md)",
      ),
    );
    const result = await validateKnowledgeBase(folder, "manual");
    expect(result.findings.filter((item) => item.kind === "broken_relative_link")).toHaveLength(4);
  });

  it("treats an old canonical note without optional status as active", async () => {
    await fs.writeFile(
      path.join(folder, "old.md"),
      note("name: Old\nkind: reference\nupdated: 2020-01-01", "Still current."),
    );
    const result = await validateKnowledgeBase(folder, "manual", { now: new Date("2026-10-14T00:00:00Z") });
    expect(result.findings).toContainEqual(expect.objectContaining({ kind: "stale_active_note", path: "old.md" }));
  });

  it("does not let a self-link hide an orphan note", async () => {
    await fs.writeFile(
      path.join(folder, "self.md"),
      note("name: Self\nkind: reference\nupdated: 2026-10-14", "[Self](self.md)"),
    );
    const result = await validateKnowledgeBase(folder, "manual", { now: new Date("2026-10-14T00:00:00Z") });
    expect(result.findings).toContainEqual(expect.objectContaining({ kind: "orphan_note", path: "self.md" }));
  });

  it("ignores Markdown-like examples inside fenced code", async () => {
    await fs.writeFile(
      path.join(folder, "examples.md"),
      note(
        "name: Examples\nkind: reference\nupdated: 2026-10-14",
        "```markdown\n[Example](missing.md)\nGAP: example only\n```",
      ),
    );
    const result = await validateKnowledgeBase(folder, "manual");
    expect(result.findings.some((item) => item.kind === "broken_relative_link")).toBe(false);
    expect(result.findings.some((item) => item.kind === "open_gap")).toBe(false);
  });

  it("ignores links in inline code without hiding ordinary links", async () => {
    await fs.writeFile(
      path.join(folder, "examples.md"),
      note(
        "name: Examples\nkind: reference\nupdated: 2026-10-14",
        "Use `[Example](missing-example.md)` for formatting, then follow [Actual](missing-real.md).",
      ),
    );
    const result = await validateKnowledgeBase(folder, "manual");
    expect(result.findings.filter((item) => item.kind === "broken_relative_link")).toEqual([
      expect.objectContaining({ details: expect.objectContaining({ target: "missing-real.md" }) }),
    ]);
  });

  it.runIf(process.platform === "win32")("matches relative links with Windows filesystem case semantics", async () => {
    await fs.writeFile(path.join(folder, "MEMORY.md"), "Generated index.\n");
    await fs.writeFile(
      path.join(folder, "note.md"),
      note("name: Note\nkind: reference\nupdated: 2026-10-14", "[Index](MEMORY.MD)"),
    );
    const result = await validateKnowledgeBase(folder, "manual");
    expect(result.findings.some((item) => item.kind === "broken_relative_link")).toBe(false);
  });

  it.skipIf(process.platform === "win32")("does not follow linked entries", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-kb-outside-"));
    try {
      await fs.writeFile(path.join(outside, "secret.md"), note("name: Secret\nkind: reference\nupdated: 2026-10-14", "Private"));
      await fs.symlink(outside, path.join(folder, "linked"), "dir");
      const result = await validateKnowledgeBase(folder, "manual");
      expect(result.filesScanned).toBe(0);
      expect(result.findings).toEqual([expect.objectContaining({ kind: "unsafe_entry", path: "linked" })]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("refuses a file swapped to an outside symlink after opening", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-kb-swap-"));
    const file = path.join(folder, "note.md");
    try {
      await fs.writeFile(file, note("name: Safe\nkind: reference\nupdated: 2026-10-14", "Safe"));
      const outsideFile = path.join(outside, "outside.md");
      await fs.writeFile(outsideFile, note("name: Outside\nkind: reference\nupdated: 2026-10-14", "Outside"));
      let swapped = false;
      const result = await validateKnowledgeBase(folder, "manual", {
        afterFileOpen: async (relativePath) => {
          if (relativePath !== "note.md" || swapped) return;
          swapped = true;
          await fs.rm(file);
          await fs.symlink(outsideFile, file, "file");
        },
      });
      expect(result.findings).toEqual([expect.objectContaining({ kind: "unsafe_entry", path: "note.md" })]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe("knowledge-base index", () => {
  it("refuses a configured-root junction swap during root validation", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-kb-write-outside-"));
    const held = `${folder}-held`;
    const outsideIndex = path.join(outside, "MEMORY.md");
    await fs.writeFile(outsideIndex, "ORIGINAL OUTSIDE\n", "utf8");
    const realpath = fs.realpath.bind(fs);
    let rootRealpathCalls = 0;
    const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
      const result = await realpath(...args);
      if (String(args[0]) === folder && ++rootRealpathCalls === 2) {
        await fs.rename(folder, held);
        await fs.symlink(outside, folder, process.platform === "win32" ? "junction" : "dir");
      }
      return result;
    });
    try {
      await expect(writeMemoryFolderFileAtomically(
        folder,
        path.join(folder, "MEMORY.md"),
        "EXPORTED COMPANY CONTENT\n",
      )).rejects.toThrow(/folder changed|linked path/);
      expect(await fs.readFile(outsideIndex, "utf8")).toBe("ORIGINAL OUTSIDE\n");
      expect((await fs.readdir(outside)).filter((name) => name.startsWith(".memory-write."))).toEqual([]);
    } finally {
      realpathSpy.mockRestore();
      try {
        await fs.unlink(folder);
      } catch {
        // The swap may have failed before the junction was created.
      }
      try {
        await fs.rename(held, folder);
      } catch {
        // The original directory may not have moved.
      }
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("rebuilds a sorted index from frontmatter atomically and becomes a no-op", async () => {
    await fs.mkdir(path.join(folder, "nested"));
    await fs.writeFile(path.join(folder, "z.md"), note("name: Zed\nkind: user\nupdated: 2026-10-14", "Z"));
    await fs.writeFile(
      path.join(folder, "nested", "a note.md"),
      note("name: Alpha\nkind: project\ndescription: First\nupdated: 2026-10-14", "A"),
    );

    const first = await regenerateKnowledgeBaseIndex(folder, "Acme", new Date("2026-10-14T12:00:00Z"));
    const text = await fs.readFile(path.join(folder, "MEMORY.md"), "utf8");
    expect(first).toEqual({ indexedAt: "2026-10-14T12:00:00.000Z", filesIndexed: 2, changed: true });
    expect(text.indexOf("Alpha")).toBeLessThan(text.indexOf("Zed"));
    expect(text).toContain("nested/a%20note.md");
    expect((await fs.readdir(folder)).filter((name) => name.startsWith(".MEMORY.md."))).toEqual([]);

    await fs.writeFile(
      path.join(folder, "nested", "a note.md"),
      note("name: Alpha revised\nkind: project\ndescription: First\nupdated: 2026-10-15", "A"),
    );
    const replaced = await regenerateKnowledgeBaseIndex(folder, "Acme", new Date("2026-10-15T12:00:00Z"));
    expect(replaced).toEqual({ indexedAt: "2026-10-15T12:00:00.000Z", filesIndexed: 2, changed: true });
    expect(await fs.readFile(path.join(folder, "MEMORY.md"), "utf8")).toContain("Alpha revised");

    const second = await regenerateKnowledgeBaseIndex(folder, "Acme", new Date("2026-10-16T12:00:00Z"));
    expect(second).toEqual({ indexedAt: "2026-10-16T12:00:00.000Z", filesIndexed: 2, changed: false });
  });

  it("refuses to replace the existing index when a note is malformed", async () => {
    await fs.writeFile(path.join(folder, "MEMORY.md"), "keep this index\n");
    await fs.writeFile(path.join(folder, "legacy.md"), "legacy\n");
    await expect(regenerateKnowledgeBaseIndex(folder, "Acme")).rejects.toThrow(/not replaced/);
    expect(await fs.readFile(path.join(folder, "MEMORY.md"), "utf8")).toBe("keep this index\n");
  });
});
