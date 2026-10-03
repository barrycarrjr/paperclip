import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CreateMemory, Memory, UpdateMemory } from "@paperclipai/shared";
import {
  expandHomePath,
  normalizeFolderPath,
  runMemoryFolder,
  type MemoryFolderDeps,
} from "../services/memory-folder-sync.js";
import { INDEX_FILE, parseMemoryFile } from "../services/memory-folder-markdown.js";

const COMPANY_ID = "22222222-2222-2222-2222-222222222222";
const AGENT_ID = "33333333-3333-3333-3333-333333333333";

/** In-memory stand-in for memoryService: enough of list/create/update to drive the sync. */
function fakeMemories(seed: Memory[] = []) {
  const rows = new Map(seed.map((m) => [m.id, m]));
  let counter = 0;
  const api = {
    rows,
    list: async (companyId: string) =>
      [...rows.values()]
        .filter((m) => m.companyId === companyId)
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    create: async (companyId: string, data: CreateMemory & { agentId?: string | null }) => {
      counter += 1;
      const id = `aaaaaaaa-aaaa-aaaa-aaaa-${String(counter).padStart(12, "0")}`;
      const row: Memory = {
        id,
        companyId,
        agentId: data.agentId ?? null,
        kind: data.kind,
        name: data.name,
        description: data.description ?? null,
        content: data.content,
        createdByAgentId: null,
        createdByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      rows.set(id, row);
      return row;
    },
    update: async (id: string, data: UpdateMemory) => {
      const row = rows.get(id);
      if (!row) return null;
      const next: Memory = { ...row, ...data, description: data.description ?? row.description, updatedAt: new Date() } as Memory;
      rows.set(id, next);
      return next;
    },
  };
  return api;
}

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    companyId: COMPANY_ID,
    agentId: null,
    kind: "project",
    name: "Courier",
    description: "Which courier we use",
    content: "Use DHL.",
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-10-02T12:30:00Z"),
    ...overrides,
  };
}

function depsFor(memories: ReturnType<typeof fakeMemories>): MemoryFolderDeps {
  return {
    memories: memories as unknown as MemoryFolderDeps["memories"],
    agents: { list: async () => [{ id: AGENT_ID, name: "Ops Bot" }] },
    companyName: async () => "Acme",
  };
}

let folder: string;

beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-memory-folder-"));
});

afterEach(async () => {
  await fs.rm(folder, { recursive: true, force: true });
});

describe("memory folder paths", () => {
  it("expands ~ and rejects relative paths", () => {
    expect(expandHomePath("~/memory/acme")).toBe(path.join(os.homedir(), "memory/acme"));
    expect(path.isAbsolute(normalizeFolderPath("~/memory/acme"))).toBe(true);
    expect(() => normalizeFolderPath("memory/acme")).toThrow(/absolute/);
  });
});

describe("memory folder export", () => {
  it("writes one markdown file per memory plus an index, naming agent-scoped files by agent", async () => {
    const memories = fakeMemories([
      memory(),
      memory({ id: "11111111-1111-1111-1111-111111111112", name: "Courier", agentId: AGENT_ID, content: "Bot: use UPS." }),
    ]);
    const result = await runMemoryFolder(depsFor(memories), COMPANY_ID, folder, "export", "manual");

    expect(result.error).toBeNull();
    expect(result.exported).toBe(2);
    const files = (await fs.readdir(folder)).sort();
    expect(files).toEqual(["MEMORY.md", "courier${sep}ops-bot.md".replace("${sep}", "--"), "courier.md"].sort());

    const parsed = parseMemoryFile("courier.md", await fs.readFile(path.join(folder, "courier.md"), "utf8"));
    expect(parsed.content).toBe("Use DHL.");
    expect(parsed.paperclipId).toBe("11111111-1111-1111-1111-111111111111");

    const index = await fs.readFile(path.join(folder, INDEX_FILE), "utf8");
    expect(index).toContain("# Acme memories");
    expect(index).toContain("(agent: Ops Bot)");
  });

  it("removes files it wrote for memories that no longer exist, but keeps hand-written files", async () => {
    const memories = fakeMemories([memory()]);
    await runMemoryFolder(depsFor(memories), COMPANY_ID, folder, "export", "manual");
    await fs.writeFile(path.join(folder, "mine.md"), "A note someone typed by hand.\n", "utf8");

    memories.rows.clear();
    const result = await runMemoryFolder(depsFor(memories), COMPANY_ID, folder, "export", "manual");

    expect(result.removed).toBe(1);
    const files = (await fs.readdir(folder)).sort();
    expect(files).toEqual(["MEMORY.md", "mine.md"]);
  });

  it("creates the folder when it does not exist yet", async () => {
    const nested = path.join(folder, "deeper", "acme");
    const result = await runMemoryFolder(depsFor(fakeMemories([memory()])), COMPANY_ID, nested, "export", "manual");
    expect(result.error).toBeNull();
    expect(await fs.readdir(nested)).toContain("courier.md");
  });
});

describe("memory folder import", () => {
  it("creates memories from new files, with or without front matter", async () => {
    await fs.writeFile(path.join(folder, "Shipping rules.md"), "Ship on Tuesdays.\n", "utf8");
    await fs.writeFile(
      path.join(folder, "bot-note.md"),
      "---\nname: Bot note\nkind: feedback\nagent: ops bot\n---\nAlways confirm before cancelling.\n",
      "utf8",
    );
    const memories = fakeMemories();
    const result = await runMemoryFolder(depsFor(memories), COMPANY_ID, folder, "import", "manual");

    expect(result.error).toBeNull();
    expect(result.created).toBe(2);
    const rows = [...memories.rows.values()];
    expect(rows.find((r) => r.name === "Shipping rules")).toMatchObject({ kind: "reference", agentId: null });
    expect(rows.find((r) => r.name === "Bot note")).toMatchObject({ kind: "feedback", agentId: AGENT_ID });
  });

  it("updates a memory when the file is newer and differs, and leaves it when Paperclip is newer", async () => {
    const memories = fakeMemories([memory({ updatedAt: new Date("2026-10-02T12:30:00Z") })]);
    const deps = depsFor(memories);
    await runMemoryFolder(deps, COMPANY_ID, folder, "export", "manual");

    // A hand edit later than Paperclip's copy wins.
    const file = path.join(folder, "courier.md");
    const edited = (await fs.readFile(file, "utf8")).replace("Use DHL.", "Use FedEx.");
    await fs.writeFile(file, edited, "utf8");
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(file, future, future);

    let result = await runMemoryFolder(deps, COMPANY_ID, folder, "import", "manual");
    expect(result.updated).toBe(1);
    expect(memories.rows.get("11111111-1111-1111-1111-111111111111")?.content).toBe("Use FedEx.");

    // Now Paperclip is newer than the file: the file is not applied.
    const row = memories.rows.get("11111111-1111-1111-1111-111111111111")!;
    memories.rows.set(row.id, { ...row, content: "Use DHL again.", updatedAt: new Date(Date.now() + 120_000) });
    result = await runMemoryFolder(deps, COMPANY_ID, folder, "import", "manual");
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(memories.rows.get(row.id)?.content).toBe("Use DHL again.");
  });

  it("skips cloud-sync conflict copies and empty files with a warning", async () => {
    await fs.writeFile(path.join(folder, "courier (conflicted copy 2026-10-03).md"), "x", "utf8");
    await fs.writeFile(path.join(folder, "empty.md"), "---\nname: Empty\n---\n", "utf8");
    const memories = fakeMemories();
    const result = await runMemoryFolder(depsFor(memories), COMPANY_ID, folder, "import", "manual");

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.warnings.join("\n")).toMatch(/conflict/);
    expect(result.warnings.join("\n")).toMatch(/no content/);
  });

  it("imports a file naming an unknown agent company-wide, with a warning", async () => {
    await fs.writeFile(path.join(folder, "n.md"), "---\nname: N\nagent: Nobody\n---\nbody\n", "utf8");
    const memories = fakeMemories();
    const result = await runMemoryFolder(depsFor(memories), COMPANY_ID, folder, "import", "manual");
    expect(result.created).toBe(1);
    expect([...memories.rows.values()][0].agentId).toBeNull();
    expect(result.warnings[0]).toMatch(/Nobody/);
  });

  it("reports a missing folder as a warning rather than an error", async () => {
    const result = await runMemoryFolder(depsFor(fakeMemories()), COMPANY_ID, path.join(folder, "missing"), "import", "manual");
    expect(result.error).toBeNull();
    expect(result.warnings[0]).toMatch(/does not exist/);
  });
});

describe("memory folder sync", () => {
  it("imports first, then exports, leaving the folder in canonical form", async () => {
    await fs.writeFile(path.join(folder, "Hand written.md"), "Typed by a person.\n", "utf8");
    const memories = fakeMemories([memory()]);
    const result = await runMemoryFolder(depsFor(memories), COMPANY_ID, folder, "sync", "scheduled");

    expect(result.error).toBeNull();
    expect(result.created).toBe(1);
    expect(result.exported).toBe(2);
    const text = await fs.readFile(path.join(folder, "hand-written.md"), "utf8");
    expect(parseMemoryFile("hand-written.md", text).paperclipId).not.toBeNull();
    // The original hand-written file (different slug casing) is left alone: it has no paperclip id.
    expect(await fs.readdir(folder)).toContain("Hand written.md");

    // A second sync changes nothing.
    const again = await runMemoryFolder(depsFor(memories), COMPANY_ID, folder, "sync", "scheduled");
    expect(again.created).toBe(0);
    expect(again.updated).toBe(0);
  });
});
