import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyInstallPatch,
  buildInstallPatch,
  coldBackup,
  decideRollback,
  describeBackup,
  installArgs,
  isPortInUse,
  parseInstallRecord,
  parseListenLine,
  pollHealth,
  processGroupAlive,
  pruneColdBackups,
  readInstallRecord,
  resolveGuardPaths,
  resolveHealthTarget,
  resolveTrialTimeoutMs,
  runTrial,
  selectTrialPostgres,
  TRIAL_ENV,
  trialCommand,
  updateInstallRecord,
} from "./update-guard.mjs";

const guard = path.join(path.dirname(fileURLToPath(import.meta.url)), "update-guard.mjs");
const BOM = "﻿";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

async function scratch(prefix = "paperclip-guard-") {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

// A git checkout with two commits, so there is something to roll back to.
async function checkout() {
  const repo = await scratch("paperclip-guard-repo-");
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "core.autocrlf", "false");
  await writeFile(path.join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(path.join(repo, "app.txt"), "version 1\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "one");
  const first = git("rev-parse", "HEAD");
  await writeFile(path.join(repo, "app.txt"), "version 2\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "two");
  const second = git("rev-parse", "HEAD");
  return { repo, git, first, second };
}

// A stand-in pnpm on PATH that records its arguments, for both platforms.
async function stubPnpm(dir) {
  const bin = path.join(dir, "bin");
  await mkdir(bin, { recursive: true });
  const log = path.join(dir, "pnpm.log");
  await writeFile(path.join(bin, "pnpm"), `#!/bin/sh\necho "pnpm $*" >> "${log}"\n`);
  await chmod(path.join(bin, "pnpm"), 0o755);
  await writeFile(path.join(bin, "pnpm.cmd"), `@echo off\r\necho pnpm %*>> "${log}"\r\n`);
  return { bin, log };
}

function runGuard(args, { home, bin, extraEnv = {} } = {}) {
  const env = { ...process.env, PAPERCLIP_HOME: home, ...extraEnv };
  delete env.PAPERCLIP_CONFIG;
  delete env.PAPERCLIP_INSTANCE_ID;
  if (bin) {
    const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
    env[key] = `${bin}${path.delimiter}${env[key]}`;
  }
  const result = spawnSync(process.execPath, [guard, ...args], { env, encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

// --- install record ---------------------------------------------------------------

test("previousCommit is recorded while every other field and the BOM are kept", async () => {
  const { repo, second } = await checkout();
  const home = await scratch();
  const marker = path.join(home, "install.json");
  const original = { repoPath: repo, remote: "https://example.com/r.git", branch: "master", commit: SHA_A, installedAt: "2026-01-01T00:00:00.000Z", lastUpdated: "2026-02-01T00:00:00.000Z", custom: { kept: true } };
  await writeFile(marker, BOM + JSON.stringify(original, null, 2));

  const result = runGuard(["record-previous", "--repo", repo], { home });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Rollback point: ${second}`));
  const raw = await readFile(marker, "utf8");
  assert.ok(raw.startsWith(BOM), "the BOM Windows PowerShell wrote is kept");
  assert.deepEqual(JSON.parse(raw.slice(1)), { ...original, previousCommit: second });
});

test("a file without a BOM is written without one, and a missing file is created", async () => {
  const home = await scratch();
  const marker = path.join(home, "nested", "install.json");
  await updateInstallRecord(marker, { previousCommit: SHA_A });
  assert.equal(await readFile(marker, "utf8"), `{\n  "previousCommit": "${SHA_A}"\n}\n`);
  await updateInstallRecord(marker, { previousCommit: undefined, commit: SHA_B });
  assert.deepEqual((await readInstallRecord(marker)).record, { commit: SHA_B });
});

test("parse and patch helpers keep unknown fields and tolerate a BOM", () => {
  assert.deepEqual(parseInstallRecord(`${BOM}{"a":1}`), { record: { a: 1 }, bom: true });
  assert.deepEqual(parseInstallRecord(""), { record: {}, bom: false });
  assert.deepEqual(applyInstallPatch({ a: 1, b: 2 }, { b: undefined, c: 3 }), { a: 1, c: 3 });
  const patch = buildInstallPatch({ installedAt: "then", previousCommit: SHA_A }, { repoPath: "/r", remote: null, branch: "master", commit: SHA_B, now: "now" });
  assert.deepEqual(patch, { repoPath: "/r", branch: "master", commit: SHA_B, installedAt: "then", lastUpdated: "now", previousCommit: undefined });
  // A finished install ends the update's rollback point, and keeps the rest.
  assert.deepEqual(applyInstallPatch({ previousCommit: SHA_A, remote: "x", custom: 1 }, patch), { remote: "x", custom: 1, repoPath: "/r", branch: "master", commit: SHA_B, installedAt: "then", lastUpdated: "now" });
});

test("record-previous --from-install-record uses the installed commit when it is an ancestor", async () => {
  const { repo, first } = await checkout();
  const home = await scratch();
  const marker = path.join(home, "install.json");
  await writeFile(marker, BOM + JSON.stringify({ commit: first, branch: "master" }));
  const result = runGuard(["record-previous", "--from-install-record", "--repo", repo], { home });
  assert.equal(result.code, 0, result.stderr);
  const { record, bom } = await readInstallRecord(marker);
  assert.equal(bom, true);
  assert.deepEqual(record, { commit: first, branch: "master", previousCommit: first });
});

test("record-previous --from-install-record drops a stale rollback point it cannot trust", async () => {
  const { repo } = await checkout();
  const home = await scratch();
  const marker = path.join(home, "install.json");
  await writeFile(marker, JSON.stringify({ commit: SHA_A, previousCommit: SHA_B }));
  const result = runGuard(["record-previous", "--from-install-record", "--repo", repo], { home });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /No rollback point recorded \(the installed commit a{40} is not in this checkout\)/);
  assert.deepEqual((await readInstallRecord(marker)).record, { commit: SHA_A });
});

// The Windows update records after its git pull. These replay that order: the
// checkout sits at the installed commit, then fast-forwards the way a pull does.
test("record-previous --from-install-record accepts the commit a pull started from, and again on a re-run", async () => {
  const { repo, git, first, second } = await checkout();
  git("reset", "--quiet", "--hard", first);
  git("merge", "--quiet", "--ff-only", second);
  const home = await scratch();
  const marker = path.join(home, "install.json");
  await writeFile(marker, JSON.stringify({ commit: first }));
  let result = runGuard(["record-previous", "--from-install-record", "--repo", repo], { home });
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await readInstallRecord(marker)).record.previousCommit, first);
  // A re-run after fixing a failure pulls nothing new, and still agrees.
  git("merge", "--quiet", "--ff-only", second);
  result = runGuard(["record-previous", "--from-install-record", "--repo", repo], { home });
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await readInstallRecord(marker)).record.previousCommit, first);
});

test("record-previous --from-install-record refuses an install.json older than the commit the pull started from", async () => {
  const { repo, git, first, second } = await checkout();
  // Installed `first`, updated to `second` but install.json was never
  // refreshed, and now this update pulls `third`.
  await writeFile(path.join(repo, "app.txt"), "version 3\n");
  git("commit", "--quiet", "-am", "three");
  const third = git("rev-parse", "HEAD");
  git("reset", "--quiet", "--hard", second);
  git("merge", "--quiet", "--ff-only", third);
  const home = await scratch();
  const marker = path.join(home, "install.json");
  await writeFile(marker, JSON.stringify({ commit: first, previousCommit: SHA_B }));
  const result = runGuard(["record-previous", "--from-install-record", "--repo", repo], { home });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`No rollback point recorded \\(the installed commit ${first} in install\\.json is not the commit this checkout was updated from \\(${second}\\)`));
  assert.deepEqual((await readInstallRecord(marker)).record, { commit: first });
});

test("record-previous exits non-zero when it cannot write install.json", async () => {
  const { repo } = await checkout();
  const home = await scratch();
  // A directory where the file should be makes every write fail.
  await mkdir(path.join(home, "install.json"));
  const result = runGuard(["record-previous", "--repo", repo], { home });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /update-guard:/);
});

test("record-install refreshes the install fields and ends the rollback point", async () => {
  const { repo, second } = await checkout();
  const home = await scratch();
  const marker = path.join(home, "install.json");
  await writeFile(marker, BOM + JSON.stringify({ installedAt: "2026-01-01T00:00:00.000Z", previousCommit: SHA_A, commit: SHA_A }));
  const result = runGuard(["record-install", "--repo", repo], { home });
  assert.equal(result.code, 0, result.stderr);
  const { record, bom } = await readInstallRecord(marker);
  assert.equal(bom, true);
  assert.equal(record.commit, second);
  assert.ok(!("previousCommit" in record), "a later failed update cannot reuse this run's rollback point");
  assert.equal(record.installedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(record.repoPath, path.resolve(repo));
  assert.ok(!("remote" in record), "no origin means no remote field, rather than a failure");
});

// --- health target -------------------------------------------------------------------

test("health URL resolution: PORT, then instance config, then launcher.json, then 3100", () => {
  const config = { server: { port: 3200 } };
  const launcher = { port: 3300 };
  assert.equal(resolveHealthTarget({ env: { PORT: "3400" }, config, launcher }).url, "http://127.0.0.1:3400/api/health");
  assert.equal(resolveHealthTarget({ env: {}, config, launcher }).url, "http://127.0.0.1:3200/api/health");
  assert.equal(resolveHealthTarget({ env: {}, config: { server: {} }, launcher }).url, "http://127.0.0.1:3300/api/health");
  assert.equal(resolveHealthTarget({ env: {}, config: null, launcher: null }).url, "http://127.0.0.1:3100/api/health");
  assert.equal(resolveHealthTarget({ env: { PORT: "nope" }, config: { server: { port: 0 } }, launcher: { port: "x" } }).port, 3100);
  assert.equal(resolveHealthTarget({ env: {}, config }).source, "the instance config");
});

// Mirrors resolveRuntimeBind (packages/shared/src/network-bind.ts) as the
// server applies it in server/src/config.ts. The stub keeps tests from
// running the real tailscale command.
const noTailnet = () => undefined;
const target = (server, env = {}, detectTailnet = noTailnet) => resolveHealthTarget({ env, config: { server: { port: 1, ...server } }, detectTailnet });

test("health host follows the address the server binds", () => {
  // A loopback host binds 127.0.0.1, even when it is written ::1 or localhost.
  for (const host of [undefined, "", "127.0.0.1", "::1", "localhost"]) {
    assert.equal(target({ host }).url, "http://127.0.0.1:1/api/health", String(host));
  }
  // All interfaces is reached on loopback.
  assert.equal(target({ host: "0.0.0.0" }).listenHost, "0.0.0.0");
  assert.equal(target({ host: "0.0.0.0" }).host, "127.0.0.1");
  assert.equal(target({ bind: "lan", host: "::" }).url, "http://127.0.0.1:1/api/health");
  // One specific address is used as it is.
  assert.equal(target({ host: "100.64.0.5" }).url, "http://100.64.0.5:1/api/health");
  assert.equal(target({ bind: "custom", customBindHost: "10.0.0.5", host: "127.0.0.1" }).url, "http://10.0.0.5:1/api/health");
  assert.equal(target({}, { PAPERCLIP_BIND: "custom", PAPERCLIP_BIND_HOST: "fd00::5" }).url, "http://[fd00::5]:1/api/health");
  // An explicit bind wins over the host; the environment wins over the file.
  assert.equal(target({ bind: "loopback", host: "100.64.0.5" }).host, "127.0.0.1");
  assert.equal(target({ host: "100.64.0.5" }, { HOST: "127.0.0.1" }).host, "127.0.0.1");
  assert.equal(target({ bind: "loopback" }, { PAPERCLIP_BIND: "lan" }).listenHost, "0.0.0.0");
  // Tailnet binds the detected Tailscale address.
  assert.equal(target({ bind: "tailnet" }, {}, () => "100.100.1.2").host, "100.100.1.2");
  assert.equal(target({ bind: "tailnet" }, { PAPERCLIP_TAILNET_BIND_HOST: "100.100.9.9" }, () => "100.100.1.2").host, "100.100.9.9");
  assert.equal(target({ host: "100.100.1.2", customBindHost: "10.0.0.5" }, {}, () => "100.100.1.2").host, "100.100.1.2");
});

test("the listening address is read from the server's own log line", () => {
  const pretty = "[12:00:01] \x1b[32mINFO\x1b[39m: \x1b[36mServer listening on 127.0.0.1:3101\x1b[39m";
  assert.deepEqual(parseListenLine(pretty), { listenHost: "127.0.0.1", host: "127.0.0.1", port: 3101, url: "http://127.0.0.1:3101/api/health" });
  assert.equal(parseListenLine('{"level":30,"msg":"Server listening on 0.0.0.0:3100"}').url, "http://127.0.0.1:3100/api/health");
  assert.equal(parseListenLine("INFO: Server listening on :::3100").url, "http://127.0.0.1:3100/api/health");
  assert.equal(parseListenLine("INFO: Server listening on 100.64.0.5:3200").url, "http://100.64.0.5:3200/api/health");
  assert.equal(parseListenLine("INFO: Server listening on fd00::5:3200").url, "http://[fd00::5]:3200/api/health");
  assert.equal(parseListenLine("INFO: Server listening on [fd00::5]:3200").url, "http://[fd00::5]:3200/api/health");
  assert.equal(parseListenLine("INFO: Requested port is busy; using next free port"), null);
  assert.equal(parseListenLine("Server listening on 127.0.0.1:99999"), null);
});

test("paths follow PAPERCLIP_HOME, PAPERCLIP_INSTANCE_ID and PAPERCLIP_CONFIG", () => {
  const home = path.resolve("/tmp/pc-home");
  const byHome = resolveGuardPaths({ PAPERCLIP_HOME: home, PAPERCLIP_INSTANCE_ID: "two" }, "/ignored");
  assert.equal(byHome.configPath, path.join(home, "instances", "two", "config.json"));
  assert.equal(byHome.installRecord, path.join(home, "install.json"));
  assert.equal(byHome.launcherConfig, path.join(home, "launcher.json"));
  const explicit = resolveGuardPaths({ PAPERCLIP_CONFIG: path.join(home, "c.json") }, home);
  assert.equal(explicit.configPath, path.join(home, "c.json"));
  assert.equal(resolveGuardPaths({}, home).home, path.join(home, ".paperclip"));
});

test("trial timeout defaults to 120 s and can be overridden", () => {
  assert.equal(resolveTrialTimeoutMs({}), 120_000);
  assert.equal(resolveTrialTimeoutMs({ PAPERCLIP_UPDATE_TRIAL_TIMEOUT_SECONDS: "30" }), 30_000);
  assert.equal(resolveTrialTimeoutMs({ PAPERCLIP_UPDATE_TRIAL_TIMEOUT_SECONDS: "-1" }), 120_000);
});

// --- polling ------------------------------------------------------------------------------

function fakeClock() {
  let time = 0;
  return { now: () => time, sleep: async (ms) => { time += ms; } };
}
const okResponse = { ok: true, status: 200, json: async () => ({ status: "ok" }) };
const refused = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });

test("poll succeeds on the first healthy answer", async () => {
  const clock = fakeClock();
  const result = await pollHealth({ url: "http://x/api/health", timeoutMs: 10_000, fetchImpl: async () => okResponse, ...clock });
  assert.equal(result.healthy, true);
  assert.equal(result.attempts, 1);
});

test("poll tolerates connection refused and unhealthy answers before success", async () => {
  const clock = fakeClock();
  const answers = [refused(), refused(), { ok: false, status: 503, json: async () => ({ status: "unhealthy", error: "database_unreachable" }) }, okResponse];
  const result = await pollHealth({
    url: "http://x/api/health",
    timeoutMs: 60_000,
    fetchImpl: async () => {
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    ...clock,
  });
  assert.equal(result.healthy, true);
  assert.equal(result.attempts, 4);
  assert.equal(clock.now(), 3000);
});

test("poll times out with the last result in the reason", async () => {
  const clock = fakeClock();
  const result = await pollHealth({ url: "http://x/api/health", timeoutMs: 5000, fetchImpl: async () => { throw refused(); }, ...clock });
  assert.equal(result.healthy, false);
  assert.match(result.reason, /within 5 s \(last result: connection refused\)/);
  assert.equal(clock.now(), 5000);
  assert.equal(result.attempts, 6);
});

test("poll gives up at once when the server process has exited", async () => {
  const clock = fakeClock();
  let calls = 0;
  const result = await pollHealth({
    url: "http://x/api/health",
    timeoutMs: 60_000,
    fetchImpl: async () => { calls += 1; throw refused(); },
    shouldStop: () => (calls >= 2 ? "the server exited" : null),
    ...clock,
  });
  assert.equal(result.healthy, false);
  assert.equal(result.reason, "the server exited");
  assert.equal(calls, 2);
});

// --- rollback ------------------------------------------------------------------------------

test("rollback is refused without a previousCommit, or when it is the failed commit", () => {
  assert.equal(decideRollback({ previousCommit: undefined, currentCommit: SHA_B }).ok, false);
  assert.match(decideRollback({ previousCommit: "", currentCommit: SHA_B }).reason, /nothing to roll back to/);
  assert.equal(decideRollback({ previousCommit: "abc123", currentCommit: SHA_B }).ok, false);
  assert.match(decideRollback({ previousCommit: SHA_B, currentCommit: SHA_B }).reason, /would change nothing/);
});

test("rollback is refused when the rollback point is not the installed commit", () => {
  const stale = decideRollback({ previousCommit: SHA_A, currentCommit: "c".repeat(40), installedCommit: SHA_B });
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /is not the installed commit b{40} in install\.json, so it may be left over from an earlier update/);
  assert.equal(decideRollback({ previousCommit: SHA_A, currentCommit: SHA_B, installedCommit: SHA_A }).ok, true);
  // No installed commit on record is not evidence either way.
  assert.equal(decideRollback({ previousCommit: SHA_A, currentCommit: SHA_B, installedCommit: undefined }).ok, true);
});

test("the rollback command leaves the checkout alone when the rollback point is stale", async () => {
  const { repo, git, first, second } = await checkout();
  const home = await scratch();
  const stub = await stubPnpm(home);
  // A successful update to `second` left previousCommit behind, and nothing
  // refreshed it, so rolling back would land on `first`.
  await writeFile(path.join(home, "install.json"), JSON.stringify({ commit: second, previousCommit: first }));
  await writeFile(path.join(repo, "app.txt"), "version 3\n");
  git("commit", "--quiet", "-am", "three");
  const third = git("rev-parse", "HEAD");
  const result = runGuard(["rollback", "--repo", repo], { home, bin: stub.bin });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Cannot roll back automatically: .*may be left over from an earlier update/);
  assert.equal(git("rev-parse", "HEAD"), third);
  assert.ok(!existsSync(stub.log));
});

test("rollback uses reset --keep with the recorded sha, never --hard", () => {
  const decision = decideRollback({ previousCommit: SHA_A, currentCommit: SHA_B });
  assert.deepEqual(decision, { ok: true, target: SHA_A, resetArgs: ["reset", "--keep", SHA_A] });
  assert.ok(!decision.resetArgs.includes("--hard"));
});

test("the rollback command returns the checkout to previousCommit and rebuilds", async () => {
  const { repo, git, first } = await checkout();
  const home = await scratch();
  const stub = await stubPnpm(home);
  await writeFile(path.join(home, "install.json"), JSON.stringify({ commit: first, previousCommit: first }));
  const result = runGuard(["rollback", "--repo", repo], { home, bin: stub.bin });
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(git("rev-parse", "HEAD"), first);
  assert.equal(await readFile(path.join(repo, "app.txt"), "utf8"), "version 1\n");
  const pnpmCalls = (await readFile(stub.log, "utf8")).trim().split(/\r?\n/).map((line) => line.trim());
  assert.deepEqual(pnpmCalls, ["pnpm build:runtime"], "an unchanged lockfile needs no reinstall");
  assert.match(result.stdout, /Migrations were not undone/);
});

test("the rollback command reinstalls when the lockfile differs", async () => {
  const { repo, git, first } = await checkout();
  await writeFile(path.join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nnew: true\n");
  git("commit", "--quiet", "-am", "three");
  const home = await scratch();
  const stub = await stubPnpm(home);
  await writeFile(path.join(home, "install.json"), JSON.stringify({ previousCommit: first }));
  const result = runGuard(["rollback", "--repo", repo], { home, bin: stub.bin });
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const pnpmCalls = (await readFile(stub.log, "utf8")).trim().split(/\r?\n/).map((line) => line.trim());
  assert.deepEqual(pnpmCalls, [`pnpm ${installArgs().join(" ")}`, "pnpm build:runtime"]);
});

test("the rollback command refuses rather than discard a local edit", async () => {
  const { repo, git, second, first } = await checkout();
  await writeFile(path.join(repo, "app.txt"), "my local edit\n");
  const home = await scratch();
  const stub = await stubPnpm(home);
  await writeFile(path.join(home, "install.json"), JSON.stringify({ previousCommit: first }));
  const result = runGuard(["rollback", "--repo", repo], { home, bin: stub.bin });
  assert.equal(result.code, 1);
  assert.equal(git("rev-parse", "HEAD"), second);
  assert.equal(await readFile(path.join(repo, "app.txt"), "utf8"), "my local edit\n");
  assert.ok(!existsSync(stub.log), "nothing is rebuilt after a refused reset");
});

test("the rollback command only reports when no previousCommit is recorded", async () => {
  const { repo, git, second } = await checkout();
  const home = await scratch();
  const result = runGuard(["rollback", "--repo", repo], { home });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Cannot roll back automatically: No previous commit is recorded/);
  assert.equal(git("rev-parse", "HEAD"), second);
});

test("the backup note names the backup folder, or says the database is external", () => {
  const configPath = path.join(path.resolve("/tmp/inst"), "config.json");
  assert.match(describeBackup({ database: { mode: "embedded-postgres" } }, configPath), new RegExp(`in ${path.join(path.resolve("/tmp/inst"), "data", "backups").replace(/\\/g, "\\\\")}`));
  assert.match(describeBackup({ database: { mode: "postgres" } }, configPath), /external PostgreSQL server/);
});

// --- trial commands --------------------------------------------------------------------------

test("the Windows trial starts the server exactly the way the tray does", async () => {
  const repo = await scratch();
  await mkdir(path.join(repo, "ui", "node_modules"), { recursive: true });
  await writeFile(path.join(repo, "ui", "node_modules", ".paperclip-vite-generation"), "gen-1\n");
  const spec = trialCommand("windows", { repo, env: { PAPERCLIP_CONFIG: "c.json", KEEP: "1" } });
  assert.equal(spec.command, "cmd");
  assert.deepEqual(spec.args, ["/c", "pnpm", "--dir", repo, "--filter", "paperclipai", "exec", "tsx", "src/index.ts", "run"]);
  assert.equal(spec.cwd, path.join(repo, "scripts", "launchers", "windows"));
  assert.deepEqual(spec.env, { PAPERCLIP_CONFIG: "c.json", KEEP: "1", PAPERCLIP_UI_CACHE_GENERATION: "gen-1", ...TRIAL_ENV });
});

test("the Unix trial starts the server the way service start does, without the maintenance log", () => {
  const spec = trialCommand("unix", { repo: "/repo", env: { PAPERCLIP_CONFIG: "c.json", PAPERCLIP_MAINTENANCE_LOG: "/log" } });
  assert.equal(spec.command, "pnpm");
  assert.deepEqual(spec.args, ["--dir", "/repo", "--filter", "@paperclipai/server", "exec", "tsx", "../scripts/installed-service.ts", "start"]);
  assert.equal(spec.cwd, "/repo");
  assert.deepEqual(spec.env, { PAPERCLIP_CONFIG: "c.json", ...TRIAL_ENV });
  assert.throws(() => trialCommand("beos", { repo: "/repo" }), /Unknown launcher/);
});

test("the trial server starts no agent runs, schedulers or plugins, whatever the environment says", () => {
  assert.deepEqual(TRIAL_ENV, { HEARTBEAT_SCHEDULER_ENABLED: "false", PAPERCLIP_PLUGIN_RUNTIME_ENABLED: "false" });
  const env = { HEARTBEAT_SCHEDULER_ENABLED: "true", PAPERCLIP_PLUGIN_RUNTIME_ENABLED: "true" };
  for (const launcher of ["windows", "unix"]) {
    const spec = trialCommand(launcher, { repo: path.resolve("/repo"), env });
    assert.equal(spec.env.HEARTBEAT_SCHEDULER_ENABLED, "false", launcher);
    assert.equal(spec.env.PAPERCLIP_PLUGIN_RUNTIME_ENABLED, "false", launcher);
  }
  // The names the server reads (server/src/config.ts, plugin-runtime-startup.ts).
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  assert.match(readFileSync(path.join(root, "server", "src", "config.ts"), "utf8"), /process\.env\.HEARTBEAT_SCHEDULER_ENABLED !== "false"/);
  assert.match(readFileSync(path.join(root, "server", "src", "plugin-runtime-startup.ts"), "utf8"), /PLUGIN_RUNTIME_ENV = "PAPERCLIP_PLUGIN_RUNTIME_ENABLED"/);
});

test("the trial-start command passes the trial environment to the server", async () => {
  const home = await scratch();
  const port = await freePort();
  await mkdir(path.join(home, "instances", "default"), { recursive: true });
  await writeFile(path.join(home, "instances", "default", "config.json"), JSON.stringify({ server: { port } }));
  const script = "console.log('flags ' + process.env.HEARTBEAT_SCHEDULER_ENABLED + ' ' + process.env.PAPERCLIP_PLUGIN_RUNTIME_ENABLED); process.exit(5)";
  const result = runGuard(["trial-start", "--", process.execPath, "-e", script], { home, extraEnv: { HEARTBEAT_SCHEDULER_ENABLED: "true" } });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /flags false false/);
});

test("only postgres from this checkout, started after the trial began, is swept", () => {
  const repo = path.resolve("/srv/paperclip");
  const modules = path.join(repo, "node_modules").replaceAll("\\", "/");
  const startedAt = Date.parse("2026-10-09T18:00:00.000Z");
  const procs = [
    { pid: 1, name: "postgres.exe", commandLine: `"${modules}/.pnpm/pg/native/bin/postgres.exe" --forkchild="io_worker" 1`, created: "2026-10-09T18:00:05.000Z" },
    { pid: 2, name: "postgres.exe", commandLine: `${path.join(repo, "node_modules", "pg", "postgres.exe")} -D C:\\data`, created: "2026-10-09T18:00:01.000Z" },
    { pid: 3, name: "postgres.exe", commandLine: `"${modules}/pg/postgres.exe"`, created: "2026-10-09T17:00:00.000Z" },
    { pid: 4, name: "postgres.exe", commandLine: '"C:/other/checkout/node_modules/pg/postgres.exe"', created: "2026-10-09T18:00:05.000Z" },
    { pid: 5, name: "node.exe", commandLine: `${modules}/tsx/cli.mjs`, created: "2026-10-09T18:00:05.000Z" },
    { pid: 6, name: "postgres.exe", commandLine: null, executablePath: path.join(repo, "node_modules", "pg", "postgres.exe"), created: "2026-10-09T18:00:05.000Z" },
  ];
  assert.deepEqual(selectTrialPostgres(procs, { repo, startedAt }).map((proc) => proc.pid), [1, 2, 6]);
});

// --- trial against a stub server ----------------------------------------------------------------

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// The stub starts a grandchild first, so the test can prove the whole tree is
// stopped, then serves /api/health according to its mode.
const STUB = `
import http from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const [port, mode, delayMs, pidFile] = process.argv.slice(2);
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(pidFile, String(grandchild.pid));
console.log("stub server starting");
// A server whose shutdown hangs, so only a force kill stops it.
if (process.env.STUB_IGNORE_SIGTERM) process.on("SIGTERM", () => console.log("stub server ignoring SIGTERM"));
if (mode === "crash") {
  console.error("Error: pending migration 0042 could not be applied");
  grandchild.kill();
  process.exit(3);
}
const server = http.createServer((req, res) => {
  const healthy = mode === "ok";
  res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
  res.end(JSON.stringify(healthy ? { status: "ok" } : { status: "unhealthy", error: "database_unreachable" }));
});
// The line the real server logs once it is listening, as pino-pretty prints it.
setTimeout(() => server.listen(Number(port), "127.0.0.1", () => console.log("[12:00:00] \\x1b[32mINFO\\x1b[39m: \\x1b[36mServer listening on 127.0.0.1:" + port + "\\x1b[39m")), Number(delayMs));
`;

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A killed orphan nobody has reaped yet (a container without an init
  // process) still answers kill 0, but it is a zombie, not running.
  if (process.platform === "linux") {
    try {
      return !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, "utf8"));
    } catch {
      return false;
    }
  }
  return true;
}

// targetPort is where the guard expects the server before it hears from it;
// it defaults to the port the stub really uses.
async function trial(mode, { delayMs = 0, timeoutMs = 15_000, targetPort = null } = {}) {
  const dir = await scratch("paperclip-guard-trial-");
  const stub = path.join(dir, "stub-server.mjs");
  await writeFile(stub, STUB);
  const port = await freePort();
  const pidFile = path.join(dir, "grandchild.pid");
  const nodeArgs = [stub, String(port), mode, String(delayMs), pidFile];
  // On Windows go through cmd, like the tray does, so the tree kill matters.
  const spec = process.platform === "win32"
    ? { command: "cmd", args: ["/c", process.execPath, ...nodeArgs] }
    : { command: process.execPath, args: nodeArgs };
  const target = resolveHealthTarget({ env: {}, config: { server: { port: targetPort ?? port } } });
  const result = await runTrial({ ...spec, cwd: dir, env: { ...process.env }, target, timeoutMs, logFile: path.join(dir, "logs", "trial.log"), intervalMs: 200 });
  const grandchild = existsSync(pidFile) ? Number(await readFile(pidFile, "utf8")) : null;
  return { result, port, grandchild, dir };
}

test("a trial against a server that becomes healthy passes and leaves nothing running", async () => {
  const { result, port, grandchild } = await trial("ok", { delayMs: 1500 });
  assert.equal(result.status, "passed", result.reason);
  assert.equal(await isPortInUse("127.0.0.1", port), false, "the trial server is stopped");
  assert.ok(grandchild && !pidAlive(grandchild), "the whole process tree is stopped");
});

// The real Unix trial is pnpm, then tsx, then scripts/installed-service.ts,
// which starts the server DETACHED (a process group of its own) and on
// SIGTERM stops it, falling back to a force kill (terminateLocalService with
// forceAfterMs). These stand-ins keep that shape: a wrapper that exits as
// soon as it is signalled, a middle process that owns a detached server, and
// a server that ignores SIGTERM so only the middle's force kill stops it.
const WRAPPER = `
import { spawn } from "node:child_process";
const middle = spawn(process.execPath, process.argv.slice(2), { stdio: "inherit" });
process.on("SIGTERM", () => process.exit(0));
middle.on("exit", (code) => process.exit(code ?? 0));
`;
const MIDDLE = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const [serverPidFile, forceAfterMs, ...serverArgs] = process.argv.slice(2);
const server = spawn(process.execPath, serverArgs, { stdio: "inherit", detached: true, env: { ...process.env, STUB_IGNORE_SIGTERM: "1" } });
writeFileSync(serverPidFile, String(server.pid));
const exited = new Promise((resolve) => server.once("exit", resolve));
process.once("SIGTERM", async () => {
  try { process.kill(-server.pid, "SIGTERM"); } catch {}
  const timer = setTimeout(() => { try { process.kill(-server.pid, "SIGKILL"); } catch {} }, Number(forceAfterMs));
  await exited;
  clearTimeout(timer);
  process.exit(0);
});
await exited;
`;

test("a trial through a middle process that starts the server detached leaves nothing running", { skip: process.platform === "win32" }, async () => {
  const dir = await scratch("paperclip-guard-detached-");
  for (const [name, source] of [["stub-server.mjs", STUB], ["wrapper.mjs", WRAPPER], ["middle.mjs", MIDDLE]]) {
    await writeFile(path.join(dir, name), source);
  }
  const port = await freePort();
  const grandchildFile = path.join(dir, "grandchild.pid");
  const serverPidFile = path.join(dir, "server.pid");
  const args = [path.join(dir, "wrapper.mjs"), path.join(dir, "middle.mjs"), serverPidFile, "4000", path.join(dir, "stub-server.mjs"), String(port), "ok", "0", grandchildFile];
  const target = resolveHealthTarget({ env: {}, config: { server: { port } } });
  let serverPid = null;
  try {
    const result = await runTrial({ command: process.execPath, args, cwd: dir, env: { ...process.env }, target, timeoutMs: 15_000, logFile: path.join(dir, "trial.log"), intervalMs: 200 });
    assert.equal(result.status, "passed", result.reason);
    serverPid = Number(await readFile(serverPidFile, "utf8"));
    const grandchild = Number(await readFile(grandchildFile, "utf8"));
    assert.equal(pidAlive(serverPid), false, "the detached server was stopped, by its owner's force kill");
    assert.equal(pidAlive(grandchild), false, "and so was everything it started");
    assert.equal(await isPortInUse("127.0.0.1", port), false);
    assert.match(await readFile(path.join(dir, "trial.log"), "utf8"), /stub server ignoring SIGTERM/);
  } finally {
    if (serverPid && pidAlive(serverPid)) process.kill(-serverPid, "SIGKILL");
  }
});

test("a process group counts as gone once only zombies are left", { skip: process.platform === "win32" }, async () => {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  await new Promise((resolve) => child.once("spawn", resolve));
  assert.equal(processGroupAlive(child.pid), true);
  process.kill(-child.pid, "SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(processGroupAlive(child.pid), false);
});

test("a trial follows the address the server says it is listening on", async () => {
  // The guard expects another port, as when the server moved off a busy one
  // or binds somewhere the config does not say. Nothing answers there.
  const elsewhere = await freePort();
  const { result, port, grandchild } = await trial("ok", { delayMs: 500, targetPort: elsewhere, timeoutMs: 10_000 });
  assert.equal(result.status, "passed", result.reason);
  assert.equal(result.url, `http://127.0.0.1:${port}/api/health`);
  assert.equal(await isPortInUse("127.0.0.1", port), false, "the trial server is stopped");
  assert.ok(grandchild && !pidAlive(grandchild));
});

test("a trial against a server that exits reports why, with its last output", async () => {
  const { result, dir } = await trial("crash");
  assert.equal(result.status, "failed");
  assert.match(result.reason, /exited before it became healthy \(exit code 3\)/);
  assert.ok(result.tail.some((line) => line.includes("pending migration 0042")), result.tail.join("\n"));
  assert.match(await readFile(path.join(dir, "logs", "trial.log"), "utf8"), /pending migration 0042/);
});

test("a trial against a server that never becomes healthy times out and is stopped", async () => {
  const { result, port, grandchild } = await trial("unhealthy", { timeoutMs: 2500 });
  assert.equal(result.status, "failed");
  assert.match(result.reason, /within 3 s \(last result: HTTP 503 \(unhealthy: database_unreachable\)\)/);
  assert.equal(await isPortInUse("127.0.0.1", port), false);
  assert.ok(grandchild && !pidAlive(grandchild));
});

test("a trial is skipped when something already holds the port", async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const { port } = blocker.address();
  try {
    const target = resolveHealthTarget({ config: { server: { port } } });
    const result = await runTrial({ command: process.execPath, args: ["-e", "process.exit(9)"], cwd: os.tmpdir(), env: process.env, target, timeoutMs: 1000, logFile: path.join(await scratch(), "t.log") });
    assert.equal(result.status, "skipped");
    assert.match(result.reason, new RegExp(`Port ${port} is already in use`));
  } finally {
    blocker.close();
  }
});

test("the trial-start command exits non-zero and prints the server's last lines", async () => {
  const home = await scratch();
  const port = await freePort();
  await mkdir(path.join(home, "instances", "default"), { recursive: true });
  await writeFile(path.join(home, "instances", "default", "config.json"), JSON.stringify({ server: { port } }));
  const result = runGuard(["trial-start", "--", process.execPath, "-e", "console.log('boot failed: bad config'); process.exit(4)"], { home });
  assert.equal(result.code, 1);
  assert.match(result.stdout, new RegExp(`127\\.0\\.0\\.1:${port}/api/health \\(port from the instance config\\)`));
  assert.match(result.stderr, /Trial start failed: the server exited before it became healthy \(exit code 4\)/);
  assert.match(result.stderr, /boot failed: bad config/);
  const logs = await readdir(path.join(home, "logs"));
  assert.ok(logs.some((name) => /^update-trial-\d{8}T\d{6}Z\.log$/.test(name)), logs.join(","));
});

// --- cold backup ----------------------------------------------------------------------------------

test("a cold backup copies the stopped database without its pid file", async () => {
  const root = await scratch();
  const configPath = path.join(root, "config.json");
  const dataDir = path.join(root, "db");
  await mkdir(path.join(dataDir, "base"), { recursive: true });
  await writeFile(path.join(dataDir, "base", "1"), "rows\n");
  await writeFile(path.join(dataDir, "postmaster.pid"), "999999999\n");
  const config = { database: { mode: "embedded-postgres", embeddedPostgresDataDir: dataDir, backup: { dir: path.join(root, "backups") } } };
  const result = await coldBackup({ config, configPath, now: new Date("2026-10-09T01:02:03Z") });
  assert.equal(result.status, "saved");
  assert.equal(result.dest, path.join(root, "backups", "cold-20261009T010203Z"));
  assert.equal(await readFile(path.join(result.dest, "db", "base", "1"), "utf8"), "rows\n");
  assert.ok(!existsSync(path.join(result.dest, "db", "postmaster.pid")));
});

test("a cold backup skips external databases and missing data, and refuses a running database", async () => {
  const root = await scratch();
  const configPath = path.join(root, "config.json");
  assert.equal((await coldBackup({ config: null, configPath })).status, "skipped");
  assert.equal((await coldBackup({ config: { database: { mode: "postgres" } }, configPath })).status, "skipped");
  assert.equal((await coldBackup({ config: { database: {} }, configPath })).status, "skipped");
  if (process.platform !== "win32") {
    // On Windows only a pid that belongs to postgres counts, which a test cannot fake.
    const dataDir = path.join(root, "db");
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, "postmaster.pid"), `${process.pid}\n`);
    const refused = await coldBackup({ config: { database: { embeddedPostgresDataDir: dataDir } }, configPath });
    assert.equal(refused.status, "refused");
    assert.match(refused.message, /PostgreSQL is still running/);
  }
});

// --- pruning cold backups ---------------------------------------------------------------------------

async function backupFolder() {
  const backupDir = path.join(await scratch(), "backups");
  for (const name of ["cold-20261001T000000Z", "cold-20261003T000000Z", "cold-20261002T000000Z", "cold-20260901T120000Z", "cold-notes", "manual-copy"]) {
    await mkdir(path.join(backupDir, name, "db"), { recursive: true });
    await writeFile(path.join(backupDir, name, "db", "PG_VERSION"), "18\n");
  }
  // Ordinary backup files, and a FILE with a cold-* name, are never touched.
  await writeFile(path.join(backupDir, "paperclip-20260901-000000.sql.gz"), "dump");
  await writeFile(path.join(backupDir, "cold-20250101T000000Z"), "not a folder");
  return backupDir;
}

test("pruning keeps the newest two cold copies and touches nothing else", async () => {
  const backupDir = await backupFolder();
  const { removed, kept } = await pruneColdBackups({ backupDir });
  assert.deepEqual(removed.map((dir) => path.basename(dir)), ["cold-20260901T120000Z", "cold-20261001T000000Z"]);
  assert.deepEqual(kept.map((dir) => path.basename(dir)), ["cold-20261002T000000Z", "cold-20261003T000000Z"]);
  assert.deepEqual((await readdir(backupDir)).sort(), [
    "cold-20250101T000000Z",
    "cold-20261002T000000Z",
    "cold-20261003T000000Z",
    "cold-notes",
    "manual-copy",
    "paperclip-20260901-000000.sql.gz",
  ]);
  // Two or fewer is left alone, and a missing folder is not an error.
  assert.deepEqual((await pruneColdBackups({ backupDir })).removed, []);
  assert.deepEqual(await pruneColdBackups({ backupDir: path.join(backupDir, "absent") }), { removed: [], kept: [] });
});

test("the prune-cold-backups command uses the instance's backup folder", async () => {
  const home = await scratch();
  const backupDir = await backupFolder();
  await mkdir(path.join(home, "instances", "default"), { recursive: true });
  await writeFile(path.join(home, "instances", "default", "config.json"), JSON.stringify({ database: { mode: "embedded-postgres", backup: { dir: backupDir } } }));
  const result = runGuard(["prune-cold-backups"], { home });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Removed old cold backup: .*cold-20260901T120000Z/);
  assert.deepEqual((await readdir(backupDir)).filter((name) => name.startsWith("cold-2026")).sort(), ["cold-20261002T000000Z", "cold-20261003T000000Z"]);
  // An external database, or no config at all, has nothing to prune.
  const bare = await scratch();
  assert.equal(runGuard(["prune-cold-backups"], { home: bare }).code, 0);
});

// --- update-paperclip.bat: the rollback block ------------------------------------------------------
// git reset --keep can replace the running .bat with the previous version's
// copy. These run the real rollback section from update-paperclip.bat in a
// harness whose stand-in rollback overwrites the harness file mid-run, the
// way the reset would, and check nothing is then read from the new file.

const BAT = path.join(path.dirname(fileURLToPath(import.meta.url)), "windows", "update-paperclip.bat");
// Where a label line starts, not a goto that names it.
const labelAt = (text, label) => text.search(new RegExp(`^:${label}\\r?$`, "m"));

async function batHarness({ context, rollbackExit, flattenBlock = false }) {
  const dir = await scratch("paperclip-guard-bat-");
  const harness = path.join(dir, "update-harness.bat");
  const real = readFileSync(BAT, "utf8");
  let section = real.slice(labelAt(real, "roll_back"), labelAt(real, "record_previous_failed"));
  assert.ok(section.startsWith(":roll_back"), "the rollback section is found");
  if (flattenBlock) {
    // The structure this replaced: the same lines, read one at a time.
    section = section.replace(/^\(\r\n/m, "").replace(/^\)\r\n/m, "");
  }
  // The stand-in for update-guard.mjs: it rewrites the running batch file, as
  // git reset --keep does to the real one, with lines that leave a mark.
  const marker = path.join(dir, "old-file-ran.txt");
  const guard = path.join(dir, "guard-stub.mjs");
  const oldFile = `@echo off\r\n${`echo OLD-FILE-RAN>>"${marker}"\r\n`.repeat(400)}`;
  await writeFile(guard, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(harness)}, ${JSON.stringify(oldFile)});\nconsole.log("stub rollback ran");\nprocess.exit(${rollbackExit});\n`);
  const restarted = path.join(dir, "restarted.txt");
  await writeFile(path.join(dir, "stop-paperclip.ps1"), `Set-Content -Path '${restarted}' -Value 'restarted'\r\nexit 0\r\n`);
  const header = ["@echo off", "setlocal EnableDelayedExpansion", `set "UPDATE_GUARD=${guard}"`, `set "ROLLBACK_CONTEXT=${context}"`, "goto :roll_back", ""].join("\r\n");
  await writeFile(harness, header + section);
  const result = spawnSync("cmd", ["/d", "/c", harness], { input: "", encoding: "utf8", windowsHide: true });
  return {
    code: result.status,
    out: `${result.stdout}${result.stderr}`,
    oldFileRan: existsSync(marker),
    restarted: existsSync(restarted),
  };
}

const windowsOnly = { skip: process.platform !== "win32" };

test("the .bat rollback runs to the end from memory even though the reset replaces the file", windowsOnly, async () => {
  const run = await batHarness({ context: "trial", rollbackExit: 0 });
  assert.match(run.out, /stub rollback ran/);
  assert.match(run.out, /Rolled back\. Starting the previous version again\./);
  assert.equal(run.restarted, true, "the previous version is started");
  assert.match(run.out, /Paperclip is running again, but the update did not go through\./);
  assert.equal(run.oldFileRan, false, "nothing was read from the replaced file");
  assert.equal(run.code, 1);
});

test("the harness does catch a rollback section that is read line by line", windowsOnly, async () => {
  const run = await batHarness({ context: "trial", rollbackExit: 0, flattenBlock: true });
  assert.equal(run.oldFileRan, true, "without the block, cmd carries on inside the replaced file");
});

test("after a failed backup the .bat starts the previous version once it is rolled back", windowsOnly, async () => {
  const run = await batHarness({ context: "backup", rollbackExit: 0 });
  assert.match(run.out, /Rolled back\. Starting the previous version again\./);
  assert.equal(run.restarted, true);
  assert.equal(run.oldFileRan, false);
  assert.equal(run.code, 1);
});

test("after a failed backup with nothing to roll back to, the .bat stops without starting anything", windowsOnly, async () => {
  for (const rollbackExit of [2, 1]) {
    const run = await batHarness({ context: "backup", rollbackExit });
    assert.equal(run.restarted, false, `rollback exit ${rollbackExit}: nothing is started`);
    assert.match(run.out, /Paperclip has NOT been restarted\. The files now in the checkout/);
    assert.match(run.out, rollbackExit === 2 ? /No earlier version is recorded/ : /Rolling back also failed/);
    assert.equal(run.oldFileRan, false);
    assert.equal(run.code, 1);
  }
});

test("after a failed install or build the .bat starts the previous version once it is rolled back", windowsOnly, async () => {
  const run = await batHarness({ context: "prepare", rollbackExit: 0 });
  assert.match(run.out, /stub rollback ran/);
  assert.match(run.out, /Rolled back\. Starting the previous version again\./);
  assert.equal(run.restarted, true);
  assert.equal(run.oldFileRan, false);
  assert.equal(run.code, 1);
});

test("after a failed install or build with nothing to roll back to, the .bat stops without starting anything", windowsOnly, async () => {
  for (const rollbackExit of [2, 1]) {
    const run = await batHarness({ context: "prepare", rollbackExit });
    assert.equal(run.restarted, false, `rollback exit ${rollbackExit}: nothing is started`);
    assert.match(run.out, /Paperclip has NOT been restarted\. The files now in the checkout/);
    assert.match(run.out, rollbackExit === 2 ? /No earlier version is recorded/ : /Rolling back also failed/);
    assert.equal(run.oldFileRan, false);
    assert.equal(run.code, 1);
  }
});

test("a failed install or build in update-paperclip.bat goes to the rollback, not the old restart", async () => {
  const source = readFileSync(BAT, "utf8").replace(/\r\n/g, "\n");
  const after = (line) => source.slice(source.indexOf(line) + line.length).split("\n")[1].trim();
  assert.equal(after('call pnpm --dir "%PAPERCLIP_SRC%" install'), "if !errorlevel! neq 0 goto :prepare_failed");
  assert.equal(after('call pnpm --dir "%PAPERCLIP_SRC%" build:runtime'), "if !errorlevel! neq 0 goto :prepare_failed");
  const prepare = source.slice(labelAt(source, "prepare_failed"), labelAt(source, "backup_failed"));
  assert.match(prepare, /set "ROLLBACK_CONTEXT=prepare"\ngoto :roll_back\n/);
  // Only a failed migration still uses the old path, which restarts the files in place.
  assert.deepEqual(source.match(/goto :update_failed/g), ["goto :update_failed"]);
  assert.equal(after('call pnpm --dir "%PAPERCLIP_SRC%" db:migrate'), "if !errorlevel! neq 0 goto :update_failed");
});

test("after a failed trial with nothing to roll back to, the .bat still tries to start Paperclip", windowsOnly, async () => {
  const run = await batHarness({ context: "trial", rollbackExit: 2 });
  assert.match(run.out, /Trying to start the updated version anyway/);
  assert.equal(run.restarted, true);
});

test("update-paperclip.bat sends each failure to the right place", async () => {
  const source = readFileSync(BAT, "utf8").replace(/\r\n/g, "\n");
  const after = (line) => source.slice(source.indexOf(line) + line.length).split("\n")[1];
  assert.equal(after('node "%UPDATE_GUARD%" record-previous --from-install-record'), "if errorlevel 1 goto :record_previous_failed");
  assert.equal(after('node "%UPDATE_GUARD%" cold-backup'), "if !errorlevel! neq 0 goto :backup_failed");
  assert.equal(after('node "%UPDATE_GUARD%" record-install'), "if errorlevel 1 (");
  assert.ok(source.indexOf('node "%UPDATE_GUARD%" prune-cold-backups') > source.indexOf('node "%UPDATE_GUARD%" record-install'));
  // The stop after a failed record says so and starts nothing.
  const recordFailed = source.slice(labelAt(source, "record_previous_failed"), labelAt(source, "update_failed"));
  assert.ok(recordFailed.length > 0);
  assert.match(recordFailed, /Paperclip has NOT been restarted/);
  assert.doesNotMatch(recordFailed, /stop-paperclip\.ps1/);
});
