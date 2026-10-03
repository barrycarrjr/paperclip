/**
 * System-level routes — shut down, restart, and update the running paperclip
 * server from the Settings UI instead of forcing operators to drop to the
 * launcher scripts in `~/.paperclip/launchers/`.
 *
 * Design notes
 * ============
 *
 * **Shutdown** is straightforward: send SIGTERM to ourselves so the existing
 * graceful-shutdown handler (in server/src/index.ts) runs. That stops the
 * worker manager, closes the embedded postgres if we own it, flushes
 * telemetry, and exits cleanly.
 *
 * **Restart** is harder: a Node process can't restart itself directly because
 * the process holding the listen port has to release it before a fresh server
 * can bind. We use a detached "trampoline" — spawn a small helper that
 * survives our exit, waits for the port to free, then re-launches paperclip.
 *
 *   Preferred trampoline: `~/.paperclip/launchers/launch-paperclip.bat`
 *   (Windows operators usually have one; matches the console-window UX they
 *   already know.)
 *
 *   Fallback: re-exec the same node binary + argv that started us. Works on
 *   any platform but doesn't reattach to the launcher's console window.
 *
 * **Update** spawns the installed maintenance launcher. Windows uses a
 * console window; managed macOS/Linux installations use the Unix scripts and
 * a maintenance log. The launcher stops, backs up, builds, migrates, and starts
 * its installation — so we don't SIGTERM ourselves.
 *
 * All three routes require instance-admin authority — these are destructive
 * actions for everyone connected to this paperclip instance.
 */
import { Router, type Request, type Response } from "express";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertInstanceAdmin } from "./authz.js";
import { checkForRemoteUpdate } from "../services/check-for-updates.js";
import { resolvePaperclipHomeDir } from "../home-paths.js";

const SHUTDOWN_DELAY_MS = 250;
const RESTART_TRAMPOLINE_DELAY_MS = 2000;

/**
 * Pick the best available Windows launcher for a UI-driven restart.
 *
 * Preference order:
 *   1. `<repo>\scripts\launchers\windows\paperclip.exe` — silent (no console
 *      window). This is what `install-paperclip.bat` recommends for the
 *      default no-terminal launch, so a UI restart should match.
 *   2. `<repo>\scripts\launchers\windows\launch-paperclip.bat` — opens its
 *      own console window with verbose server logs. Older fallback.
 *   3. `~/.paperclip/launchers/launch-paperclip.bat` — legacy install layout
 *      kept for back-compat with installs that predate the in-repo launcher.
 *
 * Returns `null` if none are found (caller falls back to re-execing node).
 */
function findWindowsRestartLauncher(): { path: string; kind: "exe" | "bat" } | null {
  if (process.platform !== "win32") return null;

  const exe = repoLauncherScriptPath("paperclip.exe");
  if (exe) return { path: exe, kind: "exe" };

  const repoBat = repoLauncherScriptPath("launch-paperclip.bat");
  if (repoBat) return { path: repoBat, kind: "bat" };

  const legacyBat = path.join(os.homedir(), ".paperclip", "launchers", "launch-paperclip.bat");
  if (existsSync(legacyBat)) return { path: legacyBat, kind: "bat" };

  return null;
}

/**
 * Read the repo path that the install marker records so the update route can
 * find `<repo>\scripts\launchers\windows\update-paperclip.bat`. install.json
 * is written by install-paperclip.bat / update-paperclip.bat themselves, so
 * if it's missing we have no reliable way to find the bat — return null and
 * let the caller surface a friendly error.
 */
function readInstallRepoPath(): string | null {
  try {
    const raw = readFileSync(path.join(resolvePaperclipHomeDir(), "install.json"), "utf8");
    // Strip a potential UTF-8 BOM (PowerShell's `Set-Content -Encoding UTF8`
    // writes one on Windows).
    const parsed = JSON.parse(raw.replace(/^﻿/, "")) as { repoPath?: string };
    const repoPath = typeof parsed.repoPath === "string" && parsed.repoPath.length > 0 ? parsed.repoPath : null;
    return repoPath;
  } catch {
    return null;
  }
}

function repoLauncherScriptPath(scriptName: string): string | null {
  const repoPath = readInstallRepoPath();
  if (!repoPath) return null;
  const platform = process.platform === "win32" ? "windows" : "unix";
  const name = process.platform === "win32" ? scriptName : scriptName.replace(/\.bat$/, ".sh");
  const bat = path.join(repoPath, "scripts", "launchers", platform, name);
  return existsSync(bat) ? bat : null;
}

function spawnRestartTrampoline(): void {
  // The trampoline waits for the parent (this process) to exit and release
  // the listen port, then launches a fresh server. Always uses a Node
  // process to host the delay + spawn — that lets us avoid the cmd.exe
  // quoting hell that `cmd /c "timeout & start "" "<bat>""` runs into when
  // a path contains nested quotes.
  const launcher = findWindowsRestartLauncher();

  let spawnCmd: string;
  let spawnArgs: string[];
  let spawnOpts: Record<string, unknown>;

  if (launcher && launcher.kind === "exe") {
    // paperclip.exe is a silent Windows launcher — no console window.
    // Spawn it directly with stdio:"ignore" + windowsHide:true so the
    // restart is invisible to the user (the UI already shows progress).
    spawnCmd = launcher.path;
    spawnArgs = [];
    spawnOpts = {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      cwd: os.homedir(),
    };
  } else if (launcher && launcher.kind === "bat") {
    // The .bat opens its own console window for verbose logs. On Windows,
    // `cmd /c start "" "<bat>"` opens the bat in its own window and lets
    // the spawned cmd die. We pass the path as a separate argv element
    // (not interpolated into a command string) so quoting can't bite.
    spawnCmd = "cmd.exe";
    spawnArgs = ["/c", "start", "", launcher.path];
    spawnOpts = {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      // Run the bat from the user's home dir so its `cd /d "%PAPERCLIP_SRC%"`
      // is unambiguous regardless of where this server's cwd happened to be.
      cwd: os.homedir(),
    };
  } else if (process.platform !== "win32" && process.env.PAPERCLIP_MANAGED_INSTALL === "1") {
    const script = repoLauncherScriptPath("restart-paperclip.bat");
    if (!script) throw new Error("The Unix restart launcher is missing; re-run the installer.");
    spawnCmd = "/bin/bash";
    spawnArgs = [script];
    spawnOpts = { cwd: readInstallRepoPath()!, env: { ...process.env }, detached: true, stdio: "ignore" };
  } else {
    // Cross-platform fallback: re-exec the same node binary + flags + script
    // + args. On Windows, `stdio:"inherit"` from the console-less trampoline
    // parent causes the OS to allocate a new console window for every
    // node.exe in the boot chain (pnpm/tsx spawn helpers), which is the
    // surprise the user sees as a stack of node windows. Use stdio:"ignore"
    // + windowsHide:true on Windows so the new server boots silently.
    // Non-Windows still inherits stdio so terminal-launched paperclip keeps
    // logging to the same terminal.
    spawnCmd = process.execPath;
    spawnArgs = [...process.execArgv, ...process.argv.slice(1)];
    spawnOpts = {
      cwd: process.cwd(),
      env: { ...process.env },
      detached: true,
      stdio: process.platform === "win32" ? "ignore" : "inherit",
      windowsHide: true,
    };
  }

  // Host the wait inside a Node process so port-release timing is robust
  // and we don't depend on Windows `timeout` semantics. The trampoline:
  //   1. Sleeps RESTART_TRAMPOLINE_DELAY_MS to let our SIGTERM handler get
  //      going (postgres shutdown, worker drain, port release).
  //   2. On Windows, kills any lingering paperclip.exe (the tray launcher).
  //      paperclip.exe holds a single-instance lock (a named mutex) that
  //      survives our server SIGTERM — it's a separate process from
  //      the server. If we don't kill it, the new paperclip.exe we're about
  //      to spawn fails the lock, just opens the browser, and exits without
  //      starting a server. The user is left with a dead tab pointing at a
  //      no-longer-listening port. Mirrors the manual workaround: tray
  //      "Shut down" (which exits paperclip.exe) + re-run the EXE.
  //   3. Polls port 3100 until it's actually free (up to 30s). paperclip.exe
  //      decides whether to spawn a server based on a one-shot port-bound
  //      check; if it sees the still-shutting-down server it skips the spawn
  //      and just opens the browser — same dead-tab failure mode.
  //   4. Spawns the launcher.
  const isWin = process.platform === "win32";
  const trampolineSrc = `
    const { spawn, spawnSync } = require('node:child_process');
    const net = require('node:net');
    function portIsBound(port) {
      return new Promise((resolve) => {
        const sock = new net.Socket();
        sock.setTimeout(200);
        sock.once('connect', () => { sock.destroy(); resolve(true); });
        sock.once('timeout', () => { sock.destroy(); resolve(false); });
        sock.once('error', () => { resolve(false); });
        sock.connect(port, '127.0.0.1');
      });
    }
    (async () => {
      await new Promise((r) => setTimeout(r, ${RESTART_TRAMPOLINE_DELAY_MS}));
      if (${JSON.stringify(isWin)}) {
        try {
          spawnSync('taskkill', ['/F', '/IM', 'paperclip.exe'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } catch (_) {}
      }
      for (let i = 0; i < 30; i++) {
        if (!(await portIsBound(3100))) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      const child = spawn(
        ${JSON.stringify(spawnCmd)},
        ${JSON.stringify(spawnArgs)},
        ${JSON.stringify(spawnOpts)},
      );
      child.unref();
    })();
  `;

  const child = spawn(process.execPath, ["-e", trampolineSrc], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function killSelfGracefully(): void {
  // SIGTERM triggers the shutdown handler in server/src/index.ts.
  // On Windows, SIGTERM still routes through Node's signal emulation and
  // fires the same once("SIGTERM") listener.
  setTimeout(() => {
    process.kill(process.pid, "SIGTERM");
  }, SHUTDOWN_DELAY_MS);
}

export function systemRoutes() {
  const router = Router();

  /**
   * POST /api/system/shutdown
   *
   * Stop the paperclip server. After the response is sent, SIGTERM is sent
   * to ourselves so the graceful shutdown handler runs.
   */
  router.post("/system/shutdown", (req, res) => {
    assertInstanceAdmin(req);
    res.json({
      ok: true,
      action: "shutdown",
      message: "Paperclip is shutting down. The server will exit in a moment.",
    });
    killSelfGracefully();
  });

  /**
   * Shared launcher-spawning route handler for the update / rebuild actions.
   * The detached maintenance launcher stops this installation itself.
   */
  async function handleLauncherSpawn(
    req: Request,
    res: Response,
    action: "update" | "rebuild",
    scriptName: string,
    successMessage: string,
  ) {
    assertInstanceAdmin(req);

    if (process.platform !== "win32" && process.env.PAPERCLIP_MANAGED_INSTALL !== "1") {
      res.status(409).json({
        ok: false,
        action,
        error: "Start Paperclip with scripts/launchers/macos/launch-paperclip.command or scripts/launchers/unix/launch-paperclip.sh before using update or rebuild from the UI.",
      });
      return;
    }

    const bat = repoLauncherScriptPath(scriptName);
    if (!bat) {
      res.status(500).json({
        ok: false,
        action,
        error: `Could not locate the ${action} launcher. Re-run the installer to record this checkout in ~/.paperclip/install.json.`,
      });
      return;
    }

    let logFd: number | undefined;
    try {
      const isWindows = process.platform === "win32";
      if (!isWindows) {
        const logDir = path.join(resolvePaperclipHomeDir(), "logs");
        mkdirSync(logDir, { recursive: true });
        logFd = openSync(path.join(logDir, "maintenance.log"), "a", 0o600);
      }
      const child = spawn(isWindows ? "cmd.exe" : "/bin/bash", isWindows ? ["/c", "start", "", bat] : [bat], {
        detached: true,
        stdio: isWindows ? "ignore" : ["ignore", logFd!, logFd!],
        windowsHide: isWindows ? false : true,
        // Run from the user's home dir so the bat's `cd /d "%PAPERCLIP_SRC%"`
        // resolves predictably.
        cwd: os.homedir(),
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
    } catch (err) {
      res.status(500).json({
        ok: false,
        action,
        error: `Failed to start ${scriptName}: ${err instanceof Error ? err.message : String(err)}. Server is still running.`,
      });
      return;
    } finally {
      if (logFd !== undefined) closeSync(logFd);
    }

    res.json({
      ok: true,
      action,
      message: process.platform === "win32" ? successMessage : `Paperclip is ${action === "update" ? "updating" : "rebuilding"}. Progress is recorded in ${path.join(resolvePaperclipHomeDir(), "logs", "maintenance.log")}; it will relaunch after the build and migration succeed.`,
    });
    // The maintenance launcher stops the managed installation.
  }

  /**
   * POST /api/system/update
   *
   * Run update-paperclip.bat: stop server, git pull origin/master, rebuild,
   * migrate, relaunch. Managed Unix installs use the equivalent shell script.
   */
  router.post("/system/update", async (req, res) => {
    await handleLauncherSpawn(
      req,
      res,
      "update",
      "update-paperclip.bat",
      "Paperclip is updating. A console window has opened — it will stop this server, pull the latest, rebuild, migrate, and relaunch automatically.",
    );
  });

  /**
   * POST /api/system/rebuild
   *
   * Run rebuild-paperclip.bat: stop server, build from local working tree
   * (no git pull), migrate, relaunch. The local-dev counterpart to /update —
   * use this after editing source files to bake the changes into the running
   * install. Managed Unix installs use the equivalent shell script.
   */
  router.post("/system/rebuild", async (req, res) => {
    await handleLauncherSpawn(
      req,
      res,
      "rebuild",
      "rebuild-paperclip.bat",
      "Paperclip is rebuilding from the local working tree. A console window has opened — it will stop this server, rebuild, migrate, and relaunch automatically.",
    );
  });

  /**
   * GET /api/system/update-check
   *
   * Compare the local install's commit against the latest commit on the
   * tracked branch in the configured GitHub remote. The UI uses this to show
   * a passive "update available" indicator without requiring the user to
   * speculatively click "Update Paperclip".
   *
   * Backed by an in-process 5-minute cache on the GitHub fetch — repeated UI
   * polls and multi-tab sessions don't burn the 60/hr unauthenticated rate
   * limit. Always returns a value; errors come back in the `error` field.
   */
  router.get("/system/update-check", async (req, res) => {
    assertInstanceAdmin(req);
    const result = await checkForRemoteUpdate();
    res.json(result);
  });

  /**
   * POST /api/system/restart
   *
   * Restart the paperclip server. Spawns a detached trampoline that will
   * launch a fresh server after the current one exits, then SIGTERMs
   * ourselves so the graceful shutdown handler runs and frees the port.
   */
  router.post("/system/restart", (req, res) => {
    assertInstanceAdmin(req);

    let trampolineErr: string | null = null;
    try {
      spawnRestartTrampoline();
    } catch (err) {
      trampolineErr = err instanceof Error ? err.message : String(err);
    }

    if (trampolineErr) {
      res.status(500).json({
        ok: false,
        action: "restart",
        error: `Failed to schedule restart: ${trampolineErr}. Server is still running.`,
      });
      return;
    }

    res.json({
      ok: true,
      action: "restart",
      message:
        "Paperclip is restarting. The server will exit and a fresh instance will boot in a few seconds.",
      usedLauncher: findWindowsRestartLauncher() !== null,
    });
    killSelfGracefully();
  });

  return router;
}
