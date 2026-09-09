import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePaperclipHomeDir } from "./home-paths.js";

function toGlobstarPath(candidate: string): string {
  return `${candidate.replaceAll(path.sep, "/")}/**`;
}

function addIgnorePath(target: Set<string>, candidate: string): void {
  target.add(candidate);
  target.add(toGlobstarPath(candidate));
  try {
    const realPath = fs.realpathSync(candidate);
    target.add(realPath);
    target.add(toGlobstarPath(realPath));
  } catch {
    // Ignore paths that do not exist in the current checkout.
  }
}

export function resolveServerDevWatchIgnorePaths(serverRoot: string): string[] {
  const ignorePaths = new Set<string>([
    "**/{node_modules,bower_components,vendor}/**",
    "**/.vite-temp/**",
  ]);

  const defaultPaperclipHome = path.resolve(os.homedir(), ".paperclip");
  const paperclipHomes = new Set([
    defaultPaperclipHome,
    resolvePaperclipHomeDir(),
  ]);
  const runtimePluginPaths = [...paperclipHomes].flatMap((paperclipHome) => [
    path.join(paperclipHome, "adapter-plugins"),
    path.join(paperclipHome, "plugins"),
    path.join(paperclipHome, "installed-plugins"),
  ]);

  for (const candidate of [
    path.resolve(serverRoot, "../ui/node_modules"),
    path.resolve(serverRoot, "../ui/node_modules/.vite-temp"),
    path.resolve(serverRoot, "../ui/.vite"),
    path.resolve(serverRoot, "../ui/dist"),
    // Plugin installs deliberately mutate these runtime directories. The
    // lifecycle manager reloads only the affected worker, so treating those
    // writes as server-source changes interrupts the request and can strand a
    // multi-plugin update halfway through. Keep all runtime plugin stores out
    // of the host server's tsx watcher.
    ...runtimePluginPaths,
  ]) {
    addIgnorePath(ignorePaths, candidate);
  }

  return [...ignorePaths];
}
