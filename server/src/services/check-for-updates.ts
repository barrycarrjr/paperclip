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
 * The checkout-to-GitHub comparison is about DIRECTION, not difference. Asking
 * only whether the two SHAs differ treats a checkout that is thirteen commits
 * AHEAD of GitHub exactly like one that is behind it, and offers an update that
 * would move the owner backwards. So `remoteRelation` says which of `behind`,
 * `ahead`, `level` and `diverged` is true, and only `behind` offers a pull. A
 * diverged checkout is told apart and offers nothing, because pulling it is not
 * a simple move forward and only a person can decide what to do. When the
 * direction cannot be established it is reported as `unknown` and nothing is
 * offered: an invented direction is worse than an absent one.
 *
 * The build comparison has a direction problem of its own, and it is not about
 * which commit is newer. `build_behind` only means anything when the running
 * code came from a build. An instance that runs the checkout's own source, with
 * the server started through tsx and the browser code served by Vite, already
 * IS the checkout: the marker left over from the last built install differs
 * from HEAD, and yet there is nothing a rebuild would apply. Offering a rebuild
 * there is wrong in the same way offering an update to a checkout that is ahead
 * was. So `runningFromSource` is worked out from the running process itself,
 * no rebuild is offered while it is true, and the account card says plainly
 * that this copy runs from the working tree.
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
/** Same upper bound for each of the direction probes, for the same reason. */
const GIT_COMPARE_TIMEOUT_MS = 5_000;

const execFileAsync = promisify(execFile);

export type UpdateCheckErrorReason =
  | "no_install_marker"
  | "missing_remote"
  | "unsupported_remote"
  | "branch_not_on_remote"
  | "github_unreachable"
  | "github_error";

/**
 * Why an update is being offered.
 *
 * `remote_ahead` means there is something to pull. `build_behind` means what is
 * checked out has never been built, so a rebuild applies it without touching
 * the remote. When both are true the pull is reported, because updating does
 * the rebuild too.
 *
 * `build_behind` is never reported on an instance that runs from source. There
 * is no build in the path there, so there is nothing for a rebuild to apply.
 */
export type UpdateCheckReason = "remote_ahead" | "build_behind";

/**
 * Which way round the checkout and the tracked branch on GitHub are.
 *
 * `behind` is the only one with something to pull. `ahead` is a checkout that
 * is newer than what is published, which used to be mistaken for `behind` and
 * offered an update that would have moved it backwards. `diverged` means each
 * side has commits the other does not. `no_remote_branch` means GitHub has
 * never seen this branch, so there is nothing to compare against.
 *
 * `unknown` is a real answer, not a placeholder: git may not be runnable, or
 * the remote commit may never have been fetched into this checkout, and in
 * either case an ancestry test cannot decide. Reporting it plainly is the point.
 */
export type RemoteRelation =
  | "level"
  | "behind"
  | "ahead"
  | "diverged"
  | "no_remote_branch"
  | "unknown";

export interface UpdateCheckResult {
  available: boolean;
  /** What the checkout is on. */
  localCommit: string | null;
  /** What GitHub has on the tracked branch. */
  remoteCommit: string | null;
  /** What was last built and installed, from the install marker. */
  installedCommit: string | null;
  /**
   * Whether this instance is running the checkout's own source rather than a
   * build of it. True means a rebuild has nothing to apply, so `build_behind`
   * is never reported. See {@link isRunningFromSource}.
   */
  runningFromSource: boolean;
  /** Which of the two gaps this is, or null when there is no gap. */
  reason: UpdateCheckReason | null;
  /**
   * Which way round the checkout and GitHub are. Null when no remote
   * comparison was possible at all (no install marker, no remote, or a remote
   * we cannot query).
   */
  remoteRelation: RemoteRelation | null;
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

interface CompareCacheEntry {
  relation: RemoteRelation;
  fetchedAt: number;
}

const remoteCache = new Map<string, CacheEntry>();
/** Answers to "which way round are these two commits", keyed by the pair. */
const compareCache = new Map<string, CompareCacheEntry>();

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
 * Is this instance running the checkout's own source, rather than a build of
 * it?
 *
 * This decides whether a rebuild has anything to apply, so it is worked out
 * from facts about the running process rather than from anything a person can
 * type. Two parts, and both have to be true:
 *
 * - This very module was loaded from a `.ts` file. Server code that came from a
 *   build is `server/dist/services/check-for-updates.js`; the same code run
 *   from source through tsx is `server/src/services/check-for-updates.ts`.
 *   `import.meta.url` is the path the running module was actually loaded from,
 *   so it describes the code doing the asking, not how it was launched.
 * - The browser code is being served by Vite straight from `ui/src`, which is
 *   what `PAPERCLIP_UI_DEV_MIDDLEWARE` turns on. `server/src/config.ts` reads
 *   the same variable into `uiDevMiddleware` and `server/src/index.ts` turns
 *   that into `uiMode === "vite-dev"`, while `cli/src/commands/run.ts` sets it
 *   itself when the entry point it imports is `server/src/index.ts`. It is read
 *   here rather than importing the config module, because importing that module
 *   loads .env files and repairs config files as a side effect, and a read-only
 *   check has no business doing either.
 *
 * Both parts, because either one on its own still leaves work a rebuild would
 * do: a source server behind a built UI bundle serves stale browser code, and a
 * built server behind Vite runs stale server code. Only when both come from the
 * working tree is the running app the checkout itself.
 *
 * The arguments exist so tests can state the two facts directly, instead of the
 * check having to be run twice under two different harnesses.
 */
export function isRunningFromSource(
  moduleUrl: string = import.meta.url,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const serverFromSource = /\.tsx?(?:[?#].*)?$/i.test(moduleUrl);
  const uiFromSource = env.PAPERCLIP_UI_DEV_MIDDLEWARE === "true";
  return serverFromSource && uiFromSource;
}

/** Does this checkout already hold the given commit in its object store? */
async function checkoutHasCommit(repoPath: string, sha: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", repoPath, "cat-file", "-e", `${sha}^{commit}`], {
      timeout: GIT_COMPARE_TIMEOUT_MS,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * `git merge-base --is-ancestor a b` exits 0 for yes and 1 for no. Any other
 * outcome means git could not answer, and that comes back as null so the
 * caller says "cannot tell" instead of reading a failure as a "no".
 */
async function isAncestor(repoPath: string, a: string, b: string): Promise<boolean | null> {
  try {
    await execFileAsync("git", ["-C", repoPath, "merge-base", "--is-ancestor", a, b], {
      timeout: GIT_COMPARE_TIMEOUT_MS,
      windowsHide: true,
    });
    return true;
  } catch (err) {
    if ((err as { code?: unknown }).code === 1) return false;
    logger.warn({ err, repoPath }, "Update check: ancestry test could not run");
    return null;
  }
}

/**
 * Work out which way round the checkout and the remote tip are, using only the
 * local checkout.
 *
 * This is definitive whenever the checkout holds both commits, which is always
 * true when it is level with or ahead of the remote. It is NOT true when the
 * checkout is behind and has never fetched: the newer commit simply is not
 * here, so no ancestry test can be run against it. That case returns "unknown"
 * and the caller asks GitHub rather than assuming a direction.
 */
export async function compareCheckoutToRemote(
  repoPath: string | null,
  localCommit: string,
  remoteCommit: string,
): Promise<RemoteRelation> {
  if (localCommit === remoteCommit) return "level";
  if (!repoPath || !existsSync(repoPath)) return "unknown";
  if (!(await checkoutHasCommit(repoPath, remoteCommit))) return "unknown";
  if (!(await checkoutHasCommit(repoPath, localCommit))) return "unknown";

  const localIsBehind = await isAncestor(repoPath, localCommit, remoteCommit);
  if (localIsBehind === null) return "unknown";
  if (localIsBehind) return "behind";

  const localIsAhead = await isAncestor(repoPath, remoteCommit, localCommit);
  if (localIsAhead === null) return "unknown";
  return localIsAhead ? "ahead" : "diverged";
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
  /** Override the running-from-source check for tests. */
  runningFromSourceImpl?: () => boolean;
  /** Override the local git direction test for tests. */
  relationImpl?: (
    repoPath: string | null,
    localCommit: string,
    remoteCommit: string,
  ) => Promise<RemoteRelation>;
}

/**
 * Fetches the latest commit SHA on `<owner>/<repo>` at `<branch>` from the
 * GitHub REST API. Caches successful responses for {@link REMOTE_FETCH_TTL_MS}.
 * On failure, returns the previously cached SHA (if any) so a transient
 * network blip doesn't toggle the UI off. Callers can detect a failed live
 * fetch via `live`, and can tell WHY it failed from `httpStatus`, which is the
 * status GitHub answered with or null when the request never completed at all.
 * That distinction matters: a branch GitHub has never seen is a standing fact
 * about this install, not a passing network problem, and the two want
 * different words on screen.
 */
async function fetchRemoteCommit(
  parsed: ParsedRemote,
  branch: string,
  opts: FetchOptions = {},
): Promise<{ remoteCommit: string | null; live: boolean; httpStatus: number | null }> {
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetchImpl ?? ghFetch;
  const key = cacheKey(parsed, branch);
  const cached = remoteCache.get(key);
  if (cached && now() - cached.fetchedAt < REMOTE_FETCH_TTL_MS) {
    return { remoteCommit: cached.remoteCommit, live: true, httpStatus: null };
  }

  const failed = (httpStatus: number | null = null) => ({
    remoteCommit: cached ? cached.remoteCommit : null,
    live: false,
    httpStatus,
  });

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
    return failed();
  }

  if (!response.ok) {
    logger.warn({ status: response.status, url }, "Update check: GitHub returned non-2xx");
    return failed(response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    logger.warn({ err, url }, "Update check: GitHub response was not JSON");
    return failed();
  }
  const sha = (body as { sha?: unknown } | null)?.sha;
  if (typeof sha !== "string" || sha.length === 0) {
    logger.warn({ url }, "Update check: GitHub response missing sha");
    return failed();
  }

  remoteCache.set(key, { remoteCommit: sha, fetchedAt: now() });
  return { remoteCommit: sha, live: true, httpStatus: response.status };
}

/**
 * Ask GitHub which way round two commits are, for the case local git cannot
 * say: the remote commit was never fetched, or git cannot run here at all.
 * This is the ordinary "we are behind" case, so without it a checkout that
 * really does need updating would be reported as "cannot tell" forever.
 *
 * GitHub's `status` describes the head against the base, so passing the remote
 * tip as the base reads the same way round as ours. A commit GitHub has never
 * seen (a branch that was never pushed) 404s, and that is an honest "unknown"
 * rather than a direction.
 */
async function compareOnGitHub(
  parsed: ParsedRemote,
  remoteCommit: string,
  localCommit: string,
  opts: FetchOptions = {},
): Promise<RemoteRelation> {
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetchImpl ?? ghFetch;
  const key = `${parsed.hostname}/${parsed.owner}/${parsed.repo}@${remoteCommit}...${localCommit}`;
  const cached = compareCache.get(key);
  if (cached && now() - cached.fetchedAt < REMOTE_FETCH_TTL_MS) return cached.relation;

  const apiBase = gitHubApiBase(parsed.hostname);
  const url = `${apiBase}/repos/${parsed.owner}/${parsed.repo}/compare/${remoteCommit}...${localCommit}`;
  let status: unknown;
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "paperclip-update-check",
      },
    });
    if (!response.ok) {
      logger.warn({ status: response.status, url }, "Update check: GitHub compare returned non-2xx");
      return "unknown";
    }
    status = ((await response.json()) as { status?: unknown } | null)?.status;
  } catch (err) {
    logger.warn({ err, url }, "Update check: GitHub compare failed");
    return "unknown";
  }

  const relation: RemoteRelation =
    status === "identical"
      ? "level"
      : status === "ahead"
        ? "ahead"
        : status === "behind"
          ? "behind"
          : status === "diverged"
            ? "diverged"
            : "unknown";
  if (relation === "unknown") {
    logger.warn({ url, status }, "Update check: GitHub compare gave no usable status");
  } else {
    compareCache.set(key, { relation, fetchedAt: now() });
  }
  return relation;
}

/**
 * Public entry point. Always returns a value — never throws. Errors are
 * communicated via the `error` field, and `available` is conservative
 * (`false`) when we can't determine the answer.
 */
export async function checkForRemoteUpdate(opts: FetchOptions = {}): Promise<UpdateCheckResult> {
  const now = opts.now ?? Date.now;
  const lastChecked = new Date(now()).toISOString();
  const runningFromSource = (opts.runningFromSourceImpl ?? isRunningFromSource)();

  const info = readInstallInfo();
  if (!info) {
    return {
      available: false,
      localCommit: null,
      remoteCommit: null,
      installedCommit: null,
      runningFromSource,
      reason: null,
      remoteRelation: null,
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
   * Does the install marker record a different commit from what is checked out?
   *
   * Only answerable when git actually ran; with no HEAD there is nothing to
   * compare the marker against and claiming a gap would be a guess.
   */
  const markerDiffersFromCheckout = Boolean(
    checkoutCommit && installedCommit && checkoutCommit !== installedCommit,
  );

  /**
   * Is there a build that a rebuild would move forward?
   *
   * A differing marker is only half the answer. It says the last build was of a
   * different commit, which matters when the running app came from a build and
   * means nothing when it did not. On an instance running from source the
   * marker is a leftover from the last built install, and the running code is
   * already the checkout, so there is nothing for a rebuild to apply.
   */
  const buildBehind = markerDiffersFromCheckout && !runningFromSource;

  /**
   * The answer when there is no usable remote to compare against. The local
   * rebuild check still stands on its own, so it is still reported.
   */
  const localOnly = (
    error: UpdateCheckErrorReason,
    remoteRelation: RemoteRelation | null = null,
  ): UpdateCheckResult => ({
    available: buildBehind,
    localCommit,
    remoteCommit: null,
    installedCommit,
    runningFromSource,
    reason: buildBehind ? "build_behind" : null,
    remoteRelation,
    branch: info.branch,
    lastChecked,
    error,
  });

  if (!info.remote) return localOnly("missing_remote");

  const parsed = parseGitHubRemote(info.remote);
  if (!parsed || !isGitHubHostname(parsed.hostname)) return localOnly("unsupported_remote");

  const branch = info.branch ?? DEFAULT_BRANCH;
  const { remoteCommit, live, httpStatus } = await fetchRemoteCommit(parsed, branch, opts);

  if (!remoteCommit) {
    // GitHub answering is not the same as GitHub being unreachable, so the
    // status it answered with decides the wording. Asking for a branch GitHub
    // has never seen gets 422 ("No commit found for SHA: <branch>"), which is
    // a standing fact about this install: the branch was never pushed. A 404
    // is about the repository itself, not the branch, so it is reported as a
    // GitHub error and the direction stays unknown. Neither offers an update.
    if (httpStatus === 422) {
      return { ...localOnly("branch_not_on_remote", "no_remote_branch"), branch };
    }
    if (httpStatus === 404) {
      return { ...localOnly("github_error", "unknown"), branch };
    }
    return { ...localOnly("github_unreachable", "unknown"), branch };
  }

  // Direction, not difference. Local git answers for free whenever the checkout
  // holds both commits, which covers every case where it is level or ahead.
  // GitHub answers the one local git cannot: a newer commit that has never been
  // fetched, which is the ordinary "we are behind" case. If neither can answer,
  // the direction stays unknown and nothing is offered.
  const compareLocally = opts.relationImpl ?? compareCheckoutToRemote;
  let remoteRelation: RemoteRelation = "unknown";
  if (localCommit) {
    remoteRelation = await compareLocally(info.repoPath, localCommit, remoteCommit);
    if (remoteRelation === "unknown") {
      remoteRelation = await compareOnGitHub(parsed, remoteCommit, localCommit, opts);
    }
  }

  // Only a checkout that is genuinely behind has anything to pull. Ahead and
  // level have nothing. Diverged deliberately offers nothing either: pulling it
  // would not be a simple move forward, so a person has to decide. Unknown
  // offers nothing because we do not know.
  const remoteAhead = remoteRelation === "behind";
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
    runningFromSource,
    reason,
    remoteRelation,
    branch,
    lastChecked,
    ...(live ? {} : { error: "github_unreachable" as const }),
  };
}

/** Test-only: clear the in-process remote-SHA and direction caches between cases. */
export function __clearUpdateCheckCacheForTests(): void {
  remoteCache.clear();
  compareCache.clear();
}
