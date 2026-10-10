import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildFileLogTarget, SERVER_LOG_FILE_PATTERN } from "../middleware/log-file-target.js";

type RollingStream = {
  write(chunk: string): boolean;
  end(): void;
  once(event: "close" | "cleanup-complete", listener: () => void): void;
};

const require = createRequire(import.meta.url);
const pinoRoll = require("pino-roll") as (options: Record<string, unknown>) => Promise<RollingStream>;

function serverLogs(logDir: string): string[] {
  return fs.readdirSync(logDir).filter((name) => SERVER_LOG_FILE_PATTERN.test(name));
}

function nextEvent(stream: RollingStream, event: "close" | "cleanup-complete", timeoutMs = 5_000) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${event} within ${timeoutMs} ms`)), timeoutMs);
    stream.once(event, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe("buildFileLogTarget", () => {
  it("targets pino-roll with a bounded rolling policy", () => {
    const target = buildFileLogTarget(path.join("some", "logs"));

    expect(target.target).toBe("pino-roll");
    expect(target.level).toBe("debug");
    // Base name + extension yield server.<n>.log files in the logs dir.
    expect(target.options.file).toBe(path.join("some", "logs", "server"));
    expect(target.options.extension).toBe(".log");
    expect(target.options.mkdir).toBe(true);
    // The whole point: a finite per-file size and a finite file count so the
    // log directory can never grow unbounded again.
    expect(target.options.size).toMatch(/^\d+m$/);
    expect(target.options.limit.count).toBeGreaterThan(0);
    expect(target.options.limit.count).toBeLessThanOrEqual(10);
  });

  it("removes log files earlier server runs left behind once the log rolls", async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-log-roll-"));
    try {
      // Ten files from earlier runs, as every restart used to leave behind,
      // next to another log that is not the server's to remove. (Its name has
      // no trailing digits: pino-roll numbers new files after the highest
      // trailing number of any .log file in the folder.)
      for (let n = 1; n <= 10; n += 1) {
        fs.writeFileSync(path.join(logDir, `server.${n}.log`), "earlier run\n");
      }
      fs.writeFileSync(path.join(logDir, "launcher.log"), "launcher\n");

      const { options } = buildFileLogTarget(logDir);
      // The real policy, with a size small enough that one write rolls the file.
      const stream = await pinoRoll({ ...options, size: "1k" });
      try {
        const cleanedUp = nextEvent(stream, "cleanup-complete");
        stream.write(`${"x".repeat(2048)}\n`);
        await cleanedUp;
      } finally {
        const closed = nextEvent(stream, "close");
        stream.end();
        await closed;
      }

      const remaining = serverLogs(logDir);
      expect(remaining.length).toBeLessThanOrEqual(options.limit.count + 1);
      expect(remaining).toContain("server.11.log");
      expect(remaining).not.toContain("server.1.log");
      expect(fs.existsSync(path.join(logDir, "launcher.log"))).toBe(true);
    } finally {
      fs.rmSync(logDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
    }
  });
});
