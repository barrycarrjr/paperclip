import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(dir, "login-item.sh");
const launchScript = path.join(path.resolve(dir, "../../.."), "scripts", "launchers", "unix", "launch-paperclip.sh");
const mac = process.platform === "darwin";

// A scratch HOME and data home, so nothing touches the real LaunchAgents.
// The data home has "&", "<" and a space to check the plist escaping. A fake
// launchctl records calls and keeps the job out of the real launchd.
async function sandbox() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-login-"));
  const dataHome = path.join(root, "data & <home>");
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "launchctl"), [
    "#!/usr/bin/env bash",
    'echo "$*" >> "$HOME/launchctl.log"',
    'case "$1" in print) [ -f "$HOME/loaded" ] ;; bootstrap) touch "$HOME/loaded" ;; esac',
    "",
  ].join("\n"));
  await chmod(path.join(bin, "launchctl"), 0o755);
  return {
    root,
    dataHome,
    agents: path.join(root, "Library", "LaunchAgents"),
    launchctlCalls: async () => (await readFile(path.join(root, "launchctl.log"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: root,
      PAPERCLIP_HOME: dataHome,
      PAPERCLIP_INSTANCE_ID: "test",
      PAPERCLIP_CONFIG: path.join(dataHome, "instances", "test", "config.json"),
    },
  };
}

const run = (env, ...args) => spawnSync("bash", [script, ...args], { env, encoding: "utf8" });

async function plists(agents) {
  if (!existsSync(agents)) return [];
  return (await readdir(agents)).filter((name) => name.endsWith(".plist")).map((name) => path.join(agents, name));
}

const asJson = (plist) => JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" }));

test("on writes a login item that restarts the server after a crash, and loads it now", { skip: !mac }, async () => {
  const box = await sandbox();
  const result = run(box.env, "on");
  assert.equal(result.status, 0, result.stderr);
  const [plist] = await plists(box.agents);
  assert.ok(plist, "no plist written");
  const job = asJson(plist);
  assert.match(job.Label, /^com\.paperclip\.login\.[0-9a-f]{12}$/);
  assert.equal(path.basename(plist), `${job.Label}.plist`);
  assert.equal(job.RunAtLoad, true);
  assert.deepEqual(job.KeepAlive, { SuccessfulExit: false });
  assert.equal(job.ThrottleInterval, 30);
  assert.equal(job.LimitLoadToSessionType, "Aqua");
  assert.equal(job.ProgramArguments[5], launchScript);
  assert.equal(job.ProgramArguments[4], path.join(box.dataHome, "logs", "login-item.log"));
  assert.equal(job.EnvironmentVariables.PAPERCLIP_HOME, box.dataHome);
  assert.equal(job.EnvironmentVariables.PAPERCLIP_INSTANCE_ID, "test");
  assert.equal(job.EnvironmentVariables.PAPERCLIP_CONFIG, box.env.PAPERCLIP_CONFIG);
  assert.equal(job.EnvironmentVariables.PATH, box.env.PATH);
  assert.equal(job.EnvironmentVariables.PORT, undefined);
  const uid = String(os.userInfo().uid);
  assert.deepEqual(await box.launchctlCalls(), [`print gui/${uid}/${job.Label}`, `bootstrap gui/${uid} ${plist}`]);
  assert.match(run(box.env, "status").stdout, /Start at login is on\.\n.*\n.*\nLoaded now: yes/);
});

test("each start appends to the log and runs the script as the login item with the saved environment", { skip: !mac }, async () => {
  const box = await sandbox();
  assert.equal(run(box.env, "on").status, 0);
  const job = asJson((await plists(box.agents))[0]);
  const fake = path.join(box.root, "fake-launch.sh");
  await writeFile(fake, 'printf "started %s %s\\n" "$PAPERCLIP_INSTANCE_ID" "$1"\n');
  const [program, ...args] = job.ProgramArguments;
  args[4] = fake;
  execFileSync(program, args, { env: { ...job.EnvironmentVariables, HOME: box.root } });
  execFileSync(program, args, { env: { ...job.EnvironmentVariables, HOME: box.root } });
  const log = await readFile(job.ProgramArguments[4], "utf8");
  assert.equal(log.match(/started test --login-item\n/g)?.length, 2, log);
  assert.equal(log.match(/^--- /gm)?.length, 2, log);
});

test("a log past 5 MB is moved aside at the next start", { skip: !mac }, async () => {
  const box = await sandbox();
  assert.equal(run(box.env, "on").status, 0);
  const job = asJson((await plists(box.agents))[0]);
  const log = job.ProgramArguments[4];
  await mkdir(path.dirname(log), { recursive: true });
  await writeFile(log, "x".repeat(5_000_000));
  const fake = path.join(box.root, "fake-launch.sh");
  await writeFile(fake, "true\n");
  const [program, ...args] = job.ProgramArguments;
  args[4] = fake;
  execFileSync(program, args, { env: { ...job.EnvironmentVariables, HOME: box.root } });
  assert.equal((await readFile(`${log}.1`, "utf8")).length, 5_000_000);
  assert.match(await readFile(log, "utf8"), /^\n--- /);
});

test("off removes the login item and says so when it was already off", { skip: !mac }, async () => {
  const box = await sandbox();
  assert.equal(run(box.env, "on").status, 0);
  const off = run(box.env, "off");
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /no longer start/);
  assert.deepEqual(await plists(box.agents), []);
  assert.match(run(box.env, "off").stdout, /already off/);
  assert.match(run(box.env, "status").stdout, /Start at login is off\./);
});

test("a PORT or LANG set when it is turned on is kept", { skip: !mac }, async () => {
  const box = await sandbox();
  assert.equal(run({ ...box.env, PORT: "3199", LANG: "en_US.UTF-8" }, "on").status, 0);
  const env = asJson((await plists(box.agents))[0]).EnvironmentVariables;
  assert.equal(env.PORT, "3199");
  assert.equal(env.LANG, "en_US.UTF-8");
});

test("turning it on twice keeps one login item and loads it once", { skip: !mac }, async () => {
  const box = await sandbox();
  assert.equal(run(box.env, "on").status, 0);
  const again = run(box.env, "on");
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already loaded/);
  assert.equal((await plists(box.agents)).length, 1);
  assert.equal((await box.launchctlCalls()).filter((call) => call.startsWith("bootstrap")).length, 1);
});

test("each installation gets its own login item", { skip: !mac }, async () => {
  const box = await sandbox();
  assert.equal(run(box.env, "on").status, 0);
  const other = { ...box.env, PAPERCLIP_INSTANCE_ID: "other", PAPERCLIP_CONFIG: path.join(box.dataHome, "instances", "other", "config.json") };
  assert.equal(run(other, "on").status, 0);
  assert.equal((await plists(box.agents)).length, 2);
  assert.equal(run(other, "off").status, 0);
  assert.equal((await plists(box.agents)).length, 1);
  assert.match(run(box.env, "status").stdout, /Start at login is on\./);
});

test("status says when the login item starts another checkout", { skip: !mac }, async () => {
  const box = await sandbox();
  assert.equal(run(box.env, "on").status, 0);
  const [plist] = await plists(box.agents);
  execFileSync("plutil", ["-replace", "ProgramArguments.5", "-string", "/elsewhere/launch-paperclip.sh", plist]);
  assert.match(run(box.env, "status").stdout, /another checkout: \/elsewhere\/launch-paperclip\.sh/);
});

test("an unknown action is refused", { skip: !mac }, async () => {
  const box = await sandbox();
  const result = run(box.env, "maybe");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage/);
});

test("other systems are told it is macOS only", { skip: mac || process.platform === "win32" }, async () => {
  const box = await sandbox();
  const result = run(box.env, "on");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /only available on macOS/);
  assert.deepEqual(await plists(box.agents), []);
});
