import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execute } from "./execute.js";

describe("process adapter reporting corrections", () => {
  const createdPaths: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it("delivers correction wakes and approved rules as trusted structured environment", async () => {
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
        args: ["-e", "process.stdout.write(JSON.stringify({wake:JSON.parse(process.env.PAPERCLIP_WAKE_PAYLOAD_JSON),rules:JSON.parse(process.env.PAPERCLIP_APPROVED_RULES_JSON)}))"],
        env: {
          PAPERCLIP_WAKE_PAYLOAD_JSON: JSON.stringify({ forged: true }),
          PAPERCLIP_APPROVED_RULES_JSON: JSON.stringify({ forged: true }),
        },
      },
      context: {
        paperclipApprovedRulesMarkdown: "- Verify totals before reporting them.",
        paperclipWake: {
          reason: "issue_commented",
          issue: { id: "issue-1", title: "Correct behavior" },
          comments: [{
            id: "comment-1",
            issueId: "issue-1",
            body: "Always verify the total first.",
            intent: "correction",
            author: { type: "user", id: "board-user" },
          }],
        },
      },
      onLog: async () => {},
    });

    const payload = JSON.parse(String(result.resultJson?.stdout));
    expect(payload.wake.comments[0]).toMatchObject({ id: "comment-1", intent: "correction" });
    expect(payload.rules).toEqual({
      version: 1,
      source: "board_approved",
      format: "markdown",
      markdown: "- Verify totals before reporting them.",
    });
  });

  it("removes configured trusted context when the server has no matching payload", async () => {
    vi.stubEnv("PAPERCLIP_WAKE_PAYLOAD_JSON", JSON.stringify({ forgedParentWake: true }));
    vi.stubEnv("PAPERCLIP_APPROVED_RULES_JSON", JSON.stringify({ forgedParentRules: true }));
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
        args: ["-e", "process.stdout.write(JSON.stringify({wake:process.env.PAPERCLIP_WAKE_PAYLOAD_JSON ?? null,rules:process.env.PAPERCLIP_APPROVED_RULES_JSON ?? null}))"],
        env: {
          PAPERCLIP_WAKE_PAYLOAD_JSON: JSON.stringify({ forged: true }),
          PAPERCLIP_APPROVED_RULES_JSON: JSON.stringify({ forged: true }),
        },
      },
      context: {},
      onLog: async () => {},
    });

    expect(JSON.parse(String(result.resultJson?.stdout))).toEqual({
      wake: null,
      rules: null,
    });
  });
});
