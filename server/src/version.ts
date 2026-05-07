import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

type PackageJson = {
  version?: string;
};

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as PackageJson;

export const serverVersion = pkg.version ?? "0.0.0";

type InstallInfo = {
  commit?: string;
};

let cachedInstallCommit: string | null | undefined;

export function readInstallCommit(): string | null {
  if (cachedInstallCommit !== undefined) return cachedInstallCommit;
  try {
    const raw = readFileSync(join(homedir(), ".paperclip", "install.json"), "utf8");
    const parsed = JSON.parse(raw.replace(/^﻿/, "")) as InstallInfo;
    const commit = typeof parsed.commit === "string" && parsed.commit.length > 0 ? parsed.commit : null;
    cachedInstallCommit = commit;
    return commit;
  } catch {
    cachedInstallCommit = null;
    return null;
  }
}
