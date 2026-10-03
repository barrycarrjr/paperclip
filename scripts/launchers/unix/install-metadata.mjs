import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }
const xmlEscape = (value) => value.replace(/[<>&"']/g, (c) => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;', "'":'&apos;' }[c]));

export async function createMacApp({ repoPath, homeDir, applicationsDir, configPath, paperclipHome, instanceId }) {
  const app = path.join(applicationsDir, "Paperclip.app", "Contents");
  const executable = path.join(app, "MacOS", "Paperclip");
  await mkdir(path.dirname(executable), { recursive: true });
  const launch = path.join(repoPath, "scripts", "launchers", "macos", "launch-paperclip.command");
  // Terminal receives a fixed argument through open; user paths are quoted in
  // this wrapper, never interpolated into AppleScript or a shell command string.
  const command = path.join(homeDir, "launch-paperclip.command");
  await mkdir(homeDir, { recursive: true });
  await writeFile(command, `#!/bin/bash\nexport PAPERCLIP_HOME=${shellQuote(paperclipHome)}\nexport PAPERCLIP_INSTANCE_ID=${shellQuote(instanceId)}\nexport PAPERCLIP_CONFIG=${shellQuote(configPath)}\nexec /bin/bash ${shellQuote(launch)}\n`);
  await chmod(command, 0o755);
  await writeFile(executable, `#!/bin/bash\nexec /usr/bin/open -a Terminal ${shellQuote(command)}\n`);
  await chmod(executable, 0o755);
  await writeFile(path.join(app, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleName</key><string>Paperclip</string><key>CFBundleIdentifier</key><string>dev.barrycarrjr.paperclip</string><key>CFBundleExecutable</key><string>Paperclip</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>CFBundleInfoDictionaryVersion</key><string>6.0</string><key>PaperclipSource</key><string>${xmlEscape(repoPath)}</string></dict></plist>\n`);
  return path.dirname(app);
}

async function main() {
  const repoPath = path.resolve(process.argv[2]);
  const paperclipHome = path.resolve(process.env.PAPERCLIP_HOME || path.join(os.homedir(), ".paperclip"));
  const instanceId = process.env.PAPERCLIP_INSTANCE_ID || "default";
  const configPath = process.env.PAPERCLIP_CONFIG || path.join(paperclipHome, "instances", instanceId, "config.json");
  const marker = path.join(paperclipHome, "install.json");
  const existing = await readFile(marker, "utf8").then((raw) => JSON.parse(raw.replace(/^\uFEFF/, ""))).catch(() => ({}));
  const git = (...args) => execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
  const now = new Date().toISOString();
  await mkdir(paperclipHome, { recursive: true });
  await writeFile(marker, JSON.stringify({ repoPath, remote: git("remote", "get-url", "origin"), branch: git("branch", "--show-current"), commit: git("rev-parse", "HEAD"), installedAt: existing.installedAt || now, lastUpdated: now }, null, 2) + "\n");
  for (const action of ["install", "launch", "stop", "update", "rebuild"]) {
    await chmod(path.join(repoPath, "scripts", "launchers", "macos", `${action}-paperclip.command`), 0o755);
    await chmod(path.join(repoPath, "scripts", "launchers", "unix", `${action}-paperclip.sh`), 0o755);
  }
  if (process.platform === "darwin") {
    const app = await createMacApp({ repoPath, homeDir: path.join(paperclipHome, "launchers"), applicationsDir: path.join(os.homedir(), "Applications"), configPath, paperclipHome, instanceId });
    console.log(`macOS launcher: ${app}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
