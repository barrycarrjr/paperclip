import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { readFileSync } from "node:fs";
import {
  __clearUpdateCheckCacheForTests,
  checkForRemoteUpdate,
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

  it("returns available=true when local SHA differs from remote", async () => {
    mockInstall({});
    const fetchImpl = vi.fn(async () => jsonResponse({ sha: "feedface" }));
    const result = await checkForRemoteUpdate({ fetchImpl: fetchImpl as never });
    expect(result.available).toBe(true);
    expect(result.localCommit).toBe(SAMPLE_INSTALL.commit);
    expect(result.remoteCommit).toBe("feedface");
    expect(result.error).toBeUndefined();
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
    });
    expect(first.remoteCommit).toBe("feedface");
    expect(first.error).toBeUndefined();

    // Advance past TTL so the second call attempts a fresh fetch.
    now += 6 * 60 * 1000;

    const second = await checkForRemoteUpdate({
      fetchImpl: fetchImpl as never,
      now: () => now,
    });
    expect(second.remoteCommit).toBe("feedface");
    expect(second.error).toBe("github_unreachable");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("honours the 5-minute fetch cache", async () => {
    mockInstall({});
    let now = 0;
    const fetchImpl = vi.fn(async () => jsonResponse({ sha: "feedface" }));

    await checkForRemoteUpdate({ fetchImpl: fetchImpl as never, now: () => now });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Within TTL — cache hit.
    now += 4 * 60 * 1000;
    await checkForRemoteUpdate({ fetchImpl: fetchImpl as never, now: () => now });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Past TTL — refetch.
    now += 2 * 60 * 1000;
    await checkForRemoteUpdate({ fetchImpl: fetchImpl as never, now: () => now });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns github_unreachable when GitHub responds with non-2xx", async () => {
    mockInstall({});
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Not Found" }, { ok: false, status: 404 }));
    const result = await checkForRemoteUpdate({ fetchImpl: fetchImpl as never });
    expect(result.error).toBe("github_unreachable");
    expect(result.available).toBe(false);
  });

  it("returns github_unreachable when GitHub response is missing sha", async () => {
    mockInstall({});
    const fetchImpl = vi.fn(async () => jsonResponse({ commit: { message: "no sha here" } }));
    const result = await checkForRemoteUpdate({ fetchImpl: fetchImpl as never });
    expect(result.error).toBe("github_unreachable");
    expect(result.available).toBe(false);
  });
});
