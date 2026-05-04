import { describe, expect, it, vi } from "vitest";
import { assertWriteAllowed, ForbiddenWritePathError } from "../services/agent-forbidden-paths.js";

function makeDb(forbidden: string[] | null) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn((resolve) =>
            Promise.resolve(resolve(forbidden === null ? [] : [{ forbidden }])),
          ),
        }),
      }),
    }),
  } as unknown as Parameters<typeof assertWriteAllowed>[0];
}

const AGENT_ID = "00000000-0000-4000-8000-000000000001";

describe("assertWriteAllowed", () => {
  it("returns cleanly when no candidate paths supplied", async () => {
    const db = makeDb(["plugins/**"]);
    await expect(assertWriteAllowed(db, AGENT_ID, [])).resolves.toBeUndefined();
  });

  it("returns cleanly when agent has no forbidden patterns", async () => {
    const db = makeDb([]);
    await expect(
      assertWriteAllowed(db, AGENT_ID, ["server/src/foo.ts", "ui/Bar.tsx"]),
    ).resolves.toBeUndefined();
  });

  it("throws ForbiddenWritePathError when a literal path matches", async () => {
    const db = makeDb(["server/src/routes/agents.ts"]);
    await expect(
      assertWriteAllowed(db, AGENT_ID, ["server/src/routes/agents.ts"]),
    ).rejects.toBeInstanceOf(ForbiddenWritePathError);
  });

  it("throws when a glob pattern matches", async () => {
    const db = makeDb(["plugins/slack-tools/**"]);
    await expect(
      assertWriteAllowed(db, AGENT_ID, ["plugins/slack-tools/src/worker.ts"]),
    ).rejects.toBeInstanceOf(ForbiddenWritePathError);
  });

  it("throws with [EFORBIDDEN_WRITE_PATH] error code in message", async () => {
    const db = makeDb(["plugins/**"]);
    await expect(
      assertWriteAllowed(db, AGENT_ID, ["plugins/foo/index.ts"]),
    ).rejects.toThrow(/\[EFORBIDDEN_WRITE_PATH\]/);
  });

  it("returns cleanly when paths are outside any forbidden glob", async () => {
    const db = makeDb(["plugins/**", "server/src/routes/agents.ts"]);
    await expect(
      assertWriteAllowed(db, AGENT_ID, ["ui/components/Sidebar.tsx", "docs/README.md"]),
    ).resolves.toBeUndefined();
  });

  it("captures all matching candidate paths in the thrown error", async () => {
    const db = makeDb(["plugins/**", "server/src/routes/**"]);
    let caught: ForbiddenWritePathError | null = null;
    try {
      await assertWriteAllowed(db, AGENT_ID, [
        "plugins/slack-tools/index.ts",
        "ui/safe.tsx",
        "server/src/routes/agents.ts",
      ]);
    } catch (err) {
      caught = err as ForbiddenWritePathError;
    }
    expect(caught).toBeInstanceOf(ForbiddenWritePathError);
    expect(caught?.matches).toHaveLength(2);
    expect(caught?.matches.map((m) => m.path)).toEqual([
      "plugins/slack-tools/index.ts",
      "server/src/routes/agents.ts",
    ]);
  });

  it("throws when the agent does not exist", async () => {
    const db = makeDb(null);
    await expect(
      assertWriteAllowed(db, AGENT_ID, ["foo.ts"]),
    ).rejects.toThrow(/agent .* not found/);
  });
});
