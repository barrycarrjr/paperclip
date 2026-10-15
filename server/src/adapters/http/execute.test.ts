import { afterEach, describe, expect, it, vi } from "vitest";
import { execute } from "./execute.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("http adapter execute", () => {
  it("does not repeat an external request for a reporting-only correction", async () => {
    const fetchMock = vi.fn();
    const onLog = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute({
      runId: "run-correction",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Agent",
        adapterType: "http",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: { url: "https://example.test/webhook" },
      context: {
        paperclipWake: {
          runCountsRetryReason: "missing_run_counts",
        },
      },
      onLog,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onLog).toHaveBeenCalledWith(
      "stderr",
      expect.stringContaining("may only correct its prior report"),
    );
    expect(result.resultJson).toEqual({
      reportingCorrectionSkipped: true,
      retryReason: "missing_run_counts",
    });
  });

  it("reports configured request timeout as timed_out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      })),
    );

    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Agent",
        adapterType: "http",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        url: "https://example.test/webhook",
        timeoutMs: 1,
      },
      context: {},
      onLog: async () => {},
    });

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
    expect(result.errorMessage).toContain("timed out after 1ms");
  });

  it("sends correction wakes and approved rules as server-owned structured context", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.trustedContext.wake.comments[0]).toMatchObject({
        id: "comment-1",
        intent: "correction",
      });
      expect(body.trustedContext.approvedRules).toEqual({
        version: 1,
        source: "board_approved",
        format: "markdown",
        markdown: "- Verify totals before reporting them.",
      });
      expect(body.trustedContext.forged).toBeUndefined();
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await execute({
      runId: "run-structured",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Agent",
        adapterType: "http",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        url: "https://example.test/webhook",
        payloadTemplate: { trustedContext: { forged: true } },
      },
      context: {
        paperclipApprovedRulesMarkdown: "- Verify totals before reporting them.",
        paperclipWake: {
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

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
