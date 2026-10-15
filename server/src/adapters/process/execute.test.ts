import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { execute } from "./execute.js";

describe("process adapter reporting corrections", () => {
  const createdPaths: string[] = [];

  afterEach(() => {
    for (const filePath of createdPaths.splice(0)) {
      rmSync(filePath, { force: true });
    }
  });

  it("does not repeat the configured command for a reporting-only correction", async () => {
    const markerPath = path.join(tmpdir(), `paperclip-process-correction-${randomUUID()}`);
    createdPaths.push(markerPath);
    const logs: string[] = [];

    const result = await execute({
      runId: randomUUID(),
      agent: {
        id: randomUUID(),
        companyId: randomUUID(),
        name: "Script Agent",
        adapterType: "process",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: process.execPath,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`],
      },
      context: {
        paperclipWake: {
          runCountsRequired: true,
          runCountsRetryReason: "missing_run_counts",
        },
      },
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
    });

    expect(existsSync(markerPath)).toBe(false);
    expect(logs.join("\n")).toContain("may only correct its prior report");
    expect(result.resultJson).toMatchObject({
      reportingCorrectionSkipped: true,
      retryReason: "missing_run_counts",
    });
  });
});
