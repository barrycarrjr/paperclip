import { describe, expect, it } from "vitest";
import type { Memory } from "@paperclipai/shared";
import {
  isSkippedFileName,
  memoryFileName,
  parseMemoryFile,
  serializeIndex,
  serializeMemoryFile,
  slugify,
} from "../services/memory-folder-markdown.js";

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    companyId: "22222222-2222-2222-2222-222222222222",
    agentId: null,
    kind: "project",
    name: "Courier",
    description: "Which courier we use",
    content: "Use DHL for anything over 5 kg.\nUPS otherwise.",
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-10-02T12:30:00Z"),
    ...overrides,
  };
}

describe("memory folder markdown", () => {
  it("slugifies names into safe file names", () => {
    expect(slugify("Customer: Smith & Sons (NY)")).toBe("customer-smith-sons-ny");
    expect(slugify("Café résumé")).toBe("cafe-resume");
    expect(slugify("***")).toBe("memory");
    expect(memoryFileName({ name: "Courier" }, null)).toBe("courier.md");
    expect(memoryFileName({ name: "Courier" }, "Ops Bot")).toBe("courier--ops-bot.md");
  });

  it("round-trips a memory through serialize and parse", () => {
    const text = serializeMemoryFile(memory(), null);
    expect(text.startsWith("---\nname: Courier\nkind: project\n")).toBe(true);
    const parsed = parseMemoryFile("courier.md", text);
    expect(parsed).toMatchObject({
      name: "Courier",
      kind: "project",
      description: "Which courier we use",
      agent: null,
      paperclipId: "11111111-1111-1111-1111-111111111111",
      content: "Use DHL for anything over 5 kg.\nUPS otherwise.",
    });
  });

  it("quotes names that YAML would misread and parses them back", () => {
    const text = serializeMemoryFile(memory({ name: "Note: colons, #hashes", description: null }), "Ops Bot");
    expect(text).toContain('name: "Note: colons, #hashes"');
    expect(text).toContain("agent: Ops Bot");
    const parsed = parseMemoryFile("x.md", text);
    expect(parsed.name).toBe("Note: colons, #hashes");
    expect(parsed.agent).toBe("Ops Bot");
    expect(parsed.description).toBeNull();
  });

  it("treats a bare markdown file as a company-wide reference memory named after the file", () => {
    const parsed = parseMemoryFile("Shipping rules.md", "Ship on Tuesdays.\r\n");
    expect(parsed).toEqual({
      name: "Shipping rules",
      kind: "reference",
      description: null,
      agent: null,
      paperclipId: null,
      content: "Ship on Tuesdays.",
    });
  });

  it("falls back to reference for an unknown kind and ignores a malformed id", () => {
    const parsed = parseMemoryFile("a.md", "---\nkind: banana\npaperclip_id: nope\n---\nbody");
    expect(parsed.kind).toBe("reference");
    expect(parsed.paperclipId).toBeNull();
    expect(parsed.content).toBe("body");
  });

  it("skips the index, hidden files, non-markdown and cloud-sync conflict copies", () => {
    expect(isSkippedFileName("MEMORY.md")).toBe(true);
    expect(isSkippedFileName("README.md")).toBe(true);
    expect(isSkippedFileName(".DS_Store")).toBe(true);
    expect(isSkippedFileName("notes.txt")).toBe(true);
    expect(isSkippedFileName("courier (conflicted copy 2026-10-03).md")).toBe(true);
    expect(isSkippedFileName("courier (Barry's conflicted copy 2026-10-03).md")).toBe(true);
    expect(isSkippedFileName("courier (conflict 1).md")).toBe(true);
    expect(isSkippedFileName("courier.md")).toBe(false);
    expect(isSkippedFileName("Shipping Rules.MD")).toBe(false);
  });

  it("writes a sorted index with scope and description", () => {
    const text = serializeIndex("Acme", [
      { fileName: "zeta.md", name: "Zeta", kind: "user", description: null, agentName: null },
      { fileName: "alpha--bot.md", name: "Alpha", kind: "project", description: "First", agentName: "Bot" },
    ]);
    const lines = text.split("\n");
    expect(lines[0]).toBe("# Acme memories");
    expect(lines).toContain("- [Alpha](alpha--bot.md) [project] (agent: Bot) - First");
    expect(lines).toContain("- [Zeta](zeta.md) [user]");
    expect(lines.indexOf("- [Alpha](alpha--bot.md) [project] (agent: Bot) - First")).toBeLessThan(
      lines.indexOf("- [Zeta](zeta.md) [user]"),
    );
  });
});
