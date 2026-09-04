/**
 * check-forbidden-tokens.mjs
 *
 * Scans the codebase for forbidden tokens before publishing to npm.
 * Mirrors the git pre-commit hook logic, but runs against the full
 * working tree (not just staged changes).
 *
 * Token list: .git/hooks/forbidden-tokens.txt (one per line, # comments ok).
 * If the file is missing, the check still uses the active local username when
 * available. If username detection fails, the check degrades gracefully.
 *
 * No shebang line here on purpose: vitest imports this module
 * (server/src/__tests__/forbidden-tokens.test.ts) and vite-node inlines it
 * into a function wrapper without stripping shebangs, so "#!" becomes a
 * syntax error. The script is always invoked as `node scripts/...`, never
 * executed directly, so the shebang bought nothing.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function uniqueNonEmpty(values) {
  return Array.from(new Set(values.map((value) => value?.trim() ?? "").filter(Boolean)));
}

export function resolveDynamicForbiddenTokens(env = process.env, osModule = os) {
  const candidates = [env.USER, env.LOGNAME, env.USERNAME];

  try {
    candidates.push(osModule.userInfo().username);
  } catch {
    // Some environments do not expose userInfo; env vars are enough fallback.
  }

  return uniqueNonEmpty(candidates);
}

export function readForbiddenTokensFile(tokensFile) {
  if (!existsSync(tokensFile)) return [];

  return readFileSync(tokensFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

export function resolveForbiddenTokens(tokensFile, env = process.env, osModule = os) {
  return uniqueNonEmpty([
    ...resolveDynamicForbiddenTokens(env, osModule),
    ...readForbiddenTokensFile(tokensFile),
  ]);
}

export function runForbiddenTokenCheck({
  repoRoot,
  tokens,
  exec = execSync,
  log = console.log,
  error = console.error,
}) {
  if (tokens.length === 0) {
    log("  i   Forbidden tokens list is empty - skipping check.");
    return 0;
  }

  let found = false;

  for (const token of tokens) {
    try {
      const result = exec(
        `git grep -in --no-color -- ${JSON.stringify(token)} -- ':!pnpm-lock.yaml' ':!.git'`,
        { encoding: "utf8", cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] },
      );
      if (result.trim()) {
        if (!found) {
          error("ERROR: Forbidden tokens found in tracked files:\n");
        }
        found = true;
        const lines = result.trim().split("\n");
        for (const line of lines) {
          error(`  ${line}`);
        }
      }
    } catch {
      // git grep returns exit code 1 when no matches - that's fine
    }
  }

  if (found) {
    error("\nBuild blocked. Remove the forbidden token(s) before publishing.");
    return 1;
  }

  log("  OK  No forbidden tokens found.");
  return 0;
}

/**
 * The same check, against what a commit is about to ADD rather than the whole
 * tree.
 *
 * Why a separate mode: the full-tree scan is the right thing before
 * publishing, but it is the wrong thing in a pre-commit hook, where one
 * pre-existing match somewhere unrelated would block every commit until
 * somebody fixed it. This only ever looks at lines the commit introduces, so
 * it blocks the person who added the token and nobody else.
 *
 * Binary files produce no added lines in a diff, so they are excluded without
 * needing a rule — which matters here, because a compiled launcher in this
 * repo contains the build machine's username and is not something a commit
 * hook should be arguing about.
 */
export function runStagedForbiddenTokenCheck({
  repoRoot,
  tokens,
  exec = execSync,
  log = console.log,
  error = console.error,
}) {
  if (tokens.length === 0) {
    log("  i   Forbidden tokens list is empty - skipping check.");
    return 0;
  }

  let diff = "";
  try {
    diff = exec("git diff --cached --diff-filter=ACMR -U0", {
      encoding: "utf8",
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    // Nothing staged, or git had nothing to say. Either way there is nothing
    // this check can block.
    return 0;
  }

  // "+++ b/path" is a file header, not content; skip it or every staged file
  // whose PATH contains the token would look like a match.
  const addedLines = diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"));

  const hits = [];
  for (const token of tokens) {
    const needle = token.toLowerCase();
    for (const line of addedLines) {
      if (line.toLowerCase().includes(needle)) {
        hits.push({ token, line: line.slice(1, 200) });
      }
    }
  }

  if (hits.length > 0) {
    error("ERROR: Forbidden tokens found in staged changes:\n");
    for (const hit of hits.slice(0, 20)) {
      error(`  [${hit.token}] ${hit.line}`);
    }
    if (hits.length > 20) error(`  ... and ${hits.length - 20} more`);
    error("\nCommit blocked. Remove the token(s), or use --no-verify if this is deliberate.");
    return 1;
  }

  log("  OK  No forbidden tokens in staged changes.");
  return 0;
}

function resolveRepoPaths(exec = execSync) {
  const repoRoot = exec("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  const gitDir = exec("git rev-parse --git-dir", { encoding: "utf8", cwd: repoRoot }).trim();
  return {
    repoRoot,
    tokensFile: resolve(repoRoot, gitDir, "hooks/forbidden-tokens.txt"),
  };
}

function main() {
  const { repoRoot, tokensFile } = resolveRepoPaths();
  const tokens = resolveForbiddenTokens(tokensFile);
  const staged = process.argv.includes("--staged");
  process.exit(
    staged
      ? runStagedForbiddenTokenCheck({ repoRoot, tokens })
      : runForbiddenTokenCheck({ repoRoot, tokens }),
  );
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main();
}
