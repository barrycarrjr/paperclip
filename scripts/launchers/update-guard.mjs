// Safe update with automatic rollback, shared by the Windows and Unix
// launchers (scripts/launchers/windows/update-paperclip.bat and
// scripts/launchers/unix/update-paperclip.sh).
//
// An update records the commit it is replacing, builds and migrates the new
// code, then starts the new server once as a trial, the same way that
// platform's launcher starts it. Only a trial that answers healthy on
// /api/health lets the update carry on to the real relaunch. A failed trial
// returns the checkout to the recorded commit with `git reset --keep`, which
// refuses rather than discards local edits, then reinstalls and rebuilds it.
// Migrations are never run down and the database is never restored here: the
// backup taken before the update is reported instead.
//
// Commands (run with plain node, no build step):
//   record-previous [--from-install-record]   remember the rollback point
//   cold-backup                               copy a stopped embedded database
//   trial-start --launcher windows|unix       start, check health, stop
//   trial-start -- <command> [args...]        same, with an explicit command
//   rollback                                  return to the rollback point
//   record-install                            refresh install.json after success
//   prune-cold-backups                        keep only the newest cold copies
// Every command accepts --repo <path> (defaults to this checkout).

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, readdirSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const BOM = "﻿";
export const DEFAULT_PORT = 3100;
export const DEFAULT_TRIAL_TIMEOUT_SECONDS = 120;
export const TRIAL_TIMEOUT_ENV = "PAPERCLIP_UPDATE_TRIAL_TIMEOUT_SECONDS";
const TAIL_LINES = 40;
const SHA_RE = /^[0-9a-f]{40}$/;

// --- paths -------------------------------------------------------------------

export function expandHome(value, homedir = os.homedir()) {
  if (value === "~") return homedir;
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(homedir, value.slice(2));
  return value;
}

// Mirrors server/src/home-paths.ts and scripts/launchers/unix/common.sh.
// The Windows tray reads launcher.json from %USERPROFILE%\.paperclip, which is
// the same place unless PAPERCLIP_HOME is set.
export function resolveGuardPaths(env = process.env, homedir = os.homedir()) {
  const home = path.resolve(expandHome(env.PAPERCLIP_HOME?.trim() || path.join(homedir, ".paperclip"), homedir));
  const instanceId = env.PAPERCLIP_INSTANCE_ID?.trim() || "default";
  const configPath = env.PAPERCLIP_CONFIG?.trim()
    ? path.resolve(expandHome(env.PAPERCLIP_CONFIG.trim(), homedir))
    : path.join(home, "instances", instanceId, "config.json");
  return {
    home,
    configPath,
    installRecord: path.join(home, "install.json"),
    launcherConfig: path.join(home, "launcher.json"),
    logsDir: path.join(home, "logs"),
  };
}

// --- install record (install.json) -----------------------------------------

// Windows PowerShell wrote install.json with a UTF-8 BOM, so tolerate one and
// keep it when writing back, the way every reader of the file already expects.
export function parseInstallRecord(raw) {
  const bom = raw.startsWith(BOM);
  const text = bom ? raw.slice(1) : raw;
  return { record: text.trim() ? JSON.parse(text) : {}, bom };
}

export function serializeInstallRecord(record, { bom = false } = {}) {
  return `${bom ? BOM : ""}${JSON.stringify(record, null, 2)}\n`;
}

export async function readInstallRecord(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { record: {}, bom: false, exists: false };
    throw error;
  }
  try {
    return { ...parseInstallRecord(raw), exists: true };
  } catch {
    console.warn(`install.json is not valid JSON and will be rewritten: ${file}`);
    return { record: {}, bom: raw.startsWith(BOM), exists: true };
  }
}

// Applies a patch and keeps every other field. A patch value of undefined
// removes that field.
export function applyInstallPatch(record, patch) {
  const next = { ...record };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
}

export async function updateInstallRecord(file, patch) {
  const { record, bom } = await readInstallRecord(file);
  const next = applyInstallPatch(record, patch);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, serializeInstallRecord(next, { bom }));
  return next;
}

// Also clears previousCommit. It is a rollback point for one update run only;
// left behind after a success, a later failed run could roll back past the
// version that was actually installed.
export function buildInstallPatch(existing, { repoPath, remote, branch, commit, now }) {
  const patch = { repoPath, branch, commit, installedAt: existing.installedAt || now, lastUpdated: now, previousCommit: undefined };
  if (remote !== null && remote !== undefined) patch.remote = remote;
  return patch;
}

// --- health target ------------------------------------------------------------

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

const BIND_MODES = ["loopback", "lan", "tailnet", "custom"];

function normalizeHost(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isLoopbackHost(host) {
  return ["127.0.0.1", "localhost", "::1"].includes(normalizeHost(host)?.toLowerCase());
}

function isAllInterfacesHost(host) {
  return ["0.0.0.0", "::"].includes(normalizeHost(host)?.toLowerCase());
}

// Mirrors detectTailnetBindHost in server/src/config.ts.
export function detectTailnetHost() {
  try {
    const stdout = execFileSync("tailscale", ["ip", "-4"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000, windowsHide: true });
    return stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  } catch {
    return undefined;
  }
}

// The address the server binds, mirroring server/src/config.ts and
// resolveRuntimeBind in packages/shared/src/network-bind.ts. Only a fallback:
// the trial reads the real address from the server's "Server listening on"
// line as soon as it is printed.
export function resolveListenHost({ env = {}, config = null, detectTailnet = detectTailnetHost } = {}) {
  const server = config?.server ?? {};
  const legacyHost = normalizeHost(env.HOST ?? server.host ?? "127.0.0.1");
  let tailnet = null;
  const tailnetHost = () => {
    if (tailnet === null) tailnet = normalizeHost(env.PAPERCLIP_TAILNET_BIND_HOST) ?? normalizeHost(detectTailnet()) ?? "";
    return tailnet || undefined;
  };
  const inferBind = () => {
    if (!legacyHost || isLoopbackHost(legacyHost)) return "loopback";
    if (isAllInterfacesHost(legacyHost)) return "lan";
    const detected = tailnetHost();
    return detected && legacyHost === detected ? "tailnet" : "custom";
  };
  const bind = (BIND_MODES.includes(env.PAPERCLIP_BIND) ? env.PAPERCLIP_BIND : null) ?? (BIND_MODES.includes(server.bind) ? server.bind : null) ?? inferBind();
  const customBindHost =
    normalizeHost(env.PAPERCLIP_BIND_HOST ?? server.customBindHost) ??
    (bind === "custom" && legacyHost && !isLoopbackHost(legacyHost) && !isAllInterfacesHost(legacyHost) ? legacyHost : undefined);
  switch (bind) {
    case "loopback":
      return "127.0.0.1";
    case "lan":
      return "0.0.0.0";
    case "custom":
      return customBindHost ?? legacyHost ?? "127.0.0.1";
    default:
      return tailnetHost() ?? legacyHost ?? "127.0.0.1";
  }
}

// An all-interfaces bind is reached on loopback, the way the server's own
// open-on-listen does it.
export function probeHost(listenHost) {
  return isAllInterfacesHost(listenHost) ? "127.0.0.1" : listenHost;
}

export function healthUrl(host, port) {
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}/api/health`;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

// Reads the address out of the server's "Server listening on <host>:<port>"
// log line (server/src/index.ts), which also reflects a port the server moved
// to because the requested one was busy. Returns null for any other line.
export function parseListenLine(line) {
  // Greedy: the port is after the LAST colon, as the server prints an IPv6
  // host without brackets.
  const match = /Server listening on ([^\s"]+):(\d+)(?!\d)/.exec(line.replace(ANSI_RE, ""));
  if (!match) return null;
  const port = validPort(match[2]);
  if (port === null) return null;
  const host = match[1].replace(/^\[(.*)\]$/, "$1");
  return { listenHost: host, host: probeHost(host), port, url: healthUrl(probeHost(host), port) };
}

// Where a freshly started server answers, before it has said so itself. The
// port follows the server's own order (PORT, then the instance config), then
// the tray's launcher.json, then 3100. The host mirrors the server's bind.
export function resolveHealthTarget({ env = {}, config = null, launcher = null, detectTailnet = detectTailnetHost } = {}) {
  const candidates = [
    ["the PORT environment variable", env.PORT],
    ["the instance config", config?.server?.port],
    ["launcher.json", launcher?.port],
  ];
  let port = DEFAULT_PORT;
  let source = "the default";
  for (const [name, value] of candidates) {
    const parsed = validPort(value);
    if (parsed !== null) {
      port = parsed;
      source = name;
      break;
    }
  }
  const listenHost = resolveListenHost({ env, config, detectTailnet });
  const host = probeHost(listenHost);
  return { listenHost, host, port, source, url: healthUrl(host, port) };
}

export function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

export function resolveTrialTimeoutMs(env = process.env) {
  const seconds = Number(env[TRIAL_TIMEOUT_ENV]);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_TRIAL_TIMEOUT_SECONDS) * 1000;
}

// --- health polling -------------------------------------------------------------

function describeFetchError(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "the request timed out";
  const code = error?.cause?.code ?? error?.code;
  if (code === "ECONNREFUSED") return "connection refused";
  return code ? `${code}` : String(error?.message ?? error);
}

// Polls until /api/health answers {"status":"ok"} or the timeout passes.
// fetch, clock and sleep are injectable so tests need no real server or time.
// shouldStop returns a reason string to give up early (the server exited).
// url may be a function, so the target can follow the address the server
// reports once it is listening.
export async function pollHealth({
  url,
  timeoutMs,
  intervalMs = 1000,
  requestTimeoutMs = 2000,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = (ms) => delay(ms),
  shouldStop = () => null,
}) {
  const started = now();
  const deadline = started + timeoutMs;
  const urlNow = typeof url === "function" ? url : () => url;
  let lastError = "no answer yet";
  let attempts = 0;
  for (;;) {
    const stopReason = shouldStop();
    if (stopReason) return { healthy: false, attempts, lastError, reason: stopReason };
    attempts += 1;
    try {
      const response = await fetchImpl(urlNow(), { signal: AbortSignal.timeout(requestTimeoutMs) });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (response.ok && body?.status === "ok") return { healthy: true, attempts, elapsedMs: now() - started };
      lastError = `HTTP ${response.status}${body?.status ? ` (${body.status}${body.error ? `: ${body.error}` : ""})` : ""}`;
    } catch (error) {
      lastError = describeFetchError(error);
    }
    if (now() >= deadline) {
      const stopLate = shouldStop();
      return {
        healthy: false,
        attempts,
        lastError,
        reason: stopLate || `no healthy answer from ${urlNow()} within ${Math.round(timeoutMs / 1000)} s (last result: ${lastError})`,
      };
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
}

// --- rollback decision ------------------------------------------------------------

// installedCommit is install.json's commit, which only a successful install,
// update or rebuild writes. A rollback point that is not that commit was left
// over from an earlier run, and rolling back to it could skip a release.
export function decideRollback({ previousCommit, currentCommit, installedCommit }) {
  if (!previousCommit) {
    return { ok: false, reason: "No previous commit is recorded in install.json, so there is nothing to roll back to." };
  }
  if (!SHA_RE.test(previousCommit)) {
    return { ok: false, reason: `The recorded previous commit is not a full commit id: ${previousCommit}` };
  }
  if (previousCommit === currentCommit) {
    return { ok: false, reason: `The recorded previous commit ${previousCommit} is the commit that just failed, so rolling back would change nothing.` };
  }
  if (typeof installedCommit === "string" && SHA_RE.test(installedCommit) && installedCommit !== previousCommit) {
    return {
      ok: false,
      reason: `The recorded previous commit ${previousCommit} is not the installed commit ${installedCommit} in install.json, so it may be left over from an earlier update and rolling back to it could skip a release.`,
    };
  }
  return { ok: true, target: previousCommit, resetArgs: ["reset", "--keep", previousCommit] };
}

// The install command each platform's update already uses.
export function installArgs(platform = process.platform) {
  return platform === "win32" ? ["install"] : ["install", "--no-frozen-lockfile"];
}

// --- trial command ------------------------------------------------------------------

// The trial server is stopped seconds after it answers, so it must not start
// work it would then abandon. HEARTBEAT_SCHEDULER_ENABLED=false skips startup
// run recovery (reap, resume queued runs, re-dispatch assigned issues) and the
// heartbeat, routine and calendar ticks (server/src/index.ts).
// PAPERCLIP_PLUGIN_RUNTIME_ENABLED=false skips loading plugin workers and the
// plugin job scheduler (server/src/app.ts): a plugin job overdue from the
// update's downtime would otherwise fire on the first tick, plugins can wake
// agents, and a chat plugin such as Slack would answer messages.
export const TRIAL_ENV = Object.freeze({
  HEARTBEAT_SCHEDULER_ENABLED: "false",
  PAPERCLIP_PLUGIN_RUNTIME_ENABLED: "false",
});

// Exactly how each launcher starts the server. Windows: the tray
// (tools/paperclip-launcher/src/main.rs, spawn_server), started from its own
// folder. Unix: `service start` in common.sh, from the checkout root.
export function trialCommand(launcher, { repo, env = process.env, platform = process.platform } = {}) {
  if (launcher === "windows") {
    const childEnv = { ...env, ...TRIAL_ENV };
    const generationFile = path.join(repo, "ui", "node_modules", ".paperclip-vite-generation");
    const generation = existsSync(generationFile) ? readFileSync(generationFile, "utf8").trim() : "";
    if (generation) childEnv.PAPERCLIP_UI_CACHE_GENERATION = generation;
    return {
      command: "cmd",
      args: ["/c", "pnpm", "--dir", repo, "--filter", "paperclipai", "exec", "tsx", "src/index.ts", "run"],
      cwd: path.join(repo, "scripts", "launchers", "windows"),
      env: childEnv,
    };
  }
  if (launcher === "unix") {
    // A run started from the Settings UI writes to the maintenance log; the
    // relaunch drops that variable before starting, so the trial does too.
    const { PAPERCLIP_MAINTENANCE_LOG: _drop, ...childEnv } = env;
    return {
      command: "pnpm",
      args: ["--dir", repo, "--filter", "@paperclipai/server", "exec", "tsx", "../scripts/installed-service.ts", "start"],
      cwd: repo,
      env: { ...childEnv, ...TRIAL_ENV },
    };
  }
  throw new Error(`Unknown launcher '${launcher}' on ${platform}. Use windows or unix.`);
}

// --- database backup location ----------------------------------------------------

// Mirrors database_paths in common.sh. Returns null for an external server.
export function resolveDatabasePaths(config, configPath, homedir = os.homedir()) {
  const db = config?.database ?? {};
  if (db.mode && db.mode !== "embedded-postgres") return null;
  const instance = path.dirname(configPath);
  const dataDir = db.embeddedPostgresDataDir ? path.resolve(expandHome(db.embeddedPostgresDataDir, homedir)) : path.join(instance, "db");
  const backupDir = db.backup?.dir ? path.resolve(expandHome(db.backup.dir, homedir)) : path.join(instance, "data", "backups");
  return { dataDir, backupDir };
}

export function describeBackup(config, configPath, homedir = os.homedir()) {
  if (!config) return "Migrations were not undone. No instance config was found, so no database backup location is known.";
  const paths = resolveDatabasePaths(config, configPath, homedir);
  if (!paths) {
    return "This instance uses an external PostgreSQL server. Migrations were not undone; restore that server from your own backups if the previous version needs the old schema.";
  }
  return `Migrations were not undone. The database backup taken before this update is in ${paths.backupDir} (the newest file or cold-* folder there). Restore it only if the previous version misbehaves against the migrated database.`;
}

// --- process helpers ---------------------------------------------------------------

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitOrNull(repo, ...args) {
  try {
    return git(repo, ...args);
  } catch {
    return null;
  }
}

function gitSucceeds(repo, ...args) {
  return spawnSync("git", ["-C", repo, ...args], { stdio: "ignore" }).status === 0;
}

// pnpm on Windows is a .cmd shim, which needs a shell. Arguments here are
// fixed words; the checkout is passed as the working directory, never quoted.
function runPnpm(repo, args) {
  console.log(`> pnpm ${args.join(" ")}`);
  const result = spawnSync("pnpm", args, { cwd: repo, stdio: "inherit", shell: process.platform === "win32" });
  return result.status === 0;
}

export function isPortInUse(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (inUse) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function waitForPortFree(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortInUse(host, port))) return true;
    await delay(500);
  }
  return !(await isPortInUse(host, port));
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

// True while any process in the group is still running. A killed member that
// nobody has reaped yet (a container without an init process) still answers
// kill 0, so on Linux the group's members are read from /proc and zombies
// are not counted.
export function processGroupAlive(pgid, platform = process.platform) {
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    return error.code === "EPERM";
  }
  if (platform !== "linux") return true;
  let entries;
  try {
    entries = readdirSync("/proc");
  } catch {
    return true;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    let stat;
    try {
      stat = readFileSync(`/proc/${name}/stat`, "utf8");
    } catch {
      continue;
    }
    // pid (comm) state ppid pgrp ...; comm can contain spaces and brackets.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (Number(fields[2]) === pgid && fields[0] !== "Z") return true;
  }
  return false;
}

async function waitForGroupGone(pgid, timeoutMs, platform) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupAlive(pgid, platform)) return true;
    await delay(200);
  }
  return !processGroupAlive(pgid, platform);
}

// Stops the trial server and everything it started. Windows: taskkill /T /F on
// the trial's own pid only (never by image name), and only while that pid is
// still ours, because Windows reuses pids. Unix: the trial runs in its own
// process group. installed-service.ts starts the server DETACHED, in a group
// of its own that this cannot signal, and stops it on SIGTERM. So SIGTERM goes
// to the trial's group and this waits for the WHOLE group to empty, not just
// its first process: pnpm can exit at once, while installed-service.ts stays
// until its server has stopped, including the force kill it falls back to.
// Killing it sooner would leave a server that ignores SIGTERM running. Only a
// group still there after 30 s is killed outright.
export async function stopProcessTree(child, platform = process.platform, { groupTimeoutMs = 30_000 } = {}) {
  if (platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    await waitForExit(child, 15_000);
    return;
  }
  // The first process can be gone while the rest of its group is not.
  if (!processGroupAlive(child.pid, platform)) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  if (!(await waitForGroupGone(child.pid, groupTimeoutMs, platform))) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group is already gone.
    }
    await waitForGroupGone(child.pid, 5000, platform);
  }
  await waitForExit(child, 5000);
}

// On Windows the embedded PostgreSQL detaches from the server's process tree:
// taskkill /T took the postmaster in testing, but one of its workers survived
// with its parent gone and kept the database port bound (stop-paperclip.ps1
// sweeps the same orphans). Select the postgres processes this trial started:
// binaries from this checkout's node_modules, created after the trial began.
// Nothing else runs from this checkout during an update, and the creation
// time keeps older processes and reused pids out.
export function selectTrialPostgres(processes, { repo, startedAt }) {
  const needle = path.join(repo, "node_modules").replaceAll("\\", "/").toLowerCase();
  return processes.filter((proc) => {
    if (!/^postgres/i.test(proc.name ?? "")) return false;
    const text = `${proc.commandLine ?? ""} ${proc.executablePath ?? ""}`.replaceAll("\\", "/").toLowerCase();
    if (!text.includes(needle)) return false;
    const created = Date.parse(proc.created ?? "");
    return Number.isFinite(created) && created >= startedAt - 1000;
  });
}

function listWindowsPostgres() {
  const script = "Get-CimInstance Win32_Process -Filter \"Name like 'postgres%'\" | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; name = $_.Name; commandLine = $_.CommandLine; executablePath = $_.ExecutablePath; created = $_.CreationDate.ToUniversalTime().ToString('o') } } | ConvertTo-Json -Compress";
  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
  const text = (result.stdout ?? "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

async function sweepTrialPostgres({ repo, startedAt, log }) {
  for (let pass = 0; pass < 2; pass += 1) {
    await delay(750);
    for (const proc of selectTrialPostgres(listWindowsPostgres(), { repo, startedAt })) {
      log(`[update-guard] stopping trial database process ${proc.pid} (${proc.name})\n`);
      spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    }
  }
}

function timestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

// --- trial start ---------------------------------------------------------------------

// Starts the server, waits for health, stops it. Returns
// { status: "passed" | "failed" | "skipped", reason, tail, logFile, url }.
// target is where the server should answer; once the server prints its
// "Server listening on" line, the address in that line is used instead.
export async function runTrial({ command, args, cwd, env, target, timeoutMs, logFile, platform = process.platform, intervalMs = 1000, repo = null }) {
  if (await isPortInUse(target.host, target.port)) {
    return {
      status: "skipped",
      url: target.url,
      reason: `Port ${target.port} is already in use, so a trial server would land on another port and cannot be checked. The trial was skipped.`,
      tail: [],
    };
  }
  await mkdir(path.dirname(logFile), { recursive: true });
  const log = createWriteStream(logFile, { flags: "a" });
  log.write(`=== update trial start ${new Date().toISOString()} ===\n> ${command} ${args.join(" ")}\n`);
  const tail = [];
  let listening = null;
  // stdout and stderr arrive separately, so each keeps its own partial line.
  const collector = () => {
    let partial = "";
    const take = (line) => {
      tail.push(line);
      if (tail.length > TAIL_LINES) tail.shift();
      if (!listening) {
        listening = parseListenLine(line);
        if (listening) log.write(`[update-guard] the server reports it is listening; checking ${listening.url}\n`);
      }
    };
    return {
      data(chunk) {
        log.write(chunk);
        const lines = (partial + chunk.toString("utf8")).split(/\r?\n/);
        partial = lines.pop() ?? "";
        for (const line of lines) take(line);
      },
      flush() {
        if (partial) take(partial);
        partial = "";
      },
    };
  };
  const out = collector();
  const err = collector();
  const current = () => listening ?? target;

  const startedAt = Date.now();
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: platform !== "win32",
    windowsHide: true,
  });
  child.stdout.on("data", out.data);
  child.stderr.on("data", err.data);
  let exitReason = null;
  child.once("exit", (code, signal) => {
    exitReason = `the server exited before it became healthy (${signal ? `signal ${signal}` : `exit code ${code}`})`;
  });
  child.once("error", (error) => {
    exitReason = `the server could not be started: ${error.message}`;
  });

  let result;
  try {
    result = await pollHealth({ url: () => current().url, timeoutMs, intervalMs, shouldStop: () => exitReason });
  } finally {
    await stopProcessTree(child, platform);
    if (platform === "win32" && repo) await sweepTrialPostgres({ repo, startedAt, log: (text) => log.write(text) });
    const { host, port } = current();
    const free = await waitForPortFree(host, port, 20_000);
    if (!free) log.write(`\n[update-guard] port ${port} was still in use after stopping the trial\n`);
    out.flush();
    err.flush();
    await new Promise((resolve) => log.end(resolve));
  }
  const url = current().url;
  if (result.healthy) {
    return { status: "passed", url, elapsedMs: result.elapsedMs, tail, logFile };
  }
  return { status: "failed", url, reason: result.reason, tail, logFile };
}

// --- cold backup ----------------------------------------------------------------------

function postmasterRunning(dataDir) {
  const pidFile = path.join(dataDir, "postmaster.pid");
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, "utf8").split(/\r?\n/)[0]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
  } catch {
    return null;
  }
  if (process.platform === "win32") {
    // A stale pid file can name a pid Windows has since given to something
    // else. Only a postgres process counts as a running database.
    const listing = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
    if (!/postgres/i.test(listing.stdout ?? "")) return null;
  }
  return pid;
}

// Copies the embedded database directory while PostgreSQL is stopped. Used on
// Windows, where the update stops the server before anything else, so a live
// backup (which connects through the running server) cannot run.
export async function coldBackup({ config, configPath, now = new Date() }) {
  if (!config) return { status: "skipped", message: "No instance config yet, so there is no database to back up." };
  const paths = resolveDatabasePaths(config, configPath);
  if (!paths) {
    return { status: "skipped", message: "This instance uses an external PostgreSQL server. This update does not back it up; back it up yourself if you need to." };
  }
  if (!existsSync(paths.dataDir)) {
    return { status: "skipped", message: `No database directory at ${paths.dataDir}, so there is nothing to back up.` };
  }
  const pid = postmasterRunning(paths.dataDir);
  if (pid) {
    return { status: "refused", message: `PostgreSQL is still running (pid ${pid}), so its files cannot be copied safely. Stop Paperclip fully and run the update again.` };
  }
  const dest = path.join(paths.backupDir, `cold-${timestamp(now)}`);
  await mkdir(dest, { recursive: true });
  await cp(paths.dataDir, path.join(dest, "db"), {
    recursive: true,
    filter: (source) => path.basename(source) !== "postmaster.pid",
  });
  return { status: "saved", dest, message: `Cold backup saved: ${dest}` };
}

export const COLD_BACKUPS_KEPT = 2;
const COLD_BACKUP_RE = /^cold-\d{8}T\d{6}Z$/;

// A cold copy is the whole database directory, so they add up quickly. Keeps
// the newest `keep` cold-<timestamp> folders in the backup directory and
// removes the rest. Nothing else there is touched: only folders whose name is
// exactly that pattern, which also sorts them oldest first.
export async function pruneColdBackups({ backupDir, keep = COLD_BACKUPS_KEPT }) {
  let entries;
  try {
    entries = await readdir(backupDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return { removed: [], kept: [] };
    throw error;
  }
  const cold = entries.filter((entry) => entry.isDirectory() && COLD_BACKUP_RE.test(entry.name)).map((entry) => entry.name).sort();
  const removeCount = Math.max(0, cold.length - keep);
  const removed = [];
  for (const name of cold.slice(0, removeCount)) {
    const dir = path.join(backupDir, name);
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    removed.push(dir);
  }
  return { removed, kept: cold.slice(removeCount).map((name) => path.join(backupDir, name)) };
}

// --- CLI ----------------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { command: argv[0], repo: null, launcher: null, fromInstallRecord: false, explicit: null };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      options.explicit = argv.slice(index + 1);
      break;
    }
    if (arg === "--repo") options.repo = argv[++index];
    else if (arg === "--launcher") options.launcher = argv[++index];
    else if (arg === "--from-install-record") options.fromInstallRecord = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

const defaultRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function cmdRecordPrevious(repo, paths, fromInstallRecord) {
  const head = git(repo, "rev-parse", "HEAD");
  let previous = head;
  let why = "";
  if (fromInstallRecord) {
    // Windows records this after git pull, because cmd re-reads the running
    // .bat by position and the lines before the pull must not move. The
    // installed commit is the last one an update or install finished.
    const { record } = await readInstallRecord(paths.installRecord);
    previous = typeof record.commit === "string" ? record.commit.trim() : "";
    // Where HEAD was before its last move, which for an update is the commit
    // the pull started from. An install.json that a failed write left behind
    // names an older commit than that, and rolling back to it would skip the
    // release that was actually running.
    const beforeLastMove = gitOrNull(repo, "rev-parse", "--verify", "--quiet", "HEAD@{1}");
    if (!SHA_RE.test(previous)) {
      why = "install.json has no installed commit";
      previous = "";
    } else if (!gitSucceeds(repo, "cat-file", "-e", `${previous}^{commit}`)) {
      why = `the installed commit ${previous} is not in this checkout`;
      previous = "";
    } else if (!gitSucceeds(repo, "merge-base", "--is-ancestor", previous, head)) {
      why = `the installed commit ${previous} is not an ancestor of the updated checkout`;
      previous = "";
    } else if (previous !== head && previous !== beforeLastMove) {
      why = `the installed commit ${previous} in install.json is not the commit this checkout was updated from (${beforeLastMove ?? "unknown"}), so install.json may be out of date`;
      previous = "";
    }
  }
  await updateInstallRecord(paths.installRecord, { previousCommit: previous || undefined });
  if (previous) console.log(`Rollback point: ${previous}`);
  else console.log(`No rollback point recorded (${why}). If the new version fails its trial start, the update can only report it.`);
  return 0;
}

async function cmdTrialStart(repo, paths, launcher, explicit) {
  let spec;
  if (explicit?.length) spec = { command: explicit[0], args: explicit.slice(1), cwd: repo, env: { ...process.env, ...TRIAL_ENV } };
  else spec = trialCommand(launcher, { repo });
  const target = resolveHealthTarget({ env: process.env, config: readJsonFile(paths.configPath), launcher: readJsonFile(paths.launcherConfig) });
  const timeoutMs = resolveTrialTimeoutMs();
  const logFile = path.join(paths.logsDir, `update-trial-${timestamp()}.log`);
  console.log(`Trial start: waiting up to ${Math.round(timeoutMs / 1000)} s for ${target.url} (port from ${target.source}), or for the address the server reports.`);
  const result = await runTrial({ ...spec, target, timeoutMs, logFile, repo });
  if (result.status === "passed") {
    console.log(`Trial start passed: healthy at ${result.url} after ${Math.round(result.elapsedMs / 1000)} s. The trial server has been stopped.`);
    return 0;
  }
  if (result.status === "skipped") {
    console.warn(`[!] ${result.reason}`);
    return 0;
  }
  console.error(`[!] Trial start failed: ${result.reason}.`);
  console.error(`    Last lines of the server output (full output in ${result.logFile}):`);
  for (const line of result.tail) console.error(`      ${line}`);
  return 1;
}

async function cmdRollback(repo, paths) {
  const config = readJsonFile(paths.configPath);
  const backupNote = describeBackup(config, paths.configPath);
  const { record } = await readInstallRecord(paths.installRecord);
  const current = git(repo, "rev-parse", "HEAD");
  const decision = decideRollback({ previousCommit: record.previousCommit, currentCommit: current, installedCommit: record.commit });
  if (!decision.ok) {
    console.error(`[!] Cannot roll back automatically: ${decision.reason}`);
    console.error(`    ${backupNote}`);
    return 2;
  }
  // A lockfile rewritten by pnpm install is generated state (doc/DEVELOPING.md),
  // the same thing the Unix update discards before it starts. Anything else
  // that is edited makes reset --keep refuse, which is the point.
  if (gitOrNull(repo, "status", "--porcelain", "--", "pnpm-lock.yaml")) git(repo, "checkout", "--", "pnpm-lock.yaml");
  const lockfileChanged = !gitSucceeds(repo, "diff", "--quiet", decision.target, current, "--", "pnpm-lock.yaml");
  console.log(`Rolling back from ${current} to ${decision.target} with git ${decision.resetArgs.join(" ")}`);
  const reset = spawnSync("git", ["-C", repo, ...decision.resetArgs], { stdio: "inherit" });
  if (reset.status !== 0) {
    console.error("[!] git reset --keep refused or failed, so the checkout was left as it was. Local edits are never discarded.");
    console.error(`    ${backupNote}`);
    return 1;
  }
  if (lockfileChanged && !runPnpm(repo, installArgs())) {
    console.error("[!] Reinstalling the previous version's dependencies failed.");
    return 1;
  }
  if (!runPnpm(repo, ["build:runtime"])) {
    console.error("[!] Rebuilding the previous version failed.");
    return 1;
  }
  console.log(`Rolled back to ${decision.target}.`);
  console.log(backupNote);
  return 0;
}

async function cmdColdBackup(paths) {
  const result = await coldBackup({ config: readJsonFile(paths.configPath), configPath: paths.configPath });
  (result.status === "refused" ? console.error : console.log)(result.message);
  return result.status === "refused" ? 1 : 0;
}

async function cmdRecordInstall(repo, paths) {
  const { record } = await readInstallRecord(paths.installRecord);
  const patch = buildInstallPatch(record, {
    repoPath: repo,
    remote: gitOrNull(repo, "remote", "get-url", "origin"),
    branch: gitOrNull(repo, "branch", "--show-current") ?? "",
    commit: git(repo, "rev-parse", "HEAD"),
    now: new Date().toISOString(),
  });
  await updateInstallRecord(paths.installRecord, patch);
  console.log(`Install record updated: ${paths.installRecord}`);
  return 0;
}

async function cmdPruneColdBackups(paths) {
  const config = readJsonFile(paths.configPath);
  const dbPaths = config ? resolveDatabasePaths(config, paths.configPath) : null;
  if (!dbPaths) return 0;
  const { removed } = await pruneColdBackups({ backupDir: dbPaths.backupDir });
  for (const dir of removed) console.log(`Removed old cold backup: ${dir}`);
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const repo = path.resolve(options.repo ?? defaultRepo);
  const paths = resolveGuardPaths();
  switch (options.command) {
    case "record-previous":
      return cmdRecordPrevious(repo, paths, options.fromInstallRecord);
    case "trial-start":
      if (!options.explicit?.length && !options.launcher) throw new Error("trial-start needs --launcher windows|unix or -- <command>");
      return cmdTrialStart(repo, paths, options.launcher, options.explicit);
    case "rollback":
      return cmdRollback(repo, paths);
    case "cold-backup":
      return cmdColdBackup(paths);
    case "record-install":
      return cmdRecordInstall(repo, paths);
    case "prune-cold-backups":
      return cmdPruneColdBackups(paths);
    default:
      throw new Error(`Unknown command '${options.command ?? ""}'. Use record-previous, cold-backup, trial-start, rollback, record-install or prune-cold-backups.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`[!] update-guard: ${error.message}`);
    process.exitCode = 1;
  }
}
