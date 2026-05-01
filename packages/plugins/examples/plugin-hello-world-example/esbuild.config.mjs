/**
 * Build the example plugin into self-contained dist/ artifacts.
 *
 * - dist/worker.js  — bundled (all runtime deps inlined). Spawned by paperclip
 *   as a worker process; must run without the plugin folder's node_modules
 *   because the install pipeline copies only `dist/` + `package.json` into
 *   `~/.paperclip/installed-plugins/<pluginKey>/`.
 * - dist/manifest.js — transpiled only (small file, type-only imports erased).
 * - dist/ui/index.js — bundled, externalized React + SDK ui module.
 */
import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { esbuild: presets } = createPluginBundlerPresets();

await Promise.all([
  esbuild.build(presets.worker),
  esbuild.build(presets.manifest),
  esbuild.build({
    entryPoints: [path.join(__dirname, "src/ui/index.tsx")],
    outfile: path.join(__dirname, "dist/ui/index.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    sourcemap: true,
    external: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "@paperclipai/plugin-sdk/ui",
    ],
  }),
]);
