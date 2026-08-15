/**
 * Whether the running Paperclip is behind, and in which of the two ways it can
 * be.
 *
 * There are three commits in play, not two, and conflating any of them hides a
 * real problem:
 *
 * - what GitHub has on the tracked branch,
 * - what the local checkout is on (`git rev-parse HEAD`),
 * - what was last built and installed (`commit` in `~/.paperclip/install.json`,
 *   written only by the final step of the update and rebuild scripts).
 *
 * Comparing only the first two answers "is there anything new to pull", which
 * says nothing about whether the thing that was pulled was ever built. A
 * checkout that is level with GitHub while the installed build sits 28 commits
 * behind reports "up to date" and is not: that is what a partly-finished update
 * leaves behind, and it is silent.
 *
 * Comparing only the last two was the original behaviour and had the opposite
 * fault: it kept offering an update that had already been applied, because
 * anything that moved the checkout without running the updater to completion
 * left the marker behind.
 *
 * So both comparisons are made and reported separately. `remote_ahead` wants a
 * pull, `build_behind` wants a rebuild, and they are different buttons.
 * `available` stays true for either, so an existing caller that only reads that
 * flag keeps working and simply stops missing the second case.
 *
 * Results are cached in-process with a short TTL so repeated UI polls and
 * multi-tab sessions don't burn GitHub's 60/hr unauthenticated rate limit. The
 * cache resets on server restart, which is exactly what we want: after an
 * update the server reboots and the next call refetches against fresh state.
 *
 * Non-github.com remotes (self-hosted GitHub Enterprise, other git hosts) can't
 * be checked against a remote; we surface a benign `unsupported_remote` and the
 * UI hides the indicator. The build comparison is local, so it is still
 * reported in that case.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gitHubApiBase, ghFetch } from "./github-fetch.js";
import { logger } from "../middleware/logger.js";

const DEFAULT_BRANCH = "master";
const REMOTE_FETCH_TTL_MS = 5 * 60 * 1000;
/** Upper bound on the `git rev-parse HEAD` call so a wedged git can't stall the route. */
const GIT_HEAD_TIMEOUT_MS = 5_000;

const execFileAsync = promisify(execFile);

export type UpdateCheckErrorReason =
  | "no_install_marker"
  | "missing_remote"
  | "unsupported_remote"
  | "github_unreachable"
  | "github_error";

/**
 * Why an update is being offered.
 *
 * `remote_ahead` means there is something to pull. `build_behind` means what is
 * checked out has never been built, so a rebuild applies it without touching
 * the remote. When both are true the pull is reported, because updating does
 * the rebuild too.
 */
export type UpdateCheckReason = "remote_ahead" | "build_behind";

export interface UpdateCheckResult {
  available: boolean;
  /** What the checkout is on. */
  localCommit: string | null;
  /** What GitHub has on the tracked branch. */
  remoteCommit: string | null;
  /** What was last built and installed, from the install marker. */
  installedCommit: string | null;
  /** Which of the two gaps this is, or null when there is no gap. */
  reason: UpdateCheckReason | null;
  branch: string | null;
  lastChecked: string;
  error?: UpdateCheckErrorReason;
}

interface InstallInfo {
  repoPath: string | null;
  remote: string | null;
  branch: string | null;
  commit: string | null;
}

interface ParsedRemote {
  hostname: string;
  owner: string;
  repo: string;
}

interface CacheEntry {
  remoteCommit: string;
  fetchedAt: number;
}

const remoteCache = new Map<string, CacheEntry>();

function readInstallInfo(): InstallInfo | null {
  try {
    const raw = readFileSync(join(homedir(), ".paperclip", "install.json"), "utf8");
    // Strip a UTF-8 BOM the install scripts can leave behind on Windows.
    const cleaned = raw.replace(/^﻿/, "");
    const parsed = JSON.parse(cleaned) as {
      repoPath?: unknown;
      remote?: unknown;
      branch?: unknown;
      commit?: unknown;
    };
    const repoPath = typeof parsed.repoPath === "string" && parsed.repoPath.length > 0 ? parsed.repoPath : null;
    const remote = typeof parsed.remote === "string" && parsed.remote.length > 0 ? parsed.remote : null;
    const branch = typeof parsed.branch === "string" && parsed.branch.length > 0 ? parsed.branch : null;
    const commit = typeof parsed.commit === "string" && parsed.commit.length > 0 ? parsed.commit : null;
    return { repoPath, remote, branch, commit };
  } catch {
    return null;
  }
}

/**
 * Read the checkout's current HEAD commit. Returns null (and the caller falls
 * back to the install marker) whenever we can't get a definitive answer: no
 * recorded repo path, the path no longer exists, git isn't installed, or the
 * directory isn't a git checkout.
 */
async function readCheckoutHead(repoPath: string | null): Promise<string | null> {
  if (!repoPath || !existsSync(repoPath)) return null;
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
      timeout: GIT_HEAD_TIMEOUT_MS,
      windowsHide: true,
    });
    const sha = stdout.trim();
    // Guard against git printing something unexpected (a warning, an empty
    // line on a repo with no commits) and it being taken for a real SHA.
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch (err) {
    logger.warn({ err, repoPath }, "Update check: could not read local git HEAD");
    return null;
  }
}

/**
 * Parse a git remote URL like `https://github.com/owner/repo.git` or
 * `git@github.com:owner/repo.git` into `{hostname, owner, repo}`. Returns null
 * for shapes we don't recognise — callers should treat that as "unsupported
 * remote" rather than blowing up.
 */
export function parseGitHubRemote(remote: string): ParsedRemote | null {
  const trimmed = remote.trim();
  if (trimmed.length === 0) return null;

  // SSH form: git@host:owner/repo(.git)
  const sshMatch = trimmed.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    const [, hostname, owner, repo] = sshMatch;
    if (!hostname || !owner || !repo) return null;
    return { hostname, owner, repo };
  }

  // HTTP(S) form: https://host/owner/repo(.git)
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const segments = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "").split("/");
  if (segments.length < 2) return null;
  const owner = segments[0];
  const repoRaw = segments[1];
  if (!owner || !repoRaw) return null;
  const repo = repoRaw.replace(/\.git$/, "");
  if (repo.length === 0) return null;
  return { hostname: url.hostname, owner, repo };
}

function isGitHubHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "github.com" || h === "www.github.com";
}

function cacheKey(parsed: ParsedRemote, branch: string): string {
  return `${parsed.hostname}/${parsed.owner}/${parsed.repo}#${branch}`;
}

interface FetchOptions {
  /** Override `Date.now()` for tests. */
  now?: () => number;
  /** Override `ghFetch` for tests. */
  fetchImpl?: typeof ghFetch;
  /** Override the local `git rev-parse HEAD` read for tests. */
  headImpl?: (repoPath: string | null) => Promise<string | null>;
}

/**
 * Fetches the latest commit SHA on `<owner>/<repo>` at `<branch>` from the
 * GitHub REST API. Caches successful responses for {@link REMOTE_FETCH_TTL_MS}.
 * On failure, returns the previously cached SHA (if any) so a transient
 * network blip doesn't toggle the UI off — callers can detect a failed live
 * fetch via the second tuple element.
 */
async function fetchRemoteCommit(
  parsed: ParsedRemote,
  branch: string,
  opts: FetchOptions = {},
): Promise<{ remoteCommit: string | null; live: boolean }> {
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetchImpl ?? ghFetch;
  const key = cacheKey(parsed, branch);
  const cached = remoteCache.get(key);
  if (cached && now() - cached.fetchedAt < REMOTE_FETCH_TTL_MS) {
    return { remoteCommit: cached.remoteCommit, live: true };
  }

  const apiBase = gitHubApiBase(parsed.hostname);
  const url = `${apiBase}/repos/${parsed.owner}/${parsed.repo}/commits/${encodeURIComponent(branch)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "paperclip-update-check",
      },
    });
  } catch (err) {
    logger.warn({ err, url }, "Update check: GitHub fetch failed");
    return cached ? { remoteCommit: cached.remoteCommit, live: false } : { remoteCommit: null, live: false };
  }

  if (!response.ok) {
    logger.warn({ status: response.status, url }, "Update check: GitHub returned non-2xx");
    return cached ? { remoteCommit: cached.remoteCommit, live: false } : { remoteCommit: null, live: false };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    logger.warn({ err, url }, "Update check: GitHub response was not JSON");
    return cached ? { remoteCommit: cached.remoteCommit, live: false } : { remoteCommit: null, live: false };
  }
  const sha = (body as { sha?: unknown } | null)?.sha;
  if (typeof sha !== "string" || sha.length === 0) {
    logger.warn({ url }, "Update check: GitHub response missing sha");
    return cached ? { remoteCommit: cached.remoteCommit, live: false } : { remoteCommit: null, live: false };
  }

  remoteCache.set(key, { remoteCommit: sha, fetchedAt: now() });
  return { remoteCommit: sha, live: true };
}

/**
 * Public entry point. Always returns a value — never throws. Errors are
 * communicated via the `error` field, and `available` is conservative
 * (`false`) when we can't determine the answer.
 */
export async function checkForRemoteUpdate(opts: FetchOptions = {}): Promise<UpdateCheckResult> {
  const now = opts.now ?? Date.now;
  const lastChecked = new Date(now()).toISOString();

  const info = readInstallInfo();
  if (!info) {
    return {
      available: false,
      localCommit: null,
      remoteCommit: null,
      installedCommit: null,
      reason: null,
      branch: null,
      lastChecked,
      error: "no_install_marker",
    };
  }

  // The checkout's real HEAD, falling back to the marker only when git cannot
  // be run at all. These are different things and are compared against each
  // other below, so the fallback deliberately collapses the comparison to "no
  // gap" rather than inventing one.
  const readHead = opts.headImpl ?? readCheckoutHead;
  const checkoutCommit = await readHead(info.repoPath);
  const localCommit = checkoutCommit ?? info.commit;
  const installedCommit = info.commit;

  /**
   * Is the installed build behind what is checked out?
   *
   * Only answerable when git actually ran; with no HEAD there is nothing to
   * compare the marker against and claiming a gap would be a guess.
   */
  const buildBehind = Boolean(
    checkoutCommit && installedCommit && checkoutCommit !== installedCommit,
  );

  /** The answer when there is no usable remote to compare against. */
  const localOnly = (error: UpdateCheckErrorReason): UpdateCheckResult => ({
    available: buildBehind,
    localCommit,
    remoteCommit: null,
    installedCommit,
    reason: buildBehind ? "build_behind" : null,
    branch: info.branch,
    lastChecked,
    error,
  });

  if (!info.remote) return localOnly("missing_remote");

  const parsed = parseGitHubRemote(info.remote);
  if (!parsed || !isGitHubHostname(parsed.hostname)) return localOnly("unsupported_remote");

  const branch = info.branch ?? DEFAULT_BRANCH;
  const { remoteCommit, live } = await fetchRemoteCommit(parsed, branch, opts);

  if (!remoteCommit) {
    return { ...localOnly("github_unreachable"), branch };
  }

  const remoteAhead = Boolean(localCommit) && localCommit !== remoteCommit;
  // A pull wins when both are true, because updating rebuilds as its last step.
  const reason: UpdateCheckReason | null = remoteAhead
    ? "remote_ahead"
    : buildBehind
      ? "build_behind"
      : null;
  return {
    available: reason !== null,
    localCommit,
    remoteCommit,
    installedCommit,
    reason,
    branch,
    lastChecked,
    ...(live ? {} : { error: "github_unreachable" as const }),
  };
}

/** Test-only: clear the in-process remote-SHA cache between cases. */
export function __clearUpdateCheckCacheForTests(): void {
  remoteCache.clear();
}
