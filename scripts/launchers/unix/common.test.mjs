import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const common = path.join(path.dirname(fileURLToPath(import.meta.url)), "common.sh");
const skip = process.platform === "win32";

async function checkout() {
  const repo = await mkdtemp(path.join(os.tmpdir(), "paperclip-lockfile-"));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "--quiet");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  await writeFile(path.join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(path.join(repo, "package.json"), "{}\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "init");
  return { repo, git };
}

// common.sh changes directory to its own checkout, so move into the scratch
// repository after sourcing it and before calling the helper under test.
const discard = (repo) =>
  execFileSync("bash", ["-c", 'source "$1" && cd "$2" && discard_generated_lockfile', "bash", common, repo]);

test("a lockfile rewritten by install is restored so the checkout is clean", { skip }, async () => {
  const { repo, git } = await checkout();
  await writeFile(path.join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nrewritten: true\n");
  assert.notEqual(git("status", "--porcelain"), "");
  discard(repo);
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(await readFile(path.join(repo, "pnpm-lock.yaml"), "utf8"), "lockfileVersion: '9.0'\n");
});

test("real local changes are left alone and still make the checkout dirty", { skip }, async () => {
  const { repo, git } = await checkout();
  await writeFile(path.join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nrewritten: true\n");
  await writeFile(path.join(repo, "package.json"), '{"edited":true}\n');
  discard(repo);
  assert.equal(git("status", "--porcelain").trim(), "M package.json");
  assert.equal(await readFile(path.join(repo, "package.json"), "utf8"), '{"edited":true}\n');
});

test("a clean checkout is untouched", { skip }, async () => {
  const { repo, git } = await checkout();
  discard(repo);
  assert.equal(git("status", "--porcelain"), "");
});

// --- database backup around a stop -------------------------------------------

async function instance({ mode = "embedded-postgres", withDb = true } = {}) {
  const { mkdir, chmod } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-backup-"));
  const dataDir = path.join(root, "db");
  const backupDir = path.join(root, "data", "backups");
  const config = path.join(root, "config.json");
  await writeFile(config, JSON.stringify({ database: { mode, embeddedPostgresDataDir: dataDir, backup: { dir: backupDir } } }));
  if (withDb) {
    await mkdir(path.join(dataDir, "base"), { recursive: true });
    await writeFile(path.join(dataDir, "PG_VERSION"), "18\n");
    await writeFile(path.join(dataDir, "base", "1"), "rows\n");
  }
  // A stand-in for pnpm so the live backup can be made to pass or fail.
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  const stub = path.join(bin, "pnpm");
  await writeFile(stub, '#!/usr/bin/env bash\necho "pnpm $*" >> "$STUB_LOG"\nexit "${STUB_EXIT:-0}"\n');
  await chmod(stub, 0o755);
  return { root, dataDir, backupDir, config, bin, log: path.join(root, "pnpm.log") };
}

function run(script, inst, extraEnv = {}) {
  try {
    const stdout = execFileSync("bash", ["-c", `source "$1" && ${script}`, "bash", common], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: `${inst.bin}:${process.env.PATH}`, PAPERCLIP_CONFIG: inst.config, STUB_LOG: inst.log, ...extraEnv },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return { code: error.status, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
}

test("a live backup that succeeds needs no cold copy", { skip }, async () => {
  const inst = await instance();
  const result = run('backup_existing && cold_backup_if_needed && echo "flag=$PAPERCLIP_COLD_BACKUP"', inst);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /flag=0/);
  assert.match(await readFile(inst.log, "utf8"), /paperclipai db:backup --config/);
  const { access } = await import("node:fs/promises");
  await assert.rejects(access(inst.backupDir), "no cold copy directory should be created");
});

test("a failed live backup does not abort the run and falls back to a cold copy", { skip }, async () => {
  const { readdir } = await import("node:fs/promises");
  const inst = await instance();
  await writeFile(path.join(inst.dataDir, "postmaster.pid"), "999999999\n");
  const result = run("backup_existing && cold_backup_if_needed", inst, { STUB_EXIT: "1" });
  assert.equal(result.code, 0, result.stderr);
  const [cold] = await readdir(inst.backupDir);
  assert.match(cold, /^cold-\d{8}T\d{6}Z$/);
  const copy = path.join(inst.backupDir, cold, "db");
  assert.equal(await readFile(path.join(copy, "base", "1"), "utf8"), "rows\n");
  assert.equal(await readFile(path.join(copy, "PG_VERSION"), "utf8"), "18\n");
  await assert.rejects(readFile(path.join(copy, "postmaster.pid")), "the stale pid file must not be carried into the copy");
});

test("a cold copy is refused while PostgreSQL is still running", { skip }, async () => {
  const inst = await instance();
  await writeFile(path.join(inst.dataDir, "postmaster.pid"), `${process.pid}\n`);
  const result = run("backup_existing && cold_backup_if_needed", inst, { STUB_EXIT: "1" });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /PostgreSQL is still running/);
});

test("a failed backup with nothing to copy stops the run", { skip }, async () => {
  const missing = await instance({ withDb: false });
  const first = run("backup_existing && cold_backup_if_needed", missing, { STUB_EXIT: "1" });
  assert.notEqual(first.code, 0);
  assert.match(first.stderr, /no database directory was found/);

  const external = await instance({ mode: "postgres" });
  const second = run("backup_existing && cold_backup_if_needed", external, { STUB_EXIT: "1" });
  assert.notEqual(second.code, 0);
  assert.match(second.stderr, /external PostgreSQL server/);
});

test("a first install with no config skips the backup entirely", { skip }, async () => {
  const inst = await instance();
  const result = run("backup_existing && cold_backup_if_needed && echo done", inst, { PAPERCLIP_CONFIG: path.join(inst.root, "absent.json"), STUB_EXIT: "1" });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /done/);
});

test("every script backs up before it stops the server", { skip }, async () => {
  for (const name of ["install", "rebuild", "update"]) {
    const source = await readFile(path.join(path.dirname(common), `${name}-paperclip.sh`), "utf8");
    const backup = source.indexOf("\nbackup_existing\n");
    const stop = source.indexOf("\nservice stop\n");
    const cold = source.indexOf("\ncold_backup_if_needed\n");
    assert.ok(backup !== -1 && stop !== -1 && cold !== -1, `${name}: all three steps present`);
    assert.ok(backup < stop && stop < cold, `${name}: backup, then stop, then cold copy`);
  }
});
