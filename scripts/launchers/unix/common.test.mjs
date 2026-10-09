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

// --- runs started from the Settings UI -----------------------------------------
// The UI passes PAPERCLIP_MAINTENANCE_LOG: the run's output goes there, and it
// is how the helpers know nobody is watching a terminal.

async function stubMac(inst, { system = "Darwin", openExit = 0, fromUi = true } = {}) {
  const { chmod } = await import("node:fs/promises");
  const stubs = {
    uname: `echo ${system}`,
    open: `echo "open $*" >> "$STUB_LOG"; exit ${openExit}`,
    osascript: `printf 'osascript' >> "$STUB_LOG"; printf ' [%s]' "$@" >> "$STUB_LOG"; echo >> "$STUB_LOG"`,
    "failing-step": "exit 2",
    cargo: "exit 0",
    cc: "exit 0",
  };
  for (const [name, body] of Object.entries(stubs)) {
    const stub = path.join(inst.bin, name);
    await writeFile(stub, `#!/usr/bin/env bash\n${body}\n`);
    await chmod(stub, 0o755);
  }
  // Keep every write inside the scratch directory, never the real ~/.paperclip.
  const env = { PAPERCLIP_HOME: path.join(inst.root, "home with 'quote'") };
  if (fromUi) env.PAPERCLIP_MAINTENANCE_LOG = path.join(inst.root, "logs", "maintenance.log");
  return env;
}

const readLog = (inst) => readFile(inst.log, "utf8").catch(() => "");
const alerts = async (inst) => (await readLog(inst)).split("\n").filter((line) => line.startsWith("osascript"));

test("the run's output goes to the log the UI named", { skip }, async () => {
  const inst = await instance();
  const env = await stubMac(inst);
  const result = run("echo hello-from-the-run", inst, env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(await readFile(env.PAPERCLIP_MAINTENANCE_LOG, "utf8"), /hello-from-the-run/);
});

test("on macOS the server reopens in Terminal with the old server's environment", { skip }, async () => {
  const { readdir, stat } = await import("node:fs/promises");
  const inst = await instance();
  const env = await stubMac(inst);
  const result = run("start_after_maintenance", inst, { ...env, SOME_TOKEN: "tok'en $x", TERM_SESSION_ID: "old-window" });
  assert.equal(result.code, 0, result.stderr);
  const log = await readLog(inst);
  assert.doesNotMatch(log, /installed-service\.ts start/);
  const script = log.match(/^open -a Terminal (.*)$/m)?.[1];
  assert.ok(script, log);
  // It can hold secrets, so only the owner may read it.
  assert.equal((await stat(script)).mode & 0o777, 0o700);
  const text = await readFile(script, "utf8");
  assert.doesNotMatch(text, /TERM_SESSION_ID|PAPERCLIP_MAINTENANCE_LOG/);
  assert.match(text, /exec \/bin\/bash .*scripts\/launchers\/unix\/launch-paperclip\.sh\n$/);
  // Run it with exec replaced, to see what the new window would start with.
  const seen = execFileSync("bash", ["-c", 'exec() { printf "%s\\n" "$PAPERCLIP_HOME" "$PAPERCLIP_CONFIG" "$SOME_TOKEN" "${PAPERCLIP_MAINTENANCE_LOG-unset}"; }; source "$1"', "bash", script], { encoding: "utf8" });
  assert.equal(seen, `${env.PAPERCLIP_HOME}\n${inst.config}\ntok'en $x\nunset\n`);
  // And it deletes itself, with its copy of the environment, as it starts.
  assert.deepEqual(await readdir(path.join(env.PAPERCLIP_HOME, "launchers")), []);
});

test("a macOS run in a terminal starts the server in place", { skip }, async () => {
  const inst = await instance();
  const env = await stubMac(inst, { fromUi: false });
  const result = run("start_after_maintenance", inst, env);
  assert.equal(result.code, 0, result.stderr);
  const log = await readLog(inst);
  assert.match(log, /installed-service\.ts start/);
  assert.doesNotMatch(log, /open -a Terminal/);
});

test("if Terminal cannot be opened the server still starts", { skip }, async () => {
  const inst = await instance();
  const env = await stubMac(inst, { openExit: 1 });
  const result = run("start_after_maintenance", inst, env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(await readLog(inst), /installed-service\.ts start/);
});

test("Linux starts the server in place", { skip }, async () => {
  const inst = await instance();
  const env = await stubMac(inst, { system: "Linux" });
  const result = run("start_after_maintenance", inst, env);
  assert.equal(result.code, 0, result.stderr);
  const log = await readLog(inst);
  assert.match(log, /installed-service\.ts start/);
  assert.doesNotMatch(log, /open -a Terminal/);
});

test("a failure before stopping says Paperclip is still running, and why", { skip }, async () => {
  const inst = await instance();
  const env = await stubMac(inst);
  const result = run("watch_unattended_run update; fail 'Automatic updates require the master branch.'", inst, env);
  assert.equal(result.code, 1);
  const [alert] = await alerts(inst);
  assert.match(alert, /\[Paperclip update failed\]/);
  assert.match(alert, /Automatic updates require the master branch\. Paperclip is still running/);
  assert.ok(alert.includes(env.PAPERCLIP_MAINTENANCE_LOG), alert);
});

test("a failure after stopping names the step and how to recover", { skip }, async () => {
  const inst = await instance();
  const env = await stubMac(inst);
  const result = run("watch_unattended_run rebuild; service stop; failing-step --now", inst, env);
  assert.equal(result.code, 2);
  const [alert] = await alerts(inst);
  assert.match(alert, /\[Paperclip rebuild failed\]/);
  assert.match(alert, /This step failed: failing-step --now\. Paperclip is stopped\. Fix the problem, then run rebuild-paperclip\.command/);
});

test("a failed restart points at the app, because the old server has already exited", { skip }, async () => {
  const inst = await instance();
  const env = await stubMac(inst);
  const result = run("watch_unattended_run restart; false", inst, env);
  assert.equal(result.code, 1);
  assert.match((await alerts(inst))[0] ?? "", /Open the Paperclip app to start it again/);
});

test("no alert for a run that succeeds, on Linux, or in a terminal", { skip }, async () => {
  for (const [options, script] of [
    [{}, "watch_unattended_run update; true"],
    [{ system: "Linux" }, "watch_unattended_run update; false"],
    [{ fromUi: false }, "watch_unattended_run update; false"],
  ]) {
    const inst = await instance();
    run(script, inst, await stubMac(inst, options));
    assert.deepEqual(await alerts(inst), [], JSON.stringify(options));
  }
});

test("a server started in place that exits later is not reported as a failed run", { skip }, async () => {
  const inst = await instance();
  const env = await stubMac(inst, { openExit: 1 });
  // The fallback start, whose server later exits with an error.
  const result = run("watch_unattended_run update; start_after_maintenance", inst, { ...env, STUB_EXIT: "1" });
  assert.equal(result.code, 1);
  assert.deepEqual(await alerts(inst), []);
});

test("rebuild --check stops nothing and arms no alert", { skip }, async () => {
  const inst = await instance();
  const env = await stubMac(inst);
  delete env.PAPERCLIP_MAINTENANCE_LOG;
  const script = path.join(path.dirname(common), "rebuild-paperclip.sh");
  execFileSync("bash", [script, "--check"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env, PATH: `${inst.bin}:${process.env.PATH}`, PAPERCLIP_CONFIG: inst.config, STUB_LOG: inst.log },
  });
  assert.equal(await readLog(inst), "");
});

test("update, rebuild, and restart arm the alert first and relaunch through the helper", { skip }, async () => {
  for (const name of ["restart", "update", "rebuild"]) {
    const source = await readFile(path.join(path.dirname(common), `${name}-paperclip.sh`), "utf8");
    const lines = source.trimEnd().split("\n").filter((line) => !line.startsWith("#"));
    const arm = name === "restart" ? "watch_unattended_run restart" : `[ "\${1:-}" = --check ] || watch_unattended_run ${name}`;
    assert.equal(lines[1], arm, `${name}: alert armed before anything can fail`);
    assert.equal(lines.at(-1), "start_after_maintenance", `${name}: relaunch goes through the helper`);
    assert.ok(!source.includes("\nservice start\n"), `${name}: no direct start left`);
    if (name !== "restart") {
      const check = source.indexOf('\n[ "${1:-}" != --check ] || exit 0\n');
      assert.ok(check !== -1 && check < source.indexOf("\nbackup_existing\n"), `${name}: --check ends before anything changes`);
    }
  }
});

// --- safe update: trial start and rollback --------------------------------------
// update-guard.mjs has its own tests; here a stand-in node records which
// command the shell flow ran and answers with the exit code under test.

async function stubGuard(inst) {
  const { chmod } = await import("node:fs/promises");
  const stub = path.join(inst.bin, "node");
  await writeFile(stub, [
    "#!/usr/bin/env bash",
    'echo "node ${1##*/} ${*:2}" >> "$STUB_LOG"',
    'if [ "${1##*/}" = install-metadata.mjs ]; then exit "${STUB_INSTALL_EXIT:-0}"; fi',
    'case "$2" in',
    '  record-previous) exit "${STUB_RECORD_EXIT:-0}" ;;',
    '  trial-start) exit "${STUB_TRIAL_EXIT:-0}" ;;',
    '  rollback) exit "${STUB_ROLLBACK_EXIT:-0}" ;;',
    '  prune-cold-backups) exit "${STUB_PRUNE_EXIT:-0}" ;;',
    "esac",
    "",
  ].join("\n"));
  await chmod(stub, 0o755);
}

// A failure that restarts Paperclip shows its alert in the background, so it
// can land a moment after the run itself has returned.
async function waitForAlerts(inst, count = 1, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await alerts(inst);
    if (found.length >= count || Date.now() > deadline) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("update records the rollback point before the merge and runs the trial before recording the install", { skip }, async () => {
  const source = await readFile(path.join(path.dirname(common), "update-paperclip.sh"), "utf8");
  const at = (line) => source.indexOf(`\n${line}\n`);
  for (const line of ["record_previous_commit", "git merge --ff-only origin/master", "configure_database", "trial_start_or_roll_back", "record_update_install"]) {
    assert.ok(at(line) !== -1, `${line} present`);
  }
  assert.ok(at("cold_backup_if_needed") < at("record_previous_commit"), "backup first");
  assert.ok(at("record_previous_commit") < at("git merge --ff-only origin/master"), "rollback point before the checkout moves");
  assert.ok(at("configure_database") < at("trial_start_or_roll_back"), "trial after migrate");
  assert.ok(at("trial_start_or_roll_back") < at("record_update_install"), "trial before the install marker changes");
  assert.equal(at("record_install"), -1, "the update records its install through record_update_install");
});

test("if the rollback point cannot be recorded, the update stops and starts the unchanged version again", { skip }, async () => {
  const inst = await instance();
  const env = await stubMac(inst);
  await stubGuard(inst);
  const result = run("watch_unattended_run update; service stop; record_previous_commit; echo should-not-run", inst, { ...env, STUB_RECORD_EXIT: "1" });
  assert.equal(result.code, 1);
  const log = await readLog(inst);
  assert.match(log, /node update-guard\.mjs record-previous/);
  assert.match(log, /open -a Terminal/, "the version that was running starts again");
  const [alert, extra] = await waitForAlerts(inst);
  assert.equal(extra, undefined);
  assert.match(alert, /Could not record the version to return to, so the update stopped before changing anything\. .*Paperclip is starting the version it had before\./);
  assert.doesNotMatch(await readFile(env.PAPERCLIP_MAINTENANCE_LOG, "utf8"), /should-not-run/);
});

test("a failed install or build after the merge goes through the rollback, never straight to a start", { skip }, async () => {
  const source = await readFile(path.join(path.dirname(common), "update-paperclip.sh"), "utf8");
  assert.ok(source.includes("\npnpm install --no-frozen-lockfile || roll_back_before_migrate "), "install");
  assert.ok(source.includes("\npnpm build:runtime || roll_back_before_migrate "), "build");
  const at = (text) => source.indexOf(text);
  assert.ok(at("git merge --ff-only origin/master") < at("pnpm install --no-frozen-lockfile") && at("pnpm build:runtime") < at("\nconfigure_database\n"), "between the merge and the migration");
});

test("a failed build is rolled back and the previous version starts", { skip }, async () => {
  const inst = await instance();
  const env = await stubMac(inst);
  await stubGuard(inst);
  const result = run("watch_unattended_run update; service stop; false || roll_back_before_migrate 'Building the new version failed' 'pnpm build:runtime'; echo should-not-run", inst, env);
  assert.equal(result.code, 1);
  const log = await readLog(inst);
  assert.match(log, /node update-guard\.mjs rollback/);
  assert.match(log, /open -a Terminal/, "the previous version starts");
  const [alert, extra] = await waitForAlerts(inst);
  assert.equal(extra, undefined);
  assert.match(alert, /Building the new version failed, so the update was rolled back to the previous version\..*Paperclip is starting the previous version again\./);
  assert.doesNotMatch(await readFile(env.PAPERCLIP_MAINTENANCE_LOG, "utf8"), /should-not-run/);
});

test("a failed install with no rollback point, or a failed rollback, stops without starting anything", { skip }, async () => {
  for (const [exit, wording] of [["2", /no earlier version is recorded/], ["1", /rolling back to the previous version also failed/]]) {
    const inst = await instance();
    const env = await stubMac(inst);
    await stubGuard(inst);
    const result = run("watch_unattended_run update; service stop; false || roll_back_before_migrate 'Installing the new version failed' 'pnpm install'", inst, { ...env, STUB_ROLLBACK_EXIT: exit });
    assert.equal(result.code, 1, exit);
    const log = await readLog(inst);
    assert.doesNotMatch(log, /open -a Terminal|installed-service\.ts start/, `rollback exit ${exit}: nothing started`);
    const [alert] = await alerts(inst);
    assert.match(alert ?? "", wording);
    assert.match(alert ?? "", /Paperclip was not started, because .* migrate the database\..*Paperclip is stopped\. Fix the problem, then run the update again\./);
  }
});

test("a recorded rollback point lets the update carry on", { skip }, async () => {
  const inst = await instance();
  const env = await stubMac(inst);
  await stubGuard(inst);
  const result = run("watch_unattended_run update; record_previous_commit; echo carried-on", inst, env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(await readFile(env.PAPERCLIP_MAINTENANCE_LOG, "utf8"), /carried-on/);
  assert.doesNotMatch(await readLog(inst), /open -a Terminal/);
});

test("after a passing trial the install is recorded and old cold copies are pruned", { skip }, async () => {
  const inst = await instance();
  const env = await stubMac(inst, { fromUi: false });
  await stubGuard(inst);
  // run() keeps stderr only for a failed run, so the warnings are merged in.
  const result = run("record_update_install 2>&1 && echo carried-on", inst, env);
  assert.equal(result.code, 0, result.stderr);
  const log = await readLog(inst);
  assert.match(log, /node install-metadata\.mjs /);
  assert.match(log, /node update-guard\.mjs prune-cold-backups/);
  assert.match(result.stdout, /carried-on/);
  assert.doesNotMatch(result.stdout, /Warning/);
});

test("a failure to record the install or prune is reported, but the healthy version still starts", { skip }, async () => {
  const inst = await instance();
  const env = await stubMac(inst, { fromUi: false });
  await stubGuard(inst);
  const result = run("record_update_install 2>&1 && echo carried-on", inst, { ...env, STUB_INSTALL_EXIT: "1", STUB_PRUNE_EXIT: "1" });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /carried-on/);
  assert.match(result.stdout, /the install record \(install\.json\) could not be refreshed\. The next update will not be able to roll back automatically/);
  assert.match(result.stdout, /old cold database copies could not be removed/);
});

test("the failure alert does not hold up starting the previous version", { skip }, async () => {
  const { chmod } = await import("node:fs/promises");
  const inst = await instance();
  const env = await stubMac(inst);
  await stubGuard(inst);
  // An alert that stays up until it is clicked, which here is never: it
  // waits for a release file the test only creates at the end.
  const release = path.join(inst.root, "release-alert");
  const closed = path.join(inst.root, "alert-closed");
  await writeFile(path.join(inst.bin, "osascript"), [
    "#!/usr/bin/env bash",
    `printf 'osascript' >> "$STUB_LOG"; printf ' [%s]' "$@" >> "$STUB_LOG"; echo >> "$STUB_LOG"`,
    `for _ in $(seq 1 300); do [ -e '${release}' ] && break; sleep 0.1; done`,
    `touch '${closed}'`,
    "",
  ].join("\n"));
  await chmod(path.join(inst.bin, "osascript"), 0o755);
  try {
    const started = Date.now();
    const result = run("watch_unattended_run update; trial_start_or_roll_back", inst, { ...env, STUB_TRIAL_EXIT: "1" });
    const elapsed = Date.now() - started;
    assert.equal(result.code, 1);
    assert.match(await readLog(inst), /open -a Terminal/, "the previous version was started");
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(closed), false, "while the alert was still waiting for its click");
    assert.ok(elapsed < 20_000, `the run did not wait for the alert (${elapsed} ms)`);
    const [alert] = await waitForAlerts(inst);
    assert.match(alert ?? "", /rolled back to the previous version/, "the alert is still shown");
  } finally {
    await writeFile(release, "");
  }
});

test("a passing trial carries on and leaves no trial server registered", { skip }, async () => {
  const inst = await instance();
  const env = await stubMac(inst);
  await stubGuard(inst);
  const result = run("watch_unattended_run update; trial_start_or_roll_back; echo carried-on", inst, env);
  assert.equal(result.code, 0, result.stderr);
  const log = await readLog(inst);
  assert.match(log, /node update-guard\.mjs trial-start --launcher unix/);
  assert.match(log, /installed-service\.ts stop/);
  assert.doesNotMatch(log, /rollback/);
  assert.match(await readFile(env.PAPERCLIP_MAINTENANCE_LOG, "utf8"), /carried-on/);
  assert.deepEqual(await alerts(inst), []);
});

test("a failed trial rolls back, says so, and starts the previous version", { skip }, async () => {
  const inst = await instance();
  const env = await stubMac(inst);
  await stubGuard(inst);
  const result = run("watch_unattended_run update; trial_start_or_roll_back; echo should-not-run", inst, { ...env, STUB_TRIAL_EXIT: "1" });
  assert.equal(result.code, 1);
  const log = await readLog(inst);
  assert.match(log, /node update-guard\.mjs rollback/);
  assert.match(log, /open -a Terminal/, "the previous version is relaunched the usual way");
  const [alert, extra] = await waitForAlerts(inst);
  assert.equal(extra, undefined, "one alert, not a second one from the exit trap");
  assert.match(alert, /\[Paperclip update failed\]/);
  assert.match(alert, /rolled back to the previous version\. Paperclip is starting the previous version again\./);
  assert.doesNotMatch(await readFile(env.PAPERCLIP_MAINTENANCE_LOG, "utf8"), /should-not-run/);
});

test("a failed trial with nothing to roll back to stops with the reason", { skip }, async () => {
  const inst = await instance();
  const env = await stubMac(inst);
  await stubGuard(inst);
  const result = run("watch_unattended_run update; service stop; trial_start_or_roll_back", inst, { ...env, STUB_TRIAL_EXIT: "1", STUB_ROLLBACK_EXIT: "2" });
  assert.equal(result.code, 1);
  const log = await readLog(inst);
  assert.doesNotMatch(log, /installed-service\.ts start/);
  assert.doesNotMatch(log, /open -a Terminal/);
  const [alert] = await alerts(inst);
  assert.match(alert, /no earlier version is recorded, so it could not be rolled back\. The reason is in the output above\. Paperclip is stopped\./);
});

test("a rollback that fails stops with the reason and does not relaunch", { skip }, async () => {
  const inst = await instance();
  const env = await stubMac(inst);
  await stubGuard(inst);
  const result = run("watch_unattended_run update; service stop; trial_start_or_roll_back", inst, { ...env, STUB_TRIAL_EXIT: "1", STUB_ROLLBACK_EXIT: "1" });
  assert.equal(result.code, 1);
  assert.doesNotMatch(await readLog(inst), /open -a Terminal|installed-service\.ts start/);
  assert.match((await alerts(inst))[0] ?? "", /rolling back to the previous version also failed/);
});
