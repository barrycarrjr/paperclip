import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: vi.fn(),
  };
});

vi.mock("../middleware/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __clearUpdateCheckCacheForTests,
  checkForRemoteUpdate,
  compareCheckoutToRemote,
  isRunningFromSource,
  parseGitHubRemote,
} from "../services/check-for-updates.js";

const mockReadFileSync = vi.mocked(readFileSync);

const SAMPLE_INSTALL = {
  repoPath: "C:\\Users\\example\\paperclip",
  remote: "https://github.com/barrycarrjr/paperclip.git",
  branch: "master",
  commit: "ab461f01bb91c06a9d4f69eef11caa3c758b0576",
};

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const ok = init.ok ?? true;
  return {
    ok,
    status: init.status ?? (ok ? 200 : 500),
    json: async () => body,
  } as unknown as Response;
}

function mockInstall(payload: Partial<typeof SAMPLE_INSTALL> | "missing"): void {
  if (payload === "missing") {
    mockReadFileSync.mockImplementation(() => {
      const err: NodeJS.ErrnoException = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      throw err;
    });
    return;
  }
  mockReadFileSync.mockReturnValue(
    `﻿${JSON.stringify({ ...SAMPLE_INSTALL, ...payload })}`,
  );
}

describe("parseGitHubRemote", () => {
  it("parses https URLs with .git suffix", () => {
    expect(parseGitHubRemote("https://github.com/foo/bar.git")).toEqual({
      hostname: "github.com",
      owner: "foo",
      repo: "bar",
    });
  });

  it("parses https URLs without .git suffix", () => {
    expect(parseGitHubRemote("https://github.com/foo/bar")).toEqual({
      hostname: "github.com",
      owner: "foo",
      repo: "bar",
    });
  });

  it("parses ssh URLs", () => {
    expect(parseGitHubRemote("git@github.com:foo/bar.git")).toEqual({
      hostname: "github.com",
      owner: "foo",
      repo: "bar",
    });
  });

  it("returns null for unparseable input", () => {
    expect(parseGitHubRemote("not-a-url")).toBeNull();
    expect(parseGitHubRemote("")).toBeNull();
  });
});

/**
 * The signal that tells an instance running from source apart from one running
 * a build. Both halves are passed in, so each case says out loud what it is
 * testing instead of depending on how the test runner itself was started.
 */
describe("isRunningFromSource", () => {
  const SOURCE_MODULE =
    "file:///C:/Users/example/paperclip/server/src/services/check-for-updates.ts";
  const BUILT_MODULE =
    "file:///C:/Users/example/paperclip/server/dist/services/check-for-updates.js";

  it("is true when the server module is TypeScript and Vite serves the browser code", () => {
    expect(isRunningFromSource(SOURCE_MODULE, { PAPERCLIP_UI_DEV_MIDDLEWARE: "true" })).toBe(true);
  });

  // A built server with the dev middleware switched on still runs compiled
  // server code, so a rebuild would still apply something.
  it("is false on a built server even when the browser code comes from Vite", () => {
    expect(isRunningFromSource(BUILT_MODULE, { PAPERCLIP_UI_DEV_MIDDLEWARE: "true" })).toBe(false);
  });

  // And the other way round: source server, built browser bundle. The bundle is
  // stale until something builds it.
  it("is false when the browser code comes from a build", () => {
    expect(isRunningFromSource(SOURCE_MODULE, {})).toBe(false);
    expect(isRunningFromSource(SOURCE_MODULE, { PAPERCLIP_UI_DEV_MIDDLEWARE: "false" })).toBe(false);
  });

  it("is false for a built module with no dev middleware, which is an ordinary install", () => {
    expect(isRunningFromSource(BUILT_MODULE, {})).toBe(false);
  });

  it("still reads a query-suffixed module URL as source", () => {
    expect(
      isRunningFromSource(`${SOURCE_MODULE}?v=1`, { PAPERCLIP_UI_DEV_MIDDLEWARE: "true" }),
    ).toBe(true);
  });
});

/**
 * The direction test runs against a real throwaway git repository, because the
 * whole point of it is what git actually answers. Nothing here touches the
 * checkout the tests are running in.
 */
describe("compareCheckoutToRemote", () => {
  let repoPath = "";
  let emptyDirPath = "";
  /** first commit, second commit, and a third that forks off the first. */
  let first = "";
  let second = "";
  let sideways = "";

  function git(repo: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  }

  function addCommit(repo: string, name: string): string {
    writeFileSync(join(repo, `${name}.txt`), name);
    git(repo, "add", `${name}.txt`);
    git(
      repo,
      "-c",
      "user.email=tests@example.com",
      "-c",
      "user.name=Paperclip Tests",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      name,
    );
    return git(repo, "rev-parse", "HEAD");
  }

  beforeAll(() => {
    repoPath = mkdtempSync(join(tmpdir(), "paperclip-update-check-"));
    emptyDirPath = mkdtempSync(join(tmpdir(), "paperclip-update-check-bare-"));
    git(repoPath, "init", "--quiet");
    first = addCommit(repoPath, "first");
    second = addCommit(repoPath, "second");
    git(repoPath, "checkout", "--quiet", "-b", "sideways", first);
    sideways = addCommit(repoPath, "sideways");
  }, 60_000);

  afterAll(() => {
    rmSync(repoPath, { recursive: true, force: true });
    rmSync(emptyDirPath, { recursive: true, force: true });
  });

  it("says level when both commits are the same", async () => {
    expect(await compareCheckoutToRemote(repoPath, second, second)).toBe("level");
  });

  it("says behind when the checkout's commit is an ancestor of the remote's", async () => {
    expect(await compareCheckoutToRemote(repoPath, first, second)).toBe("behind");
  });

  // The bug this whole change exists for: thirteen commits ahead used to look
  // exactly like thirteen commits behind, and offered to move the owner back.
  it("says ahead when the remote's commit is an ancestor of the checkout's", async () => {
    expect(await compareCheckoutToRemote(repoPath, second, first)).toBe("ahead");
  });

  it("says diverged when each side has commits the other does not", async () => {
    expect(await compareCheckoutToRemote(repoPath, sideways, second)).toBe("diverged");
  });

  it("says unknown when the remote commit has never been fetched here", async () => {
    const neverFetched = "0123456789abcdef0123456789abcdef01234567";
    expect(await compareCheckoutToRemote(repoPath, second, neverFetched)).toBe("unknown");
  });

  it("says unknown when the local commit is not in this checkout either", async () => {
    const strayLocal = "89abcdef0123456789abcdef0123456789abcdef";
    expect(await compareCheckoutToRemote(repoPath, strayLocal, second)).toBe("unknown");
  });

  it("says unknown when the path is not a git checkout", async () => {
    expect(await compareCheckoutToRemote(emptyDirPath, first, second)).toBe("unknown");
  });

  it("says unknown when there is no path to run git in", async () => {
    expect(await compareCheckoutToRemote(null, first, second)).toBe("unknown");
    expect(await compareCheckoutToRemote(join(tmpdir(), "no-such-paperclip-checkout"), first, second)).toBe(
      "unknown",
    );
  });

  // Equality is settled before git is asked anything, so a repo we cannot read
  // still gives the right answer when there is nothing to work out.
  it("says level without needing git at all when the commits match", async () => {
    expect(await compareCheckoutToRemote(null, first, first)).toBe("level");
  });
});

describe("checkForRemoteUpdate", () => {
  beforeEach(() => {
    __clearUpdateCheckCacheForTests();
    mockReadFileSync.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns no_install_marker when install.json is missing", async () => {
    mockInstall("missing");
    const fetchImpl = vi.fn();
    const result = await checkForRemoteUpdate({ fetchImpl: fetchImpl as never });
    expect(result.error).toBe("no_install_marker");
    expect(result.available).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns unsupported_remote for non-github remotes", async () => {
    mockInstall({ remote: "https://gitlab.com/foo/bar.git" });
    const fetchImpl = vi.fn();
    const result = await checkForRemoteUpdate({ fetchImpl: fetchImpl as never });
    expect(result.error).toBe("unsupported_remote");
    expect(result.available).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns available=false when local SHA matches remote SHA", async () => {
    mockInstall({});
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ sha: SAMPLE_INSTALL.commit }),
    );
    const result = await checkForRemoteUpdate({ fetchImpl: fetchImpl as never });
    expect(result.available).toBe(false);
    expect(result.localCommit).toBe(SAMPLE_INSTALL.commit);
    expect(result.remoteCommit).toBe(SAMPLE_INSTALL.commit);
    expect(result.error).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl] = fetchImpl.mock.calls[0]!;
    expect(calledUrl).toBe(
      "https://api.github.com/repos/barrycarrjr/paperclip/commits/master",
    );
  });

  it("returns available=true when the checkout is behind the remote", async () => {
    mockInstall({});
    const fetchImpl = vi.fn(async () => jsonResponse({ sha: "feedface" }));
    const result = await checkForRemoteUpdate({
      fetchImpl: fetchImpl as never,
      relationImpl: async () => "behind",
    });
    expect(result.available).toBe(true);
    expect(result.reason).toBe("remote_ahead");
    expect(result.remoteRelation).toBe("behind");
    expect(result.localCommit).toBe(SAMPLE_INSTALL.commit);
    expect(result.remoteCommit).toBe("feedface");
    expect(result.error).toBeUndefined();
  });

  // The defect this change fixes. A checkout thirteen commits AHEAD differs
  // from the remote exactly as much as one that is behind, and the old test
  // for difference offered to move it backwards.
  it("offers nothing when the checkout is ahead of the remote", async () => {
    mockInstall({});
    const fetchImpl = vi.fn(async () => jsonResponse({ sha: "feedface" }));
    const result = await checkForRemoteUpdate({
      fetchImpl: fetchImpl as never,
      headImpl: async () => SAMPLE_INSTALL.commit,
      relationImpl: async () => "ahead",
    });
    expect(result.available).toBe(false);
    expect(result.reason).toBeNull();
    expect(result.remoteRelation).toBe("ahead");
  });

  // Pulling a diverged checkout is not a simple move forward, so it is
  // reported and left to a person rather than offered as a button.
  it("offers nothing when the checkout and the remote have diverged", async () => {
    mockInstall({});
    const fetchImpl = vi.fn(async () => jsonResponse({ sha: "feedface" }));
    const result = await checkForRemoteUpdate({
      fetchImpl: fetchImpl as never,
      headImpl: async () => SAMPLE_INSTALL.commit,
      relationImpl: async () => "diverged",
    });
    expect(result.available).toBe(false);
    expect(result.reason).toBeNull();
    expect(result.remoteRelation).toBe("diverged");
  });

  // An unreadable direction must not become a direction. Nothing is offered,
  // and the result says plainly that it could not be worked out.
  it("offers nothing when the direction cannot be worked out at all", async () => {
    mockInstall({});
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("/compare/")
        ? jsonResponse({ message: "Not Found" }, { ok: false, status: 404 })
        : jsonResponse({ sha: "feedface" }),
    );
    const result = await checkForRemoteUpdate({
      fetchImpl: fetchImpl as never,
      headImpl: async () => SAMPLE_INSTALL.commit,
      relationImpl: async () => "unknown",
    });
    expect(result.available).toBe(false);
    expect(result.reason).toBeNull();
    expect(result.remoteRelation).toBe("unknown");
  });

  // The ordinary "we are behind" case: the newer commit was never fetched, so
  // no local ancestry test can reach it and GitHub is asked instead.
  it("asks GitHub for the direction when local git cannot reach the remote commit", async () => {
    mockInstall({});
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("/compare/")
        ? jsonResponse({ status: "behind" })
        : jsonResponse({ sha: "feedface" }),
    );
    const result = await checkForRemoteUpdate({
      fetchImpl: fetchImpl as never,
      headImpl: async () => SAMPLE_INSTALL.commit,
      relationImpl: async () => "unknown",
    });
    expect(result.remoteRelation).toBe("behind");
    expect(result.reason).toBe("remote_ahead");
    expect(result.available).toBe(true);
    const comparedUrl = fetchImpl.mock.calls[1]?.[0];
    expect(comparedUrl).toBe(
      `https://api.github.com/repos/barrycarrjr/paperclip/compare/feedface...${SAMPLE_INSTALL.commit}`,
    );
  });

  it("takes GitHub's word for ahead too, and offers nothing", async () => {
    mockInstall({});
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("/compare/")
        ? jsonResponse({ status: "ahead" })
        : jsonResponse({ sha: "feedface" }),
    );
    const result = await checkForRemoteUpdate({
      fetchImpl: fetchImpl as never,
      headImpl: async () => SAMPLE_INSTALL.commit,
      relationImpl: async () => "unknown",
    });
    expect(result.remoteRelation).toBe("ahead");
    expect(result.available).toBe(false);
  });

  it("does not invent a direction from a compare answer it cannot read", async () => {
    mockInstall({});
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("/compare/")
        ? jsonResponse({ status: "something new" })
        : jsonResponse({ sha: "feedface" }),
    );
    const result = await checkForRemoteUpdate({
      fetchImpl: fetchImpl as never,
      headImpl: async () => SAMPLE_INSTALL.commit,
      relationImpl: async () => "unknown",
    });
    expect(result.remoteRelation).toBe("unknown");
    expect(result.available).toBe(false);
  });

  it("does not ask GitHub for a direction local git already gave", async () => {
    mockInstall({});
    const fetchImpl = vi.fn(async () => jsonResponse({ sha: "feedface" }));
    await checkForRemoteUpdate({
      fetchImpl: fetchImpl as never,
      headImpl: async () => SAMPLE_INSTALL.commit,
      relationImpl: async () => "ahead",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns github_unreachable on fetch failure with no cached value", async () => {
    mockInstall({});
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const result = await checkForRemoteUpdate({ fetchImpl: fetchImpl as never });
    expect(result.error).toBe("github_unreachable");
    expect(result.available).toBe(false);
    expect(result.remoteCommit).toBeNull();
  });

  it("falls back to cached remote SHA when a later fetch fails", async () => {
    mockInstall({});
    let now = 1_000_000;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sha: "feedface" }))
      .mockImplementationOnce(async () => {
        throw new Error("network blip");
      });

    // First call populates cache with "feedface".
    const first = await checkForRemoteUpdate({
      fetchImpl: fetchImpl as never,
      now: () => now,
      relationImpl: async () => "behind",
    });
    expect(first.remoteCommit).toBe("feedface");
    expect(first.error).toBeUndefined();

    // Advance past TTL so the second call attempts a fresh fetch.
    now += 6 * 60 * 1000;

    const second = await checkForRemoteUpdate({
      fetchImpl: fetchImpl as never,
      now: () => now,
      relationImpl: async () => "behind",
    });
    expect(second.remoteCommit).toBe("feedface");
    expect(second.error).toBe("github_unreachable");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("honours the 5-minute fetch cache", async () => {
    mockInstall({});
    let now = 0;
    const fetchImpl = vi.fn(async () => jsonResponse({ sha: "feedface" }));
    const behind = { relationImpl: async () => "behind" as const };

    await checkForRemoteUpdate({ fetchImpl: fetchImpl as never, now: () => now, ...behind });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Within TTL, so a cache hit.
    now += 4 * 60 * 1000;
    await checkForRemoteUpdate({ fetchImpl: fetchImpl as never, now: () => now, ...behind });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Past TTL, so a refetch.
    now += 2 * 60 * 1000;
    await checkForRemoteUpdate({ fetchImpl: fetchImpl as never, now: () => now, ...behind });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reuses a direction GitHub already gave, within the same cache window", async () => {
    mockInstall({});
    let now = 0;
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("/compare/")
        ? jsonResponse({ status: "behind" })
        : jsonResponse({ sha: "feedface" }),
    );
    const opts = {
      fetchImpl: fetchImpl as never,
      headImpl: async () => SAMPLE_INSTALL.commit,
      relationImpl: async () => "unknown" as const,
    };

    await checkForRemoteUpdate({ ...opts, now: () => now });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // The branch tip is cached and so is the direction, so nothing is refetched.
    now += 4 * 60 * 1000;
    const second = await checkForRemoteUpdate({ ...opts, now: () => now });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(second.remoteRelation).toBe("behind");
  });

  it("returns github_unreachable when GitHub responds with a server error", async () => {
    mockInstall({});
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "boom" }, { ok: false, status: 500 }));
    const result = await checkForRemoteUpdate({ fetchImpl: fetchImpl as never });
    expect(result.error).toBe("github_unreachable");
    expect(result.remoteRelation).toBe("unknown");
    expect(result.available).toBe(false);
  });

  // A branch that was never pushed is what GitHub answers 422 to. It is a
  // standing fact about this install, not a network blip, and it must not turn
  // into an offer to update.
  it("says the branch is not on the remote when GitHub has never seen it", async () => {
    mockInstall({ branch: "ux-mockup-shell" });
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { message: "No commit found for SHA: ux-mockup-shell" },
        { ok: false, status: 422 },
      ),
    );
    const result = await checkForRemoteUpdate({ fetchImpl: fetchImpl as never });
    expect(result.error).toBe("branch_not_on_remote");
    expect(result.remoteRelation).toBe("no_remote_branch");
    expect(result.reason).toBeNull();
    expect(result.available).toBe(false);
    expect(result.branch).toBe("ux-mockup-shell");
  });

  // The same 422, on an install whose checkout was never built. The rebuild is
  // a separate, local, still-true gap, so it survives.
  it("still offers the rebuild when the branch is not on the remote", async () => {
    mockInstall({ branch: "ux-mockup-shell" });
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "No commit found for SHA" }, { ok: false, status: 422 }),
    );
    const result = await checkForRemoteUpdate({
      fetchImpl: fetchImpl as never,
      headImpl: async () => "7050126a0000000000000000000000000000beef",
    });
    expect(result.error).toBe("branch_not_on_remote");
    expect(result.remoteRelation).toBe("no_remote_branch");
    expect(result.reason).toBe("build_behind");
    expect(result.available).toBe(true);
  });

  // A 404 is about the repository, not the branch, so it must not be reported
  // as a missing branch.
  it("reports a 404 as a GitHub error with an unknown direction", async () => {
    mockInstall({});
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Not Found" }, { ok: false, status: 404 }));
    const result = await checkForRemoteUpdate({ fetchImpl: fetchImpl as never });
    expect(result.error).toBe("github_error");
    expect(result.remoteRelation).toBe("unknown");
    expect(result.available).toBe(false);
  });

  it("returns github_unreachable when GitHub response is missing sha", async () => {
    mockInstall({});
    const fetchImpl = vi.fn(async () => jsonResponse({ commit: { message: "no sha here" } }));
    const result = await checkForRemoteUpdate({ fetchImpl: fetchImpl as never });
    expect(result.error).toBe("github_unreachable");
    expect(result.available).toBe(false);
  });

  // Three commits matter: what GitHub has, what is checked out, and what was
  // last built. The checkout is compared against both of its neighbours,
  // because each gap is real and needs a different button.
  describe("local commit resolution", () => {
    const LIVE_HEAD = "7050126a0000000000000000000000000000beef";

    it("reads the checkout's live HEAD rather than trusting the marker", async () => {
      mockInstall({});
      const headImpl = vi.fn(async () => LIVE_HEAD);
      const fetchImpl = vi.fn(async () => jsonResponse({ sha: LIVE_HEAD }));

      const result = await checkForRemoteUpdate({
        fetchImpl: fetchImpl as never,
        headImpl,
      });

      expect(result.localCommit).toBe(LIVE_HEAD);
      expect(headImpl).toHaveBeenCalledWith(SAMPLE_INSTALL.repoPath);
    });

    // The case that used to report "up to date" while the running build sat 28
    // commits behind: the checkout is level with GitHub, but nothing ever built
    // it. Pulling would do nothing; a rebuild is what applies it.
    it("reports a rebuild when the checkout is level with GitHub but the build is not", async () => {
      mockInstall({});
      const headImpl = vi.fn(async () => LIVE_HEAD);
      const fetchImpl = vi.fn(async () => jsonResponse({ sha: LIVE_HEAD }));

      const result = await checkForRemoteUpdate({
        fetchImpl: fetchImpl as never,
        headImpl,
      });

      expect(result.available).toBe(true);
      expect(result.reason).toBe("build_behind");
      expect(result.installedCommit).toBe(SAMPLE_INSTALL.commit);
      expect(result.localCommit).toBe(LIVE_HEAD);
      expect(result.remoteCommit).toBe(LIVE_HEAD);
    });

    it("says nothing is needed when all three commits agree", async () => {
      mockInstall({});
      const headImpl = vi.fn(async () => SAMPLE_INSTALL.commit);
      const fetchImpl = vi.fn(async () => jsonResponse({ sha: SAMPLE_INSTALL.commit }));

      const result = await checkForRemoteUpdate({
        fetchImpl: fetchImpl as never,
        headImpl,
      });

      expect(result.available).toBe(false);
      expect(result.reason).toBeNull();
    });

    it("still reports an update when the live HEAD is behind the remote", async () => {
      mockInstall({});
      const headImpl = vi.fn(async () => LIVE_HEAD);
      const fetchImpl = vi.fn(async () => jsonResponse({ sha: "feedface" }));

      const result = await checkForRemoteUpdate({
        fetchImpl: fetchImpl as never,
        headImpl,
        relationImpl: async () => "behind",
      });

      expect(result.localCommit).toBe(LIVE_HEAD);
      expect(result.remoteCommit).toBe("feedface");
      expect(result.available).toBe(true);
      // A pull wins over a rebuild, because updating rebuilds as its last step.
      expect(result.reason).toBe("remote_ahead");
    });

    it("still reports the rebuild when the remote cannot be reached", async () => {
      mockInstall({ remote: "https://gitlab.com/foo/bar.git" });
      const headImpl = vi.fn(async () => LIVE_HEAD);

      const result = await checkForRemoteUpdate({
        fetchImpl: vi.fn() as never,
        headImpl,
      });

      expect(result.error).toBe("unsupported_remote");
      expect(result.available).toBe(true);
      expect(result.reason).toBe("build_behind");
    });

    // Without a HEAD there is nothing to compare the marker against, and
    // inventing a gap would put a permanent Rebuild button on any install where
    // git cannot run.
    it("claims no rebuild is needed when HEAD cannot be read at all", async () => {
      mockInstall({});
      const headImpl = vi.fn(async () => null);
      const fetchImpl = vi.fn(async () => jsonResponse({ sha: SAMPLE_INSTALL.commit }));

      const result = await checkForRemoteUpdate({
        fetchImpl: fetchImpl as never,
        headImpl,
      });

      expect(result.available).toBe(false);
      expect(result.reason).toBeNull();
    });

    it("falls back to the marker commit when HEAD can't be read", async () => {
      mockInstall({});
      const headImpl = vi.fn(async () => null);
      const fetchImpl = vi.fn(async () => jsonResponse({ sha: "feedface" }));

      const result = await checkForRemoteUpdate({
        fetchImpl: fetchImpl as never,
        headImpl,
        relationImpl: async () => "behind",
      });

      expect(result.localCommit).toBe(SAMPLE_INSTALL.commit);
      expect(result.available).toBe(true);
    });

    // Both gaps at once, which is the state the owner's own checkout is in: a
    // branch ahead of what GitHub has, and a build older than the checkout.
    // The rebuild is offered because it is true; the pull never is.
    it("offers the rebuild, and never a pull, when the checkout is ahead and unbuilt", async () => {
      mockInstall({});
      const headImpl = vi.fn(async () => LIVE_HEAD);
      const fetchImpl = vi.fn(async () => jsonResponse({ sha: "feedface" }));

      const result = await checkForRemoteUpdate({
        fetchImpl: fetchImpl as never,
        headImpl,
        relationImpl: async () => "ahead",
      });

      expect(result.remoteRelation).toBe("ahead");
      expect(result.reason).toBe("build_behind");
      expect(result.available).toBe(true);
      expect(result.installedCommit).toBe(SAMPLE_INSTALL.commit);
      expect(result.localCommit).toBe(LIVE_HEAD);
    });

    it("passes the checkout path to the direction test", async () => {
      mockInstall({});
      const relationImpl = vi.fn(async () => "level" as const);

      await checkForRemoteUpdate({
        fetchImpl: vi.fn(async () => jsonResponse({ sha: "feedface" })) as never,
        headImpl: vi.fn(async () => LIVE_HEAD),
        relationImpl,
      });

      expect(relationImpl).toHaveBeenCalledWith(SAMPLE_INSTALL.repoPath, LIVE_HEAD, "feedface");
    });

    it("uses the live HEAD on the early-return paths too", async () => {
      mockInstall({ remote: "https://gitlab.com/foo/bar.git" });
      const headImpl = vi.fn(async () => LIVE_HEAD);

      const result = await checkForRemoteUpdate({
        fetchImpl: vi.fn() as never,
        headImpl,
      });

      expect(result.error).toBe("unsupported_remote");
      expect(result.localCommit).toBe(LIVE_HEAD);
      expect(result.installedCommit).toBe(SAMPLE_INSTALL.commit);
    });

    // The second wrong answer, and the sibling of the "ahead" one: a Rebuild
    // pill on an instance that has no build anywhere in its path. The marker is
    // left over from the last built install, and the running code already IS
    // the checkout, so a rebuild has nothing to apply.
    describe("when the instance runs from source", () => {
      const fromSource = { runningFromSourceImpl: () => true };
      const fromBuild = { runningFromSourceImpl: () => false };

      it("offers no rebuild when the marker records a different commit", async () => {
        mockInstall({});
        const result = await checkForRemoteUpdate({
          ...fromSource,
          fetchImpl: vi.fn(async () => jsonResponse({ sha: LIVE_HEAD })) as never,
          headImpl: async () => LIVE_HEAD,
        });

        expect(result.runningFromSource).toBe(true);
        expect(result.reason).toBeNull();
        expect(result.available).toBe(false);
        // The two commits are still reported, because they are still true. It
        // is only the offer to act on them that goes away.
        expect(result.localCommit).toBe(LIVE_HEAD);
        expect(result.installedCommit).toBe(SAMPLE_INSTALL.commit);
      });

      // The state this machine is in: a checkout ahead of GitHub, run straight
      // from the working tree. Neither button is a real job, so neither shows.
      it("offers nothing at all when it is also ahead of GitHub", async () => {
        mockInstall({});
        const result = await checkForRemoteUpdate({
          ...fromSource,
          fetchImpl: vi.fn(async () => jsonResponse({ sha: "feedface" })) as never,
          headImpl: async () => LIVE_HEAD,
          relationImpl: async () => "ahead",
        });

        expect(result.remoteRelation).toBe("ahead");
        expect(result.reason).toBeNull();
        expect(result.available).toBe(false);
        expect(result.runningFromSource).toBe(true);
      });

      // Running from source says nothing about the remote. New commits on
      // GitHub are still worth having, so the pull is untouched.
      it("still offers the pull when GitHub really does have newer commits", async () => {
        mockInstall({});
        const result = await checkForRemoteUpdate({
          ...fromSource,
          fetchImpl: vi.fn(async () => jsonResponse({ sha: "feedface" })) as never,
          headImpl: async () => LIVE_HEAD,
          relationImpl: async () => "behind",
        });

        expect(result.reason).toBe("remote_ahead");
        expect(result.available).toBe(true);
        expect(result.runningFromSource).toBe(true);
      });

      // The paths that never reach GitHub carry the local rebuild answer on
      // their own, so the suppression has to hold there too.
      it("offers no rebuild on a remote it cannot check", async () => {
        mockInstall({ remote: "https://gitlab.com/foo/bar.git" });
        const result = await checkForRemoteUpdate({
          ...fromSource,
          fetchImpl: vi.fn() as never,
          headImpl: async () => LIVE_HEAD,
        });

        expect(result.error).toBe("unsupported_remote");
        expect(result.reason).toBeNull();
        expect(result.available).toBe(false);
        expect(result.runningFromSource).toBe(true);
      });

      it("offers no rebuild when GitHub has never seen the branch", async () => {
        mockInstall({ branch: "ux-mockup-shell" });
        const result = await checkForRemoteUpdate({
          ...fromSource,
          fetchImpl: vi.fn(async () =>
            jsonResponse({ message: "No commit found for SHA" }, { ok: false, status: 422 }),
          ) as never,
          headImpl: async () => LIVE_HEAD,
        });

        expect(result.error).toBe("branch_not_on_remote");
        expect(result.reason).toBeNull();
        expect(result.available).toBe(false);
      });

      it("answers the source question even with no install marker at all", async () => {
        mockInstall("missing");
        const result = await checkForRemoteUpdate({ ...fromSource, fetchImpl: vi.fn() as never });

        expect(result.error).toBe("no_install_marker");
        expect(result.runningFromSource).toBe(true);
        expect(result.available).toBe(false);
      });

      // The case that must not be weakened. Same install marker, same commits,
      // same everything except that this instance runs a build: the rebuild is
      // still found, still offered, and still called build_behind.
      it("keeps the rebuild on an instance that runs a build", async () => {
        mockInstall({});
        const result = await checkForRemoteUpdate({
          ...fromBuild,
          fetchImpl: vi.fn(async () => jsonResponse({ sha: LIVE_HEAD })) as never,
          headImpl: async () => LIVE_HEAD,
        });

        expect(result.runningFromSource).toBe(false);
        expect(result.reason).toBe("build_behind");
        expect(result.available).toBe(true);
        expect(result.localCommit).toBe(LIVE_HEAD);
        expect(result.installedCommit).toBe(SAMPLE_INSTALL.commit);
      });

      it("keeps the rebuild on a built instance that is ahead of GitHub", async () => {
        mockInstall({});
        const result = await checkForRemoteUpdate({
          ...fromBuild,
          fetchImpl: vi.fn(async () => jsonResponse({ sha: "feedface" })) as never,
          headImpl: async () => LIVE_HEAD,
          relationImpl: async () => "ahead",
        });

        expect(result.remoteRelation).toBe("ahead");
        expect(result.reason).toBe("build_behind");
        expect(result.available).toBe(true);
      });

      it("keeps the rebuild on a built instance whose remote cannot be checked", async () => {
        mockInstall({ remote: "https://gitlab.com/foo/bar.git" });
        const result = await checkForRemoteUpdate({
          ...fromBuild,
          fetchImpl: vi.fn() as never,
          headImpl: async () => LIVE_HEAD,
        });

        expect(result.error).toBe("unsupported_remote");
        expect(result.reason).toBe("build_behind");
        expect(result.available).toBe(true);
      });
    });

    it("reports no update when both HEAD and marker are unreadable", async () => {
      mockInstall({ commit: undefined });
      const headImpl = vi.fn(async () => null);
      const fetchImpl = vi.fn(async () => jsonResponse({ sha: "feedface" }));

      const result = await checkForRemoteUpdate({
        fetchImpl: fetchImpl as never,
        headImpl,
      });

      expect(result.localCommit).toBeNull();
      expect(result.available).toBe(false);
    });
  });
});
