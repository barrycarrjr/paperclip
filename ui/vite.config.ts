import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createUiDevWatchOptions } from "./src/lib/vite-watch";

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  // The Windows launcher rotates this token only when Vite's generated cache
  // is cleared. Because optimizeDeps responses are intentionally cached by
  // browsers for a year, a fresh cache with the old browser hash can otherwise
  // leave an already-open tab requesting chunk names that no longer exist.
  // Including the generation in the optimizer config produces a new ?v= URL
  // without forcing re-optimization on ordinary restarts.
  optimizeDeps: {
    esbuildOptions: {
      define: {
        __PAPERCLIP_UI_CACHE_GENERATION__: JSON.stringify(
          process.env.PAPERCLIP_UI_CACHE_GENERATION ?? "unmanaged",
        ),
      },
    },
  },
  build: {
    minify: "esbuild",
  },
  esbuild:
    mode === "production"
      ? {
          drop: ["console", "debugger"],
          legalComments: "none",
        }
      : undefined,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/Lexical.mjs"),
    },
  },
  server: {
    port: 5173,
    watch: createUiDevWatchOptions(process.cwd()),
    proxy: {
      "/api": {
        target: "http://localhost:3100",
        ws: true,
      },
    },
  },
}));
