import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const mockMemoryService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  getCompanyMemoryByName: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("../services/memories.js", () => ({
  memoryService: () => mockMemoryService,
}));

const { executeChatTool, getChatTool } = await import("../services/chat-tools.js");

const COMPANY_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_COMPANY_ID = "33333333-3333-3333-3333-333333333333";
const MEMORY_ID = "11111111-1111-1111-1111-111111111111";

const db = {} as unknown as Db;

function ctx(companyIds = [COMPANY_ID]) {
  return {
    db,
    actor: { userId: "user-1", isInstanceAdmin: false, companyIds },
    defaultCompanyId: COMPANY_ID,
  };
}

function memoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MEMORY_ID,
    companyId: COMPANY_ID,
    agentId: null,
    kind: "project",
    name: "Courier",
    description: null,
    content: "Use DHL",
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-10-02T00:00:00Z"),
    ...overrides,
  };
}

describe("Clippy memory tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers remember/forget as mutating and recall as read-only", () => {
    expect(getChatTool("remember")!.mutating).toBe(true);
    expect(getChatTool("forget_memory")!.mutating).toBe(true);
    expect(getChatTool("recall_memories")!.mutating).toBe(false);
  });

  it("remember creates a company-level memory in the current company", async () => {
    mockMemoryService.getCompanyMemoryByName.mockResolvedValue(null);
    mockMemoryService.create.mockResolvedValue(memoryRow());

    const result = await executeChatTool(
      "remember",
      { name: "Courier", content: "Use DHL" },
      ctx(),
    );

    expect(result.ok).toBe(true);
    expect(mockMemoryService.create).toHaveBeenCalledWith(
      COMPANY_ID,
      { name: "Courier", content: "Use DHL", kind: "project", description: null, agentId: null },
      { userId: "user-1", agentId: null },
    );
    expect(mockMemoryService.update).not.toHaveBeenCalled();
    const payload = (result as { result: { replaced: boolean; message: string } }).result;
    expect(payload.replaced).toBe(false);
    expect(payload.message).toContain("encrypted");
  });

  it("remember with an existing name updates instead of duplicating", async () => {
    mockMemoryService.getCompanyMemoryByName.mockResolvedValue(memoryRow());
    mockMemoryService.update.mockResolvedValue(memoryRow({ content: "Use FedEx" }));

    const result = await executeChatTool(
      "remember",
      { name: "Courier", content: "Use FedEx", kind: "feedback" },
      ctx(),
    );

    expect(result.ok).toBe(true);
    expect(mockMemoryService.create).not.toHaveBeenCalled();
    expect(mockMemoryService.update).toHaveBeenCalledWith(MEMORY_ID, {
      content: "Use FedEx",
      kind: "feedback",
    });
    expect((result as { result: { replaced: boolean } }).result.replaced).toBe(true);
  });

  it("remember refuses a company the user cannot access", async () => {
    const result = await executeChatTool(
      "remember",
      { name: "Courier", content: "Use DHL", companyId: OTHER_COMPANY_ID },
      ctx(),
    );
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("No access");
    expect(mockMemoryService.create).not.toHaveBeenCalled();
  });

  it("remember rejects empty content", async () => {
    const result = await executeChatTool("remember", { name: "Courier", content: "   " }, ctx());
    expect(result.ok).toBe(false);
    expect(mockMemoryService.create).not.toHaveBeenCalled();
  });

  it("recall_memories lists the current company's memories with a search term", async () => {
    mockMemoryService.list.mockResolvedValue([memoryRow()]);

    const result = await executeChatTool("recall_memories", { query: "courier" }, ctx());

    expect(result.ok).toBe(true);
    expect(mockMemoryService.list).toHaveBeenCalledWith(COMPANY_ID, { q: "courier", limit: 50 });
    const payload = (result as { result: { memories: Array<{ name: string; content: string }> } })
      .result;
    expect(payload.memories).toEqual([
      expect.objectContaining({ name: "Courier", content: "Use DHL" }),
    ]);
  });

  it("forget_memory deletes by exact name within the current company", async () => {
    mockMemoryService.getCompanyMemoryByName.mockResolvedValue(memoryRow());
    mockMemoryService.remove.mockResolvedValue(memoryRow());

    const result = await executeChatTool("forget_memory", { name: "Courier" }, ctx());

    expect(result.ok).toBe(true);
    expect(mockMemoryService.getCompanyMemoryByName).toHaveBeenCalledWith(COMPANY_ID, "Courier");
    expect(mockMemoryService.remove).toHaveBeenCalledWith(MEMORY_ID);
  });

  it("forget_memory will not delete a memory from another company by id", async () => {
    mockMemoryService.getById.mockResolvedValue(memoryRow({ companyId: OTHER_COMPANY_ID }));

    const result = await executeChatTool("forget_memory", { memoryId: MEMORY_ID }, ctx());

    expect(result.ok).toBe(false);
    expect(mockMemoryService.remove).not.toHaveBeenCalled();
  });

  it("forget_memory needs an id or a name", async () => {
    const result = await executeChatTool("forget_memory", {}, ctx());
    expect(result.ok).toBe(false);
    expect(mockMemoryService.remove).not.toHaveBeenCalled();
  });
});
