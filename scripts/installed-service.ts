import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
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
const existing = await findAdoptableLocalService({ serviceKey, command, cwd: launchCwd, envFingerprint });
const action = process.argv[2] ?? "start";
if (action === "stop") {
  if (existing) {
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
    const child = spawn(process.execPath, [
      path.join(repoRoot, "cli", "node_modules", "tsx", "dist", "cli.mjs"), command, "run",
    ], {
      cwd: launchCwd, env: { ...process.env, PAPERCLIP_CONFIG: configPath, PAPERCLIP_MANAGED_INSTALL: "1" },
      stdio: "inherit", detached: process.platform !== "win32", windowsHide: true,
    });
    // Register settlement immediately so an early boot failure cannot be missed
    // while the registry file is being written.
    const exited = new Promise<number>((resolve) => {
      child.once("exit", (value) => resolve(value ?? 0));
      child.once("error", () => resolve(1));
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const now = new Date().toISOString();
    try {
      await writeLocalServiceRegistryRecord({
      version: 1, serviceKey, profileKind: "paperclip-install",
      serviceName: "paperclip-installed", command, cwd: launchCwd, envFingerprint,
      pid: child.pid!, processGroupId: process.platform === "win32" ? null : child.pid!,
      port: null, url: null, provider: "local_process", runtimeServiceId: null,
      reuseKey: null, startedAt: now, lastSeenAt: now, metadata: { repoRoot, configPath },
      });
    } catch (error) {
      await terminateLocalService({ pid: child.pid!, processGroupId: process.platform === "win32" ? null : child.pid! });
      throw error;
    }
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await terminateLocalService({ pid: child.pid!, processGroupId: process.platform === "win32" ? null : child.pid! }, { forceAfterMs: 15_000 });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const code = await exited;
    await removeLocalServiceRegistryRecord(serviceKey);
    process.exitCode = code;
  }
} else {
  throw new Error(`Unknown installed-service action: ${action}`);
}
