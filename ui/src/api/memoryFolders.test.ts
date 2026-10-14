import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("./client", () => ({ api: mockApi }));

import { memoryFoldersApi } from "./memoryFolders";

describe("memoryFoldersApi knowledge-base actions", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.post.mockReset();
  });

  it("uses the company-scoped findings and index endpoints", async () => {
    await memoryFoldersApi.findings("company-1");
    await memoryFoldersApi.rebuildIndex("company-1");

    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/memory-folder/findings");
    expect(mockApi.post).toHaveBeenCalledWith("/companies/company-1/memory-folder/index", {});
  });

  it("uses the company-scoped Drive-link preview and apply endpoints", async () => {
    await memoryFoldersApi.previewLinks("company-1");
    await memoryFoldersApi.applyLinks("company-1", "a".repeat(64));

    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/memory-folder/links/preview");
    expect(mockApi.post).toHaveBeenCalledWith(
      "/companies/company-1/memory-folder/links/apply",
      { planHash: "a".repeat(64) },
    );
  });
});
