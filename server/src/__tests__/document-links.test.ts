import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect } from "vitest";
import { documentReferences, driveIdFromUrl } from "../services/document-links.js";
import { validateKnowledgeBase, validateMemoryFileHeader } from "../services/memory-folder-validator.js";
import { parseMemoryFile, serializeMemoryFile } from "../services/memory-folder-markdown.js";

const A = "FileIdentity_A123";
const B = "FileIdentity_B123";
const note = (name: string, identity: string, content: string) => `---\nname: ${name}\nkind: reference\nupdated: 2026-10-14\n${identity}\n---\n${content}\n`;

describe("declared document references", () => {
  it("reads consistent aliases, blocks disagreement, and exports one canonical identity", () => {
    const source = note("Target", `drive_id: ${A}\ndriveFileId: ${A}`, "Body");
    expect(validateMemoryFileHeader(source).valid).toBe(true);
    expect(parseMemoryFile("target.md", source).driveFileId).toBe(A);
    const parsed = parseMemoryFile("target.md", source);
    const file = serializeMemoryFile({ ...parsed, id: "11111111-1111-4111-8111-111111111111", companyId: "22222222-2222-4222-8222-222222222222", agentId: null, createdByAgentId: null, createdByUserId: null, createdAt: new Date(), updatedAt: new Date() }, null);
    expect(file).toContain(`drive_file_id: ${A}`);
    expect(file).not.toContain("drive_id:");
    const conflict = note("Target", `drive_id: ${A}\ndrive_file_id: ${B}`, "Body");
    expect(validateMemoryFileHeader(conflict).valid).toBe(false);
    expect(parseMemoryFile("target.md", conflict).driveFileId).toBeNull();
  });

  it("recognizes actual inline/reference/wiki links while ignoring examples and unrelated URL IDs", () => {
    const text = `[One](one(1).md "Title") (Drive-ID: ${A})\n[Two][target]\n[[three|Three]]\n[target]: <two note.md>\n\`[example](missing.md)\`\n<!-- [example](missing.md) -->\n\`\`\`markdown\n[example](missing.md)\n\`\`\`\n`;
    const links = documentReferences(text).filter((link) => link.kind !== "definition");
    expect(links.map((link) => [link.target, link.kind])).toEqual([["one(1).md", "inline"], ["<two note.md>", "reference"], ["three", "wiki"]]);
    expect(links[0]?.driveFileId).toBe(A);
    expect(driveIdFromUrl(`https://drive.google.com/file/d/${A}/view`)).toBe(A);
    expect(driveIdFromUrl(`https://docs.google.com/document/d/${A}/edit`)).toBe(A);
    expect(driveIdFromUrl(`https://evil.example/drive.google.com/file/d/${A}`)).toBeNull();
    expect(driveIdFromUrl(`https://drive.google.com.evil.example/file/d/${A}`)).toBeNull();
  });

  it("keeps parentheses inside a quoted inline-link title", () => {
    const links = documentReferences('[Target](target.md "why (")');
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ target: "target.md", kind: "inline" });
  });

  it("scans a dense ordinary note and preserves line locations without prefix rescans", async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-document-links-dense-"));
    try {
      await fs.writeFile(path.join(folder, "target.md"), note("Target", `drive_file_id: ${A}`, "Target"));
      const lines = `[Target](target.md) (Drive-ID: ${A})\n`.repeat(20_000);
      await fs.writeFile(path.join(folder, "source.md"), note("Source", "", lines));
      const references = documentReferences(lines);
      expect(references).toHaveLength(20_000);
      expect(references.at(-1)?.line).toBe(20_000);
      const result = await validateKnowledgeBase(folder, "manual", { driveLinkMode: true });
      expect(result.error).toBeNull();
      expect(result.filesScanned).toBe(2);
      expect(result.findings.filter((finding) => ["missing_drive_id", "conflicting_drive_id", "broken_relative_link"].includes(finding.kind))).toEqual([]);
    } finally { await fs.rm(folder, { recursive: true, force: true }); }
  });

  it("bounds unmatched brackets, parentheses, comments and code runs without hiding later ordinary links", () => {
    expect(documentReferences("[".repeat(500_000))).toEqual([]);
    expect(documentReferences("[a](".repeat(40_000))).toEqual([]);
    expect(documentReferences("[a](<".repeat(40_000))).toEqual([]);
    expect(documentReferences('[a](a.md "'.repeat(40_000))).toEqual([]);
    expect(documentReferences("<!--".repeat(40_000))).toEqual([]);
    const slashTarget = "\\".repeat(200_000) + "a";
    expect(documentReferences(`[Escapes](${slashTarget})`)[0]?.target).toBe(slashTarget);
    const codeRuns = Array.from({ length: 400 }, (_, index) => "Example " + "`".repeat(index + 1) + " text\n").join("");
    const result = documentReferences(codeRuns + `[Actual](actual.md) (Drive-ID: ${A})\n`);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ target: "actual.md", driveFileId: A, line: 401 });
  });

  it("reports paired identity disagreement without replacing the authoritative ID", async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-document-links-validation-"));
    try {
      await fs.writeFile(path.join(folder, "a.md"), note("A", `drive_file_id: ${A}`, "A"));
      await fs.writeFile(path.join(folder, "b.md"), note("B", `drive_file_id: ${B}`, "B"));
      await fs.writeFile(path.join(folder, "source.md"), note("Source", "", `[Wrong](b.md) (Drive-ID: ${A})\n[Missing](a.md)\n[Broken](gone.md) (Drive-ID: unknownFile_123)`));
      const result = await validateKnowledgeBase(folder, "manual", { driveLinkMode: true });
      expect(result.findings).toContainEqual(expect.objectContaining({ kind: "conflicting_drive_id", details: expect.objectContaining({ driveFileId: A, targetDriveFileId: B, suggestedPath: "a.md" }) }));
      expect(result.findings.map((finding) => finding.kind)).toEqual(expect.arrayContaining(["missing_drive_id", "unresolved_drive_id", "broken_relative_link"]));
      const ordinary = await validateKnowledgeBase(folder, "manual");
      expect(ordinary.findings.some((finding) => ["missing_drive_id", "conflicting_drive_id", "unresolved_drive_id"].includes(finding.kind))).toBe(false);
    } finally { await fs.rm(folder, { recursive: true, force: true }); }
  });
});
