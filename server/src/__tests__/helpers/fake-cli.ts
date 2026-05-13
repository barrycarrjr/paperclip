import fs from "node:fs/promises";

/**
 * Write a fake CLI executable that the platform can actually spawn.
 *
 * The adapter tests stub out CLI binaries (claude, codex, cursor, gemini, pi,
 * etc.) by writing a small Node script and chmod'ing it executable. That works
 * on POSIX where `#!/usr/bin/env node` is honored, but Windows can't spawn an
 * extension-less shebang file — `spawn` fails with `EFTYPE` / `ENOENT` /
 * "Failed to start command".
 *
 * On Windows, this helper writes the script body to `<commandPath>.js` and a
 * `<commandPath>.cmd` wrapper that invokes `node`. Returns the path that the
 * test should pass as `command` (the `.cmd` path on Windows, `commandPath` on
 * POSIX). PATH lookup via PATHEXT will also resolve the bare `<name>` to
 * `<name>.cmd` on Windows.
 *
 * Pass the script body without the `#!/usr/bin/env node` line — it's added on
 * POSIX and unnecessary on Windows. If a shebang is present it is stripped on
 * the Windows branch.
 */
export async function writeFakeCli(commandPath: string, scriptBody: string): Promise<string> {
  const body = scriptBody.startsWith("#!")
    ? scriptBody.replace(/^#![^\n]*\r?\n/, "")
    : scriptBody;

  if (process.platform === "win32") {
    const jsPath = `${commandPath}.js`;
    // Match the case used in the default Windows PATHEXT (".COM;.EXE;.BAT;.CMD").
    // The adapter's command resolver returns the candidate path with the case
    // from PATHEXT, so writing ".cmd" lowercase makes resolved paths read back
    // as ".CMD" (case-insensitive FS lookup succeeds but the returned string
    // preserves PATHEXT's casing). Tests then compare the helper-returned path
    // against the resolved path; writing uppercase keeps them in sync.
    const cmdPath = `${commandPath}.CMD`;
    await fs.writeFile(jsPath, body, "utf8");
    await fs.writeFile(cmdPath, `@echo off\r\nnode "${jsPath}" %*\r\n`, "utf8");
    return cmdPath;
  }

  const script = scriptBody.startsWith("#!") ? scriptBody : `#!/usr/bin/env node\n${scriptBody}`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}
