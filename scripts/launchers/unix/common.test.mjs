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
