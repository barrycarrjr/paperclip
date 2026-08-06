// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { invalidateAttention } from "./invalidate-attention";

function fakeClient() {
  const calls: unknown[][] = [];
  return {
    calls,
    client: {
      invalidateQueries: vi.fn((arg: { queryKey: unknown[] }) => {
        calls.push(arg.queryKey);
      }),
    } as never,
  };
}

describe("invalidateAttention", () => {
  it("refreshes the company queue, the portfolio roll-up and the badge together", () => {
    const { calls, client } = fakeClient();
    invalidateAttention(client, "c-1");
    expect(calls).toEqual([
      ["attention", "c-1"],
      ["portfolio-attention"],
      ["sidebar-badges", "c-1"],
    ]);
  });

  it("invalidates the portfolio roll-up by prefix, because it is keyed by HQ", () => {
    // The action happens in an operating company, but the roll-up that has to
    // change is cached under the HQ company's id.
    const { calls, client } = fakeClient();
    invalidateAttention(client, "operating-co");
    expect(calls).toContainEqual(["portfolio-attention"]);
  });

  it("does nothing without a company", () => {
    const { calls, client } = fakeClient();
    invalidateAttention(client, null);
    invalidateAttention(client, undefined);
    invalidateAttention(client, "");
    expect(calls).toEqual([]);
  });
});
