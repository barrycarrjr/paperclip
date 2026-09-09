import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    typecheck: {
      tsconfig: "./tsconfig.test.json",
    },
    environment: "node",
    // Standing up an embedded PostgreSQL cluster - initdb, start, migrations -
    // is the setup cost of most suites here, and it is slow enough on Windows
    // to be measured in seconds even on an idle machine. Under the load of a
    // full run it reaches twenty to thirty, which the default ten-second hook
    // budget turns into two dozen "Hook timed out" failures in files that have
    // nothing wrong with them. A generous budget costs nothing when setup is
    // fast and is the difference between a real failure and a false one when
    // it is not.
    hookTimeout: 90_000,
    isolate: true,
    maxConcurrency: 1,
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
    poolOptions: {
      forks: {
        isolate: true,
        maxForks: 1,
        minForks: 1,
      },
    },
    sequence: {
      concurrent: false,
      hooks: "list",
    },
    setupFiles: ["./src/__tests__/setup-supertest.ts"],
  },
});
