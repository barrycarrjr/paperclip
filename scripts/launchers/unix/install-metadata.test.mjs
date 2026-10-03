import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createMacApp, shellQuote } from "./install-metadata.mjs";

test("Mac app uses executable entry points and quotes special characters in checkout paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-mac-launcher-"));
  const repoPath = path.join(root, "Barry's Paperclip & friends $(ignored)");
  const app = await createMacApp({ repoPath, homeDir: path.join(root, "launchers"), applicationsDir: path.join(root, "Applications"), configPath: path.join(root, "config.json"), paperclipHome: root, instanceId: "default" });
  const executable = path.join(app, "Contents", "MacOS", "Paperclip");
  const source = await readFile(executable, "utf8");
  assert.ok(source.includes("/usr/bin/open -a Terminal"));
  const command = await readFile(path.join(root, "launchers", "launch-paperclip.command"), "utf8");
  assert.ok(command.includes(shellQuote(path.join(repoPath, "scripts", "launchers", "macos", "launch-paperclip.command"))));
  assert.ok(command.includes("export PAPERCLIP_CONFIG="));
  assert.ok(command.includes("export PAPERCLIP_INSTANCE_ID='default'"));
  assert.match(await readFile(path.join(app, "Contents", "Info.plist"), "utf8"), /Barry&apos;s Paperclip &amp; friends/);
  if (process.platform !== "win32") assert.equal((await stat(executable)).mode & 0o111, 0o111);
});

test("shell paths with apostrophes cannot escape their quoted argument", () => {
  assert.equal(shellQuote("it's $(echo secret)"), "'it'\\''s $(echo secret)'");
});
