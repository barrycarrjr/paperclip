// What Paperclip does on a graceful stop (SIGINT or SIGTERM) before it exits.
//
// External MCP clients are closed first. Each is a child process, and a
// warmed Docker MCP gateway runs a container per enabled server; left alone
// they could run on after Paperclip had gone, until they noticed or for up to
// the manager's five-minute idle close. That step is bounded, so a child that
// will not exit cannot hold up the database stop or the exit. Then the
// embedded database, when this process started it.

import type { ExternalMcpServerManager } from "./services/external-mcp-server-manager.js";
import { logger } from "./middleware/logger.js";

/**
 * How long to wait for external MCP clients to close. Closing a stdio child
 * ends its input and waits two seconds before terminating it, and the clients
 * close side by side, so this leaves room for that without stalling the stop.
 */
export const EXTERNAL_MCP_SHUTDOWN_TIMEOUT_MS = 5_000;

export type ShutdownSignal = "SIGINT" | "SIGTERM";

export interface GracefulShutdownSteps {
  externalMcpServerManager: Pick<ExternalMcpServerManager, "shutdown">;
  stopEmbeddedPostgres(signal: ShutdownSignal): Promise<void>;
  exit(code: number): void;
  /** Overrides EXTERNAL_MCP_SHUTDOWN_TIMEOUT_MS. For tests. */
  externalMcpTimeoutMs?: number;
}

type Settled = { outcome: "closed" } | { outcome: "timed-out" } | { outcome: "failed"; err: unknown };

async function settleWithin(work: Promise<unknown>, timeoutMs: number): Promise<Settled> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<Settled>((resolve) => {
    timer = setTimeout(() => resolve({ outcome: "timed-out" }), timeoutMs);
  });
  try {
    return await Promise.race([
      work.then(
        (): Settled => ({ outcome: "closed" }),
        (err: unknown): Settled => ({ outcome: "failed", err }),
      ),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createGracefulShutdown(steps: GracefulShutdownSteps) {
  return async (signal: ShutdownSignal): Promise<void> => {
    const timeoutMs = steps.externalMcpTimeoutMs ?? EXTERNAL_MCP_SHUTDOWN_TIMEOUT_MS;
    let settled: Settled;
    try {
      settled = await settleWithin(steps.externalMcpServerManager.shutdown(), timeoutMs);
    } catch (err) {
      settled = { outcome: "failed", err };
    }
    if (settled.outcome === "timed-out") {
      logger.warn({ signal, timeoutMs }, "external MCP clients did not all close in time; stopping anyway");
    } else if (settled.outcome === "failed") {
      logger.warn({ signal, err: settled.err }, "external MCP clients failed to close; stopping anyway");
    }

    try {
      await steps.stopEmbeddedPostgres(signal);
    } catch (err) {
      logger.error({ err }, "Failed to stop embedded PostgreSQL cleanly");
    }
    steps.exit(0);
  };
}
