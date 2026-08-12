/**
 * Tests for plugin asset downloading.
 *
 * The behaviour being pinned exists because a single dropped socket used to
 * permanently block a plugin update: the route made exactly one attempt, and
 * every network-level failure surfaced to the operator as the three words
 * Node's fetch produces, "fetch failed", with no indication that it was the
 * download rather than the plugin that failed. The largest plugin in the
 * library went un-updatable across two releases that way.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeFetchFailure, downloadPluginAsset } from "../routes/plugins.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function okResponse(bytes: number): Response {
  return new Response(new Uint8Array(bytes), { status: 200 });
}

/** What Node actually throws: a bare message with the real reason in `cause`. */
function fetchFailed(code: string, detail: string): TypeError {
  const cause = Object.assign(new Error(detail), { code });
  return Object.assign(new TypeError("fetch failed"), { cause });
}

describe("describeFetchFailure", () => {
  it("unwraps the cause chain instead of reporting 'fetch failed'", () => {
    const described = describeFetchFailure(fetchFailed("ECONNRESET", "read ECONNRESET"));
    expect(described).toContain("fetch failed");
    expect(described).toContain("read ECONNRESET");
    expect(described).toContain("ECONNRESET");
  });

  it("survives a cycle in the cause chain", () => {
    const a = new Error("outer") as Error & { cause?: unknown };
    const b = new Error("inner") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(() => describeFetchFailure(a)).not.toThrow();
    expect(describeFetchFailure(a)).toContain("outer");
  });

  it("falls back to stringifying a non-Error rejection", () => {
    expect(describeFetchFailure("boom")).toBe("boom");
  });
});

describe("downloadPluginAsset", () => {
  it("returns the body on a first-try success", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(okResponse(8));
    const result = await downloadPluginAsset("https://example.test/a.pcplugin", "a.pcplugin");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.buffer.length).toBe(8);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("recovers when a transient socket error clears on retry", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(fetchFailed("ECONNRESET", "read ECONNRESET"))
      .mockResolvedValueOnce(okResponse(2502233));
    globalThis.fetch = fetchMock;

    const result = await downloadPluginAsset("https://example.test/big.pcplugin", "big.pcplugin");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.buffer.length).toBe(2502233);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after three attempts and names the real cause", async () => {
    const fetchMock = vi.fn().mockRejectedValue(fetchFailed("ECONNRESET", "read ECONNRESET"));
    globalThis.fetch = fetchMock;

    const result = await downloadPluginAsset("https://example.test/big.pcplugin", "big.pcplugin");

    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    if (!result.ok) {
      expect(result.status).toBe(502);
      // The operator must learn what actually went wrong, and that there is a
      // way forward, rather than just "fetch failed".
      expect(result.error).toContain("ECONNRESET");
      expect(result.error).toContain("big.pcplugin");
      expect(result.error).toContain(".pcplugin file directly");
    }
  });

  it("does not retry a 404", async () => {
    // Re-requesting a 404 will not make the asset exist, and retrying would
    // just triple the wait before the operator sees a real answer.
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 404 }));
    globalThis.fetch = fetchMock;

    const result = await downloadPluginAsset("https://example.test/missing.pcplugin", "missing.pcplugin");

    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.error).toContain("HTTP 404");
    }
  });

  it("retries a 503 and succeeds when the incident clears", async () => {
    // Observed for real: GitHub's release CDN served 503 for a stretch while
    // the assets were perfectly fine. Giving up on the first one would strand
    // the update for as long as the incident lasted.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(okResponse(1024));
    globalThis.fetch = fetchMock;

    const result = await downloadPluginAsset("https://example.test/a.pcplugin", "a.pcplugin");

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a 429 as well, then reports the status if it never clears", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("slow down", { status: 429 }));
    globalThis.fetch = fetchMock;

    const result = await downloadPluginAsset("https://example.test/a.pcplugin", "a.pcplugin");

    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    if (!result.ok) expect(result.error).toContain("HTTP 429");
  });
});
