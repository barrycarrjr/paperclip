import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CI runs the suite as separate parts side by side. These check that the
 * parts add up to exactly a full run, so splitting it never quietly drops a
 * test file.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts", "run-vitest-stable.mjs");
const PREFIX = "[test:run] would run: ";

function plan(...args) {
  const result = spawnSync(process.execPath, [script, "--list", ...args], { cwd: repoRoot, encoding: "utf8" });
  return {
    status: result.status,
    runs: result.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith(PREFIX))
      .map((line) => line.slice(PREFIX.length)),
  };
}

test("with no part, runs every group in the usual order", () => {
  const { status, runs } = plan();
  assert.equal(status, 0);
  assert.ok(runs[0].startsWith("non-server project "));
  const serverIndex = runs.findIndex((run) => run.startsWith("server suites excluding"));
  assert.ok(serverIndex > 0);
  assert.ok(runs.length > serverIndex + 1, "serialized suites come after the server suites");
});

test("the parts together run exactly what a full run does", () => {
  const whole = plan().runs;
  const parts = ["non-server", "server", "serialized"].flatMap((part) => plan(`--part=${part}`).runs);
  assert.deepEqual(parts, whole);
});

test("serialized shards split the suites with no overlap and no gaps", () => {
  const whole = plan("--part=serialized").runs;
  const first = plan("--part=serialized", "--shard=1/2").runs;
  const second = plan("--part=serialized", "--shard=2/2").runs;
  assert.ok(first.length > 0 && second.length > 0);
  assert.equal(new Set([...first, ...second]).size, whole.length);
  assert.deepEqual([...first, ...second].sort(), [...whole].sort());
  assert.ok(Math.abs(first.length - second.length) <= 1);
});

test("refuses a part or shard it does not know", () => {
  assert.equal(plan("--part=everything").status, 2);
  assert.equal(plan("--part=serialized", "--shard=3/2").status, 2);
  assert.equal(plan("--shard=1/2").status, 2);
});
