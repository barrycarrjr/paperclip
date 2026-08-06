// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BULK_CONCURRENCY,
  isRateLimitError,
  runBulk,
  summarizeBulkRun,
} from "./bulk-run";

/** A promise you resolve by hand, so a test can hold work open. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("runBulk", () => {
  it("runs every item and says so", async () => {
    const seen: number[] = [];
    const result = await runBulk([1, 2, 3, 4, 5], async (n) => {
      seen.push(n);
    });

    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(result.succeeded).toHaveLength(5);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("never holds more than the cap in flight", async () => {
    let inFlight = 0;
    let highWater = 0;
    const gates = Array.from({ length: 9 }, () => deferred());

    const promise = runBulk(
      gates.map((_, index) => index),
      async (index) => {
        inFlight += 1;
        highWater = Math.max(highWater, inFlight);
        await gates[index]!.promise;
        inFlight -= 1;
      },
      { concurrency: 3 },
    );

    // Let the first wave start, then release everything.
    await Promise.resolve();
    for (const gate of gates) gate.resolve();
    await promise;

    expect(highWater).toBe(3);
  });

  it("keeps going after one item fails, and says which", async () => {
    const result = await runBulk([1, 2, 3], async (n) => {
      if (n === 2) throw new Error("nope");
    });

    expect(result.succeeded.sort()).toEqual([1, 3]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.item).toBe(2);
    expect((result.failed[0]!.error as Error).message).toBe("nope");
  });

  it("stops starting work when the far end says slow down", async () => {
    // One rate-limit error means the rest would fail the same way. Better to
    // stop and report than to produce forty identical failures.
    const attempted: number[] = [];
    const result = await runBulk(
      [1, 2, 3, 4, 5, 6, 7, 8],
      async (n) => {
        attempted.push(n);
        if (n === 1) throw new Error("[EHELP_SCOUT_RATE_LIMIT] retry after 12s");
      },
      { concurrency: 1 },
    );

    expect(result.stoppedForRateLimit).toBe(true);
    expect(attempted).toEqual([1]);
    expect(result.skipped).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it("does not stop for an ordinary failure", async () => {
    const result = await runBulk(
      [1, 2, 3],
      async (n) => {
        if (n === 1) throw new Error("[EINVALID_INPUT] nope");
      },
      { concurrency: 1 },
    );

    expect(result.stoppedForRateLimit).toBe(false);
    expect(result.succeeded).toEqual([2, 3]);
    expect(result.skipped).toEqual([]);
  });

  it("reports progress as each item settles", async () => {
    const onSettled = vi.fn();
    await runBulk(
      [1, 2],
      async (n) => {
        if (n === 2) throw new Error("bad");
      },
      { concurrency: 1, onSettled },
    );

    expect(onSettled).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenNthCalledWith(1, 1, null);
    expect(onSettled.mock.calls[1]![0]).toBe(2);
    expect(onSettled.mock.calls[1]![1]).toBeInstanceOf(Error);
  });

  it("stops starting work once aborted", async () => {
    const controller = new AbortController();
    const attempted: number[] = [];
    const result = await runBulk(
      [1, 2, 3, 4],
      async (n) => {
        attempted.push(n);
        if (n === 2) controller.abort();
      },
      { concurrency: 1, signal: controller.signal },
    );

    expect(attempted).toEqual([1, 2]);
    expect(result.skipped).toEqual([3, 4]);
  });

  it("handles an empty selection without calling anything", async () => {
    const run = vi.fn();
    const result = await runBulk([], run);
    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual({
      succeeded: [],
      failed: [],
      skipped: [],
      stoppedForRateLimit: false,
    });
  });

  it("defaults to a cap that fits the rate budget", () => {
    expect(DEFAULT_BULK_CONCURRENCY).toBe(3);
  });
});

describe("isRateLimitError", () => {
  it("recognises the plugin's bracketed code", () => {
    expect(isRateLimitError(new Error("[EHELP_SCOUT_RATE_LIMIT] retry after 12s"))).toBe(true);
  });

  it("does not mistake other worker failures for it", () => {
    // Everything comes back as HTTP 502, so only the message tells them apart.
    expect(isRateLimitError(new Error("[EINVALID_INPUT] conversationId is required"))).toBe(false);
    expect(isRateLimitError(new Error("[EDISABLED] change-status is disabled."))).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
  });
});

describe("summarizeBulkRun", () => {
  it("says plainly when everything worked", () => {
    const result = summarizeBulkRun(
      { succeeded: [1, 2, 3], failed: [], skipped: [], stoppedForRateLimit: false },
      "Closed",
    );
    expect(result.tone).toBe("success");
    expect(result.message).toBe("Closed 3 conversations.");
  });

  it("uses the singular for one", () => {
    const result = summarizeBulkRun(
      { succeeded: [1], failed: [], skipped: [], stoppedForRateLimit: false },
      "Closed",
    );
    expect(result.message).toBe("Closed 1 conversation.");
  });

  it("tells you how many landed before a rate limit stopped it", () => {
    const result = summarizeBulkRun(
      {
        succeeded: [1, 2],
        failed: [{ item: 3, error: new Error("[EHELP_SCOUT_RATE_LIMIT] retry after 5s") }],
        skipped: [4, 5],
        stoppedForRateLimit: true,
      },
      "Closed",
    );
    expect(result.tone).toBe("warning");
    expect(result.message).toContain("Closed 2");
    expect(result.message).toContain("3 left untouched");
  });

  it("does not claim partial success when nothing worked", () => {
    const result = summarizeBulkRun(
      { succeeded: [], failed: [{ item: 1, error: new Error("x") }], skipped: [], stoppedForRateLimit: false },
      "Closed",
    );
    expect(result.tone).toBe("error");
    expect(result.message).toBe("None of the 1 selected could be closed.");
  });

  it("reports a partial result as a warning, not a success", () => {
    const result = summarizeBulkRun(
      { succeeded: [1, 2], failed: [{ item: 3, error: new Error("x") }], skipped: [], stoppedForRateLimit: false },
      "Closed",
    );
    expect(result.tone).toBe("warning");
    expect(result.message).toBe("Closed 2. 1 failed.");
  });
});
