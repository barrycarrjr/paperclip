import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Runs once when the whole run finishes. Clears embedded PostgreSQL left
    // behind by test files that were killed before their own cleanup could run.
    globalSetup: ["./packages/db/src/vitest-sweep-postgres.ts"],
    projects: [
      "packages/shared",
      "packages/db",
      "packages/adapter-utils",
      "packages/adapters/aider-local",
      "packages/adapters/claude-local",
      "packages/adapters/codex-local",
      "packages/adapters/cursor-local",
      "packages/adapters/cursor-cloud",
      "packages/adapters/gemini-local",
      "packages/adapters/grok-local",
      "packages/adapters/hermes",
      "packages/adapters/kimi-local",
      "packages/adapters/ollama-local",
      "packages/adapters/opencode-local",
      "packages/adapters/pi-local",
      "server",
      "ui",
      "cli",
    ],
  },
});
