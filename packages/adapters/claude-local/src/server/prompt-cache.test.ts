import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareClaudePromptBundle } from "./prompt-cache.js";

describe("Claude prompt cache", () => {
  const cleanupDirs: string[] = [];
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalInstanceId;
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await fs.rm(dir, { recursive: true, force: true });
    }
  });

  async function prepare(contents: string) {
    return prepareClaudePromptBundle({
      companyId: "company-cache-test",
      skills: [],
      instructionsContents: contents,
      onLog: async () => {},
    });
  }

  it("repairs altered cached instruction bytes and reports the repair", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-cache-"));
    cleanupDirs.push(home);
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "cache-test";

    const first = await prepare("Keep the approved rule.\n");
    expect(first.instructionsFilePath).not.toBeNull();
    expect(first.instructionsFileRepaired).toBe(false);
    await fs.writeFile(first.instructionsFilePath!, "altered by the agent\n", "utf8");

    const second = await prepare("Keep the approved rule.\n");

    expect(second.instructionsFilePath).toBe(first.instructionsFilePath);
    expect(second.instructionsFileRepaired).toBe(true);
    await expect(fs.readFile(second.instructionsFilePath!, "utf8")).resolves.toBe(
      "Keep the approved rule.\n",
    );
  });

  it("fails when an altered cache file cannot be atomically replaced", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-cache-fail-"));
    cleanupDirs.push(home);
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "cache-fail-test";

    const first = await prepare("Keep the approved rule.\n");
    await fs.writeFile(first.instructionsFilePath!, "altered by the agent\n", "utf8");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename denied"));

    await expect(prepare("Keep the approved rule.\n")).rejects.toThrow(
      "Failed to materialize exact Claude prompt cache file",
    );
    await expect(fs.readFile(first.instructionsFilePath!, "utf8")).resolves.toBe(
      "altered by the agent\n",
    );
  });
});
