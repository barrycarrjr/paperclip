import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDefaultConfigPath } from "../server/src/home-paths.js";
import {
  createLocalServiceKey, findAdoptableLocalService,
  removeLocalServiceRegistryRecord, terminateLocalService,
  writeLocalServiceRegistryRecord,
} from "../server/src/services/local-service-supervisor.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.resolve(process.env.PAPERCLIP_CONFIG || resolveDefaultConfigPath());
// Loading a checkout's development .env can silently redirect an installed
// instance to another database. CLI/config imports use the instance directory.
const launchCwd = path.dirname(configPath);
const command = path.join(repoRoot, "cli", "src", "index.ts");
const envFingerprint = createHash("sha256").update(configPath).digest("hex");
const serviceKey = createLocalServiceKey({
  profileKind: "paperclip-install", serviceName: "paperclip-installed",
  cwd: launchCwd, command, envFingerprint, port: null, scope: { repoRoot, configPath },
});
// A stop leaves this marker so the launcher can tell it from a crash, even
// when the server had to be killed: under the macOS login item, launchd
// restarts the server only after a crash.
const stopMarker = path.join(launchCwd, "service-stop-requested");
const ASKED_TO_STOP_EXIT_CODES = new Set([0, 130, 143]);
const existing = await findAdoptableLocalService({ serviceKey, command, cwd: launchCwd, envFingerprint });
const action = process.argv[2] ?? "start";
if (action === "stop") {
  if (existing) {
    await writeFile(stopMarker, `${existing.pid}\n`);
    await terminateLocalService(existing, { forceAfterMs: 15_000 });
    await removeLocalServiceRegistryRecord(serviceKey);
    console.log("Stopped this Paperclip installation.");
  } else {
    await mkdir(launchCwd, { recursive: true });
    console.log("No managed Paperclip server is running for this checkout and config.");
  }
} else if (action === "start") {
  if (existing) {
    console.log(`Paperclip is already running (pid ${existing.pid}).`);
  } else {
    await rm(stopMarker, { force: true });
    const child = spawn(process.execPath, [
      path.join(repoRoot, "cli", "node_modules", "tsx", "dist", "cli.mjs"), command, "run",
    ], {
      cwd: launchCwd, env: { ...process.env, PAPERCLIP_CONFIG: configPath, PAPERCLIP_MANAGED_INSTALL: "1" },
      stdio: "inherit", detached: process.platform !== "win32", windowsHide: true,
    });
    // Register settlement immediately so an early boot failure cannot be missed
    // while the registry file is being written.
    const exited = new Promise<number>((resolve) => {
      child.once("exit", (value) => resolve(value ?? 1));
      child.once("error", () => resolve(1));
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const childGroup = { pid: child.pid!, processGroupId: process.platform === "win32" ? null : child.pid! };
    const now = new Date().toISOString();
    try {
      await writeLocalServiceRegistryRecord({
      version: 1, serviceKey, profileKind: "paperclip-install",
      serviceName: "paperclip-installed", command, cwd: launchCwd, envFingerprint,
      ...childGroup,
      port: null, url: null, provider: "local_process", runtimeServiceId: null,
      reuseKey: null, startedAt: now, lastSeenAt: now, metadata: { repoRoot, configPath },
      });
    } catch (error) {
      await terminateLocalService(childGroup);
      throw error;
    }
    // Off Windows nothing else reads the desktop reminder queue (the tray does
    // on Windows), so a small client shows those reminders while the server
    // runs. It is stopped with the server, and exits on its own if this
    // process disappears.
    const reminders = process.platform === "win32" ? null : spawn(process.execPath, [
      path.join(repoRoot, "scripts", "launchers", "unix", "desktop-reminders.mjs"),
    ], { cwd: launchCwd, env: { ...process.env, PAPERCLIP_CONFIG: configPath }, stdio: "inherit" });
    reminders?.on("error", (error) => console.error(`Desktop reminders did not start: ${error.message}`));
    // Keep the Mac out of idle sleep while the server runs, so routines keep
    // firing. The display can still sleep. caffeinate exits with the server.
    if (process.platform === "darwin") {
      spawn("/usr/bin/caffeinate", ["-i", "-w", String(child.pid)], { stdio: "ignore" })
        .on("error", (error) => console.error(`Could not keep the Mac awake: ${error.message}`));
    }
    const stopReminders = () => {
      if (reminders && reminders.exitCode === null && reminders.signalCode === null) reminders.kill("SIGTERM");
    };
    let stopping = false;
    const stop = async () => {
      stopReminders();
      if (stopping) return;
      stopping = true;
      await terminateLocalService(childGroup, { forceAfterMs: 15_000 });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const code = await exited;
    stopReminders();
    // If the wrapper dies first, the real server can outlive it in the same
    // group, holding the port a restart needs. Clear whatever is left.
    await terminateLocalService(childGroup, { forceAfterMs: 15_000 });
    await removeLocalServiceRegistryRecord(serviceKey);
    // A stop (a signal to this process, or the marker from "stop") exits
    // cleanly, and so does a server that was asked to stop: tsx passes on
    // SIGINT and SIGTERM as 130 and 143, which is how its own Shut down and
    // Restart end. Anything else is a crash, which launchd answers with a
    // restart.
    const stopRequested = await rm(stopMarker).then(() => true, () => false);
    process.exitCode = stopping || stopRequested || ASKED_TO_STOP_EXIT_CODES.has(code) ? 0 : code;
  }
} else {
  throw new Error(`Unknown installed-service action: ${action}`);
}
