import { describe, expect, it, vi } from "vitest";

const {
  resolveDynamicForbiddenTokens,
  resolveForbiddenTokens,
  runForbiddenTokenCheck,
  runStagedForbiddenTokenCheck,
} = await import("../../../scripts/check-forbidden-tokens.mjs");

describe("forbidden token check", () => {
  it("derives username tokens without relying on whoami", () => {
    const tokens = resolveDynamicForbiddenTokens(
      { USER: "paperclip", LOGNAME: "paperclip", USERNAME: "pc" },
      {
        userInfo: () => ({ username: "paperclip" }),
      },
    );

    expect(tokens).toEqual(["paperclip", "pc"]);
  });

  it("falls back cleanly when user resolution fails", () => {
    const tokens = resolveDynamicForbiddenTokens(
      {},
      {
        userInfo: () => {
          throw new Error("missing user");
        },
      },
    );

    expect(tokens).toEqual([]);
  });

  it("merges dynamic and file-based forbidden tokens", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const tokensFile = path.join(os.tmpdir(), `forbidden-tokens-${Date.now()}.txt`);
    fs.writeFileSync(tokensFile, "# comment\npaperclip\ncustom-token\n");

    try {
      const tokens = resolveForbiddenTokens(tokensFile, { USER: "paperclip" }, {
        userInfo: () => ({ username: "paperclip" }),
      });

      expect(tokens).toEqual(["paperclip", "custom-token"]);
    } finally {
      fs.unlinkSync(tokensFile);
    }
  });

  it("reports matches without leaking which token was searched", () => {
    const exec = vi
      .fn()
      .mockReturnValueOnce("server/file.ts:1:found\n")
      .mockImplementation(() => {
        throw new Error("not found");
      });
    const log = vi.fn();
    const error = vi.fn();

    const exitCode = runForbiddenTokenCheck({
      repoRoot: "/repo",
      tokens: ["paperclip", "custom-token"],
      exec,
      log,
      error,
    });

    expect(exitCode).toBe(1);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith("ERROR: Forbidden tokens found in tracked files:\n");
    expect(error).toHaveBeenCalledWith("  server/file.ts:1:found");
    expect(error).toHaveBeenCalledWith("\nBuild blocked. Remove the forbidden token(s) before publishing.");
  });
});

describe("staged forbidden token check", () => {
  // A made-up token, never the real local username. The tests above already
  // do this, and there is a second reason here: this file is itself scanned
  // by the check it tests, so a genuine forbidden token would make the test
  // file permanently uncommittable. Found out exactly that way on 2026-09-04
  // — the hook rejected the commit that introduced these tests.
  const TOKEN = "sampleuser";

  function run(diff: string, tokens: string[] = [TOKEN]) {
    const errors: string[] = [];
    const logs: string[] = [];
    const exitCode = runStagedForbiddenTokenCheck({
      repoRoot: "/repo",
      tokens,
      exec: () => diff,
      log: (m: string) => logs.push(m),
      error: (m: string) => errors.push(m),
    });
    return { exitCode, errors: errors.join("\n"), logs: logs.join("\n") };
  }

  it("blocks a staged line that adds a forbidden token", () => {
    const result = run(`+++ b/docs/x.md\n+see /home/${TOKEN}/project\n`);
    expect(result.exitCode).toBe(1);
    expect(result.errors).toContain(TOKEN);
  });

  it("ignores removed lines and untouched context", () => {
    // Taking a token OUT is the fix, not the offence.
    const result = run(`+++ b/docs/x.md\n-see /home/${TOKEN}/project\n see something else\n`);
    expect(result.exitCode).toBe(0);
  });

  it("does not treat the diff's own file headers as content", () => {
    // Without this, every staged file whose PATH contains the token would look
    // like a match and nothing under that directory could be committed.
    const result = run(`+++ b/home/${TOKEN}/notes.md\n+a harmless line\n`);
    expect(result.exitCode).toBe(0);
  });

  it("matches regardless of case", () => {
    const result = run(`+++ b/x.md\n+/home/${TOKEN.toUpperCase()}/project\n`);
    expect(result.exitCode).toBe(1);
  });

  it("passes when the staged changes are clean", () => {
    const result = run("+++ b/x.md\n+a perfectly ordinary line\n");
    expect(result.exitCode).toBe(0);
    expect(result.logs).toContain("No forbidden tokens");
  });

  it("does nothing when the token list is empty", () => {
    const result = run(`+++ b/x.md\n+/home/${TOKEN}/project\n`, []);
    expect(result.exitCode).toBe(0);
  });

  it("does not block when there is nothing staged", () => {
    const exitCode = runStagedForbiddenTokenCheck({
      repoRoot: "/repo",
      tokens: [TOKEN],
      exec: () => {
        throw new Error("no staged changes");
      },
      log: () => {},
      error: () => {},
    });
    expect(exitCode).toBe(0);
  });
});
