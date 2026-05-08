/**
 * Compares the local checkout's commit (recorded in `~/.paperclip/install.json`
 * by install-paperclip.bat / update-paperclip.bat) against the latest commit on
 * the install's tracked branch via the GitHub REST API.
 *
 * The result drives the UI's "update available" indicator. Cached in-process
 * with a short TTL so repeated UI polls and multi-tab sessions don't burn
 * GitHub's 60/hr unauthenticated rate limit. The cache resets on server
 * restart, which is exactly what we want — after the user runs the update flow
 * the server reboots and the next call refetches against fresh state.
 *
 * Non-github.com remotes (e.g. self-hosted GitHub Enterprise, or custom git
 * hosts) are not supported here; we surface a benign `unsupported_remote`
 * error and the UI hides its indicator.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gitHubApiBase, ghFetch } from "./github-fetch.js";
import { logger } from "../middleware/logger.js";

const DEFAULT_BRANCH = "master";
const REMOTE_FETCH_TTL_MS = 5 * 60 * 1000;

export type UpdateCheckErrorReason =
  | "no_install_marker"
  | "missing_remote"
  | "unsupported_remote"
  | "github_unreachable"
  | "github_error";

export interface UpdateCheckResult {
  available: boolean;
  localCommit: string | null;
  remoteCommit: string | null;
  branch: string | null;
  lastChecked: string;
  error?: UpdateCheckErrorReason;
}

interface InstallInfo {
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
      remote?: unknown;
      branch?: unknown;
      commit?: unknown;
    };
    const remote = typeof parsed.remote === "string" && parsed.remote.length > 0 ? parsed.remote : null;
    const branch = typeof parsed.branch === "string" && parsed.branch.length > 0 ? parsed.branch : null;
    const commit = typeof parsed.commit === "string" && parsed.commit.length > 0 ? parsed.commit : null;
    return { remote, branch, commit };
  } catch {
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
      branch: null,
      lastChecked,
      error: "no_install_marker",
    };
  }

  if (!info.remote) {
    return {
      available: false,
      localCommit: info.commit,
      remoteCommit: null,
      branch: info.branch,
      lastChecked,
      error: "missing_remote",
    };
  }

  const parsed = parseGitHubRemote(info.remote);
  if (!parsed || !isGitHubHostname(parsed.hostname)) {
    return {
      available: false,
      localCommit: info.commit,
      remoteCommit: null,
      branch: info.branch,
      lastChecked,
      error: "unsupported_remote",
    };
  }

  const branch = info.branch ?? DEFAULT_BRANCH;
  const { remoteCommit, live } = await fetchRemoteCommit(parsed, branch, opts);

  if (!remoteCommit) {
    return {
      available: false,
      localCommit: info.commit,
      remoteCommit: null,
      branch,
      lastChecked,
      error: "github_unreachable",
    };
  }

  const available = Boolean(info.commit) && info.commit !== remoteCommit;
  return {
    available,
    localCommit: info.commit,
    remoteCommit,
    branch,
    lastChecked,
    ...(live ? {} : { error: "github_unreachable" as const }),
  };
}

/** Test-only: clear the in-process remote-SHA cache between cases. */
export function __clearUpdateCheckCacheForTests(): void {
  remoteCache.clear();
}
