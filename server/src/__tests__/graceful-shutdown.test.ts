import { describe, expect, it } from "vitest";
import { createGracefulShutdown } from "../graceful-shutdown.js";

function recorder(shutdownExternalMcp: () => Promise<void>, stopEmbeddedPostgres = async () => {}) {
  const steps: string[] = [];
  const shutdown = createGracefulShutdown({
    externalMcpServerManager: {
      shutdown: () => {
        steps.push("external mcp");
        return shutdownExternalMcp();
      },
    },
    stopEmbeddedPostgres: async () => {
      steps.push("database");
      await stopEmbeddedPostgres();
    },
    exit: (code) => {
      steps.push(`exit ${code}`);
    },
    externalMcpTimeoutMs: 50,
  });
  return { steps, shutdown };
}

describe("graceful shutdown", () => {
  it("closes external MCP clients, then stops the database, then exits", async () => {
    const { steps, shutdown } = recorder(async () => {});
    await shutdown("SIGINT");
    expect(steps).toEqual(["external mcp", "database", "exit 0"]);
  });

  it("does not wait past its bound for a client that will not close", async () => {
    const { steps, shutdown } = recorder(() => new Promise<void>(() => {}));
    const startedAt = Date.now();
    await shutdown("SIGTERM");
    expect(steps).toEqual(["external mcp", "database", "exit 0"]);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("still stops the database and exits when closing the clients fails", async () => {
    const { steps, shutdown } = recorder(async () => {
      throw new Error("close failed");
    });
    await shutdown("SIGTERM");
    expect(steps).toEqual(["external mcp", "database", "exit 0"]);
  });

  it("still exits when stopping the database fails", async () => {
    const { steps, shutdown } = recorder(
      async () => {},
      async () => {
        throw new Error("postmaster would not stop");
      },
    );
    await shutdown("SIGTERM");
    expect(steps).toEqual(["external mcp", "database", "exit 0"]);
  });
});
