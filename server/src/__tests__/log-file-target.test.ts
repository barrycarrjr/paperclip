import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildFileLogTarget } from "../middleware/log-file-target.js";

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
});
