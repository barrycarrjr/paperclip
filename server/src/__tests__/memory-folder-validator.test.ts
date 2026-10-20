import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { Stats } from "node:fs";
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
const ownedFolders = new Map<string, { realPath: string; parent: string; stat: Stats; marker: string }>();

async function createFixtureFolder(prefix: string): Promise<string> {
  const parent = await fs.realpath(os.tmpdir());
  const target = await fs.mkdtemp(path.join(parent, prefix));
  const realPath = await fs.realpath(target);
  if (path.dirname(realPath) !== parent) throw new Error("Fixture escaped its temporary parent");
  const stat = await fs.lstat(target);
  const marker = randomUUID();
  await fs.writeFile(path.join(target, ".fixture-owner"), marker, { flag: "wx" });
  ownedFolders.set(target, { realPath, parent, stat, marker });
  return target;
}

async function removeFixtureFolder(target: string): Promise<void> {
  const owned = ownedFolders.get(target);
  if (!owned) throw new Error("Refusing to remove an unowned fixture");
  const current = await fs.lstat(target);
  const realPath = await fs.realpath(target);
  if (
    current.isSymbolicLink() || !current.isDirectory() ||
    current.dev !== owned.stat.dev || current.ino !== owned.stat.ino ||
    realPath !== owned.realPath || path.dirname(realPath) !== owned.parent ||
    await fs.readFile(path.join(target, ".fixture-owner"), "utf8") !== owned.marker
  ) throw new Error("Refusing to remove a changed fixture");
  await fs.rm(target, { recursive: true, force: true });
  ownedFolders.delete(target);
}

beforeEach(async () => {
  folder = await createFixtureFolder("paperclip-kb-validator-");
});

afterEach(async () => {
  await removeFixtureFolder(folder);
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
    const outside = await createFixtureFolder("paperclip-kb-read-outside-");
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
      await removeFixtureFolder(outside);
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

  it.each(["decision", "outcome"])("does not recommend changing an old, unlinked %s record", async (recordType) => {
    await fs.mkdir(path.join(folder, "records"));
    const recordPath = `records/${recordType}.md`;
    const original = note(
      `name: Dated record\nkind: project\nstatus: active\nupdated: 2026-01-01\nrecord_type: ${recordType}`,
      "Evidence recorded on that date.",
    );
    await fs.writeFile(path.join(folder, recordPath), original);

    const result = await validateKnowledgeBase(folder, "manual", { now: new Date("2026-10-19T00:00:00Z") });
    expect(result.error).toBeNull();
    expect(result.filesScanned).toBe(1);
    expect(result.findings).toEqual([]);
    expect(await fs.readFile(path.join(folder, recordPath), "utf8")).toBe(original);
  });

  it.each([
    ["ordinary", ""],
    ["unknown", "record_type: memo"],
    ["capitalized decision", "record_type: Decision"],
    ["capitalized outcome", "record_type: OUTCOME"],
    ["list value", "record_type: [decision]"],
    ["object value", "record_type: {type: outcome}"],
    ["empty value", "record_type:"],
    ["comment suffix", "record_type: decision # dated"],
  ])("retains stale and orphan findings for an %s note", async (_label, recordField) => {
    await fs.writeFile(
      path.join(folder, "old.md"),
      note(`name: Ordinary note\nkind: project\nstatus: active\nupdated: 2026-01-01\n${recordField}`, "No links."),
    );

    const result = await validateKnowledgeBase(folder, "manual", { now: new Date("2026-10-19T00:00:00Z") });
    expect(result.error).toBeNull();
    expect(result.findings).toEqual([
      expect.objectContaining({ kind: "orphan_note", path: "old.md" }),
      expect.objectContaining({ kind: "stale_active_note", path: "old.md" }),
    ]);
  });

  it.each(["decision", "outcome"])("keeps header, broken-link and GAP findings on a %s record", async (recordType) => {
    await fs.writeFile(
      path.join(folder, "record.md"),
      note(
        `name: Dated record\nkind: invalid\nstatus: active\nupdated: 2026-01-01\nrecord_type: ${recordType}`,
        "[Missing evidence](missing.md)\nGAP: confirm the evidence",
      ),
    );

    const result = await validateKnowledgeBase(folder, "manual", { now: new Date("2026-10-19T00:00:00Z") });
    expect(result.error).toBeNull();
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "malformed_frontmatter", path: "record.md" }),
      expect.objectContaining({ kind: "broken_relative_link", path: "record.md", details: expect.objectContaining({ target: "missing.md" }) }),
      expect.objectContaining({ kind: "open_gap", path: "record.md" }),
    ]));
  });

  it("does not interpret a multiline record type as an exemption", async () => {
    await fs.writeFile(
      path.join(folder, "old.md"),
      note("name: Old\nkind: project\nstatus: active\nupdated: 2026-01-01\nrecord_type:\n  - decision", "No links."),
    );
    const result = await validateKnowledgeBase(folder, "manual", { now: new Date("2026-10-19T00:00:00Z") });
    expect(result.error).toBeNull();
    expect(result.findings).toEqual([
      expect.objectContaining({ kind: "malformed_frontmatter", path: "old.md" }),
      expect.objectContaining({ kind: "stale_active_note", path: "old.md" }),
    ]);
  });

  it("accepts an outcome's matching Drive link to a decision without changing either record", async () => {
    const decision = note(
      "name: Decision\nkind: project\nstatus: active\nupdated: 2026-01-01\nrecord_type: decision\ndrive_file_id: example-decision-id",
      "Original decision.",
    );
    const outcome = note(
      "name: Outcome\nkind: project\nstatus: active\nupdated: 2026-01-02\nrecord_type: outcome\ndrive_file_id: example-outcome-id",
      "[Decision](decision.md) (Drive-ID: example-decision-id)",
    );
    await fs.writeFile(path.join(folder, "decision.md"), decision);
    await fs.writeFile(path.join(folder, "outcome.md"), outcome);

    const result = await validateKnowledgeBase(folder, "manual", { now: new Date("2026-10-19T00:00:00Z"), driveLinkMode: true });
    expect(result.error).toBeNull();
    expect(result.filesScanned).toBe(2);
    expect(result.findings).toEqual([]);
    expect(await fs.readFile(path.join(folder, "decision.md"), "utf8")).toBe(decision);
    expect(await fs.readFile(path.join(folder, "outcome.md"), "utf8")).toBe(outcome);
  });

  it("still reports Drive identity and annotation problems on dated records", async () => {
    const records = [
      ["decision.md", "decision", "drive_file_id: example-decision-id", "Original decision."],
      ["other.md", "decision", "drive_file_id: example-other-id", "Another decision."],
      ["duplicate.md", "decision", "drive_file_id: example-other-id", "Duplicate identity."],
      ["invalid.md", "outcome", "drive_file_id: bad id", "Invalid declared identity."],
      ["aliases.md", "outcome", "drive_file_id: example-alias-one\ndrive_id: example-alias-two", "Conflicting aliases."],
      ["outcome.md", "outcome", "drive_file_id: example-outcome-id", [
        "[Missing annotation](decision.md)",
        "[Invalid annotation](decision.md) (Drive-ID: bad!)",
        "[Wrong identity](decision.md) (Drive-ID: example-other-id)",
        "[Unknown identity](decision.md) (Drive-ID: example-missing-id)",
      ].join("\n")],
    ];
    for (const [fileName, recordType, identity, body] of records) {
      await fs.writeFile(path.join(folder, fileName!), note(
        `name: Dated record\nkind: project\nstatus: active\nupdated: 2026-01-01\nrecord_type: ${recordType}\n${identity}`,
        body!,
      ));
    }

    const result = await validateKnowledgeBase(folder, "manual", { now: new Date("2026-10-19T00:00:00Z"), driveLinkMode: true });
    expect(result.error).toBeNull();
    expect(result.filesScanned).toBe(6);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "invalid_drive_id", path: "invalid.md" }),
      expect.objectContaining({ kind: "invalid_drive_id", path: "aliases.md" }),
      expect.objectContaining({ kind: "missing_drive_id", path: "outcome.md", line: 9 }),
      expect.objectContaining({ kind: "invalid_drive_id", path: "outcome.md", line: 10 }),
      expect.objectContaining({ kind: "conflicting_drive_id", path: "outcome.md", line: 11 }),
      expect.objectContaining({ kind: "duplicate_drive_id", path: "outcome.md", line: 11 }),
      expect.objectContaining({ kind: "unresolved_drive_id", path: "outcome.md", line: 12 }),
    ]));
    expect(result.findings.some((item) => item.kind === "stale_active_note" || item.kind === "orphan_note")).toBe(false);
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
    const outside = await createFixtureFolder("paperclip-kb-outside-");
    try {
      await fs.writeFile(path.join(outside, "secret.md"), note("name: Secret\nkind: reference\nupdated: 2026-10-14", "Private"));
      await fs.symlink(outside, path.join(folder, "linked"), "dir");
      const result = await validateKnowledgeBase(folder, "manual");
      expect(result.filesScanned).toBe(0);
      expect(result.findings).toEqual([expect.objectContaining({ kind: "unsafe_entry", path: "linked" })]);
    } finally {
      await removeFixtureFolder(outside);
    }
  });

  it.skipIf(process.platform === "win32")("refuses a file swapped to an outside symlink after opening", async () => {
    const outside = await createFixtureFolder("paperclip-kb-swap-");
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
      await removeFixtureFolder(outside);
    }
  });
});

describe("knowledge-base index", () => {
  it("refuses a configured-root junction swap during root validation", async () => {
    const outside = await createFixtureFolder("paperclip-kb-write-outside-");
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
      await removeFixtureFolder(outside);
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
