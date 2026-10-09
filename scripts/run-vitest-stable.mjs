#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();

/**
 * `--part=<non-server|server|serialized>` runs one of the three groups below
 * on its own, so CI can run them side by side instead of one after another
 * (together they took 11 to 13 minutes in a row). `--shard=<n>/<of>` splits
 * the serialized suites further. With neither, everything runs in order, as
 * it always has.
 */
const PARTS = ["all", "non-server", "server", "serialized"];
const partArg = process.argv.find((arg) => arg.startsWith("--part="))?.slice("--part=".length) ?? "all";
const shardArg = process.argv.find((arg) => arg.startsWith("--shard="))?.slice("--shard=".length) ?? null;
if (!PARTS.includes(partArg)) {
  console.error(`[test:run] Unknown --part "${partArg}". Expected one of: ${PARTS.join(", ")}.`);
  process.exit(2);
}
let shard = null;
if (shardArg !== null) {
  const match = /^(\d+)\/(\d+)$/.exec(shardArg);
  const index = match ? Number(match[1]) : Number.NaN;
  const count = match ? Number(match[2]) : Number.NaN;
  if (!match || count < 1 || index < 1 || index > count) {
    console.error(`[test:run] --shard must look like 1/2, got "${shardArg}".`);
    process.exit(2);
  }
  if (partArg !== "serialized") {
    console.error("[test:run] --shard only applies to --part=serialized.");
    process.exit(2);
  }
  shard = { index, count };
}
const runsPart = (part) => partArg === "all" || partArg === part;
/** `--list` prints what would run, one line per Vitest invocation, and runs nothing. */
const listOnly = process.argv.includes("--list");

/**
 * Spawning pnpm as a child process on Windows takes two accommodations, and
 * missing either one makes `pnpm test:run` — the command that runs the whole
 * suite — impossible to run on a Windows machine at all.
 *
 * First, pnpm there is `pnpm.cmd`, a batch script. `spawnSync("pnpm", ...)`
 * looks for an executable of that exact name, finds nothing, and fails with a
 * bare `spawnSync pnpm ENOENT` that reads like pnpm is not installed when it
 * is on PATH and working perfectly.
 *
 * Second, naming the `.cmd` is not enough on its own: since the fix for
 * CVE-2024-27980, Node refuses to spawn a `.cmd` or `.bat` without a shell and
 * fails with `EINVAL`. So Windows needs `shell: true` as well.
 *
 * Passing arguments through a shell is normally worth avoiding, and it is safe
 * here only because every argument this script passes is a project name or a
 * repo-relative test path — no spaces, no globs, nothing cmd.exe would expand.
 * Anything less predictable should go back to spawning pnpm's JS entry point
 * with `process.execPath` rather than widening this.
 */
const isWindows = process.platform === "win32";
const pnpmCommand = isWindows ? "pnpm.cmd" : "pnpm";
const serverRoot = path.join(repoRoot, "server");
const serverTestsDir = path.join(repoRoot, "server", "src", "__tests__");
const nonServerProjects = [
  "@paperclipai/shared",
  "@paperclipai/db",
  "@paperclipai/adapter-utils",
  "@paperclipai/adapter-codex-local",
  "@paperclipai/adapter-opencode-local",
  "@paperclipai/ui",
  "paperclipai",
];
const routeTestPattern = /[^/]*(?:route|routes|authz)[^/]*\.test\.ts$/;
const additionalSerializedServerTests = new Set([
  "server/src/__tests__/approval-routes-idempotency.test.ts",
  "server/src/__tests__/assets.test.ts",
  "server/src/__tests__/authz-company-access.test.ts",
  "server/src/__tests__/companies-route-path-guard.test.ts",
  "server/src/__tests__/company-portability.test.ts",
  "server/src/__tests__/costs-service.test.ts",
  "server/src/__tests__/express5-auth-wildcard.test.ts",
  "server/src/__tests__/health-dev-server-token.test.ts",
  "server/src/__tests__/health.test.ts",
  "server/src/__tests__/heartbeat-dependency-scheduling.test.ts",
  "server/src/__tests__/heartbeat-issue-liveness-escalation.test.ts",
  "server/src/__tests__/heartbeat-process-recovery.test.ts",
  "server/src/__tests__/invite-accept-existing-member.test.ts",
  "server/src/__tests__/invite-accept-gateway-defaults.test.ts",
  "server/src/__tests__/invite-accept-replay.test.ts",
  "server/src/__tests__/invite-expiry.test.ts",
  "server/src/__tests__/invite-join-manager.test.ts",
  "server/src/__tests__/invite-onboarding-text.test.ts",
  "server/src/__tests__/issues-checkout-wakeup.test.ts",
  "server/src/__tests__/issues-service.test.ts",
  "server/src/__tests__/opencode-local-adapter-environment.test.ts",
  "server/src/__tests__/project-routes-env.test.ts",
  "server/src/__tests__/redaction.test.ts",
  "server/src/__tests__/routines-e2e.test.ts",
]);
let invocationIndex = 0;

function walk(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      files.push(...walk(absolute));
    } else if (stats.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

function toRepoPath(file) {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

function toServerPath(file) {
  return path.relative(serverRoot, file).split(path.sep).join("/");
}

function isRouteOrAuthzTest(file) {
  if (routeTestPattern.test(file)) {
    return true;
  }

  return additionalSerializedServerTests.has(file);
}

function runVitest(args, label) {
  if (listOnly) {
    console.log(`[test:run] would run: ${label}`);
    return;
  }
  console.log(`\n[test:run] ${label}`);
  invocationIndex += 1;
  const testRoot = mkdtempSync(path.join(os.tmpdir(), `paperclip-vitest-${process.pid}-${invocationIndex}-`));
  const tempDir = path.join(testRoot, "tmp");
  const env = {
    ...process.env,
    PAPERCLIP_HOME: path.join(testRoot, "home"),
    PAPERCLIP_INSTANCE_ID: `vitest-${process.pid}-${invocationIndex}`,
    TMPDIR: tempDir,
    // TMPDIR alone is POSIX-only: Node's `os.tmpdir()` reads TEMP and TMP on
    // Windows and ignores TMPDIR entirely, so the per-invocation isolation
    // this block exists for silently did nothing there and everything landed
    // in the machine's shared %TEMP% instead.
    //
    // That is not merely untidy. Tests that start an embedded PostgreSQL
    // cluster create their data directory with `mkdtemp` under `os.tmpdir()`,
    // and on a developer machine whose %TEMP% has accumulated hundreds of
    // thousands of entries (another tool leaking them is enough) every create
    // and enumerate in that directory slows down. Cluster startup drifts from
    // a couple of seconds to nine or ten, and under the load of a full run it
    // crosses the 20-second `beforeAll` budget - failing two dozen server
    // suites that have nothing wrong with them.
    TEMP: tempDir,
    TMP: tempDir,
  };
  mkdirSync(env.PAPERCLIP_HOME, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  const result = spawnSync(pnpmCommand, ["exec", "vitest", "run", ...args], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
    shell: isWindows,
  });
  if (result.error) {
    console.error(`[test:run] Failed to start Vitest: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const routeTests = walk(serverTestsDir)
  .filter((file) => isRouteOrAuthzTest(toRepoPath(file)))
  .map((file) => ({
    repoPath: toRepoPath(file),
    serverPath: toServerPath(file),
  }))
  .sort((a, b) => a.repoPath.localeCompare(b.repoPath));

const excludeRouteArgs = routeTests.flatMap((file) => ["--exclude", file.serverPath]);
if (runsPart("non-server")) {
  for (const project of nonServerProjects) {
    runVitest(["--project", project], `non-server project ${project}`);
  }
}

if (runsPart("server")) {
  runVitest(
    ["--project", "@paperclipai/server", ...excludeRouteArgs],
    `server suites excluding ${routeTests.length} serialized suites`,
  );
}

// Round-robin over the sorted list, so each shard gets a similar mix and a
// file always lands in the same shard.
const serializedTests = !runsPart("serialized")
  ? []
  : shard
    ? routeTests.filter((_, index) => index % shard.count === shard.index - 1)
    : routeTests;
if (shard) {
  console.log(`\n[test:run] serialized suites, shard ${shard.index}/${shard.count}: ${serializedTests.length} of ${routeTests.length}`);
}
for (const routeTest of serializedTests) {
  runVitest(
    [
      "--project",
      "@paperclipai/server",
      routeTest.repoPath,
      "--pool=forks",
      "--poolOptions.forks.isolate=true",
    ],
    routeTest.repoPath,
  );
}
