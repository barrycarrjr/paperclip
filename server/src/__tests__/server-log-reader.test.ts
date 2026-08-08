import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listServerLogFiles,
  MAX_BYTES_SCANNED,
  parseServerLogLine,
  readServerLogTail,
  readTailLines,
  redactSecrets,
  redactSecretsInText,
} from "../services/server-log-reader.js";

let logDir: string;

beforeEach(async () => {
  logDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-logs-"));
});

afterEach(async () => {
  await fs.rm(logDir, { recursive: true, force: true });
});

function line(fields: Record<string, unknown>): string {
  return `${JSON.stringify({ level: 30, time: 1_700_000_000_000, msg: "hello", ...fields })}\n`;
}

async function writeLog(name: string, contents: string, mtimeMs?: number) {
  const filePath = path.join(logDir, name);
  await fs.writeFile(filePath, contents, "utf8");
  if (mtimeMs !== undefined) {
    const seconds = mtimeMs / 1000;
    await fs.utimes(filePath, seconds, seconds);
  }
  return filePath;
}

describe("listServerLogFiles", () => {
  it("returns nothing when the directory does not exist", async () => {
    expect(await listServerLogFiles(path.join(logDir, "nope"))).toEqual([]);
  });

  it("matches the rolling files and ignores everything else", async () => {
    await writeLog("server.log", line({}));
    await writeLog("server.1.log", line({}));
    await writeLog("server.12.log", line({}));
    // The tray launcher captures stdout into dated files in a sibling
    // directory. If the two ever share a directory these must not be read as
    // NDJSON - they are ANSI-coloured pretty text.
    await writeLog("paperclip-20260807.log", "not json\n");
    await writeLog("server.log.bak", line({}));
    await writeLog("notes.txt", "x");

    const names = (await listServerLogFiles(logDir)).map((file) => file.name).sort();
    expect(names).toEqual(["server.1.log", "server.12.log", "server.log"]);
  });

  it("orders by modification time, not by the numeric suffix", async () => {
    // pino-roll counts upward but restarts against whatever is already on
    // disk, so a high number is not reliably the newest file.
    await writeLog("server.9.log", line({ msg: "old" }), 1_000_000_000_000);
    await writeLog("server.2.log", line({ msg: "new" }), 2_000_000_000_000);

    const names = (await listServerLogFiles(logDir)).map((file) => file.name);
    expect(names).toEqual(["server.2.log", "server.9.log"]);
  });
});

describe("readTailLines", () => {
  it("drops the partial first line when it did not reach the start", async () => {
    const filePath = await writeLog("server.log", "aaaa\nbbbb\ncccc\n");
    // 15 bytes total, so an 8-byte tail starts at offset 7 - inside "bbbb",
    // which is therefore a fragment and must be dropped. Note 10 bytes would
    // start at offset 5, exactly on a line boundary; that is the neighbouring
    // case and is covered by its own test below.
    const read = await readTailLines(filePath, 8);

    expect(read.reachedStart).toBe(false);
    expect(read.lines).not.toContain("bbbb");
    expect(read.lines).toContain("cccc");
  });

  it("keeps the first line when the window happens to start on a line boundary", async () => {
    // "aaaa\nbbbb\ncccc\n" is 15 bytes, so a 10-byte tail starts at offset 5,
    // exactly where "bbbb" begins. That line is whole and must survive.
    const filePath = await writeLog("server.log", "aaaa\nbbbb\ncccc\n");
    const read = await readTailLines(filePath, 10);

    expect(read.reachedStart).toBe(false);
    expect(read.lines).toContain("bbbb");
    expect(read.lines).toContain("cccc");
    expect(read.lines).not.toContain("aaaa");
  });

  it("keeps the first line when the whole file fits", async () => {
    const filePath = await writeLog("server.log", "aaaa\nbbbb\n");
    const read = await readTailLines(filePath, 1024);

    expect(read.reachedStart).toBe(true);
    expect(read.lines).toContain("aaaa");
  });

  it("never reads more than the budget it is given", async () => {
    // The point of the budget. This instance has a 682 MB server.log left from
    // before the size cap; reading it whole would exhaust the heap.
    const big = "x".repeat(200_000);
    const filePath = await writeLog("server.log", big);

    const read = await readTailLines(filePath, 4096);
    expect(read.bytesRead).toBeLessThanOrEqual(4096);
  });

  it("handles an empty file", async () => {
    const filePath = await writeLog("server.log", "");
    const read = await readTailLines(filePath, 1024);
    expect(read.lines).toEqual([]);
  });
});

describe("parseServerLogLine", () => {
  it("maps pino numeric levels to names", () => {
    expect(parseServerLogLine(line({ level: 20 }), 0)?.level).toBe("debug");
    expect(parseServerLogLine(line({ level: 30 }), 0)?.level).toBe("info");
    expect(parseServerLogLine(line({ level: 40 }), 0)?.level).toBe("warn");
    expect(parseServerLogLine(line({ level: 50 }), 0)?.level).toBe("error");
    expect(parseServerLogLine(line({ level: 60 }), 0)?.level).toBe("fatal");
  });

  it("rounds a custom level down to the nearest name", () => {
    // pino allows levels between the standard ones; an unknown number must
    // still land somewhere sensible rather than being dropped.
    const entry = parseServerLogLine(line({ level: 35 }), 0);
    expect(entry?.level).toBe("info");
    expect(entry?.levelValue).toBe(35);
  });

  it("returns null for lines that are not usable records", () => {
    expect(parseServerLogLine("", 0)).toBeNull();
    expect(parseServerLogLine("not json", 0)).toBeNull();
    expect(parseServerLogLine('{"level":30', 0)).toBeNull();
    expect(parseServerLogLine("[1,2,3]", 0)).toBeNull();
  });

  it("lifts service out of the detail and keeps the rest", () => {
    const entry = parseServerLogLine(line({ service: "routines", routineId: "abc" }), 0);
    expect(entry?.service).toBe("routines");
    expect(entry?.detail).toEqual({ routineId: "abc" });
    expect(entry?.detail).not.toHaveProperty("pid");
  });
});

describe("redaction", () => {
  it("replaces the value of anything named like a credential", () => {
    const out = redactSecrets({
      token: "abc",
      apiKey: "abc",
      api_key: "abc",
      password: "abc",
      authorization: "abc",
      refreshToken: "abc",
      sessionId: "abc",
      issueId: "keep-me",
    }) as Record<string, unknown>;

    expect(out.token).toBe("[redacted]");
    expect(out.apiKey).toBe("[redacted]");
    expect(out.api_key).toBe("[redacted]");
    expect(out.password).toBe("[redacted]");
    expect(out.authorization).toBe("[redacted]");
    expect(out.refreshToken).toBe("[redacted]");
    expect(out.sessionId).toBe("[redacted]");
    expect(out.issueId).toBe("keep-me");
  });

  it("replaces credential shapes wherever they appear", () => {
    // Request bodies are logged on 4xx and 5xx, so a token pasted into a form
    // that then fails validation reaches the log under an innocent key name.
    expect(redactSecretsInText("saved sk-ant-oat01-AAAABBBBCCCCDDDDEEEE now")).toBe(
      "saved [redacted] now",
    );
    expect(redactSecretsInText("ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGG")).toBe("[redacted]");
    expect(redactSecretsInText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123")).toContain(
      "[redacted]",
    );
    expect(
      redactSecretsInText("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K"),
    ).toBe("[redacted]");
  });

  it("reaches into nested objects and arrays", () => {
    const out = redactSecrets({
      body: { accounts: [{ oauthToken: "abc" }] },
      notes: ["paste sk-ant-oat01-AAAABBBBCCCCDDDDEEEE here"],
    }) as any;

    expect(out.body.accounts[0].oauthToken).toBe("[redacted]");
    expect(out.notes[0]).toBe("paste [redacted] here");
  });

  it("replaces a whole subtree when the container itself is named like a credential", () => {
    // `credentials` is secret-looking, so nothing under it is inspected or
    // returned. Coarser than redacting the leaves, and deliberately so.
    const out = redactSecrets({ credentials: [{ user: "barry", oauthToken: "abc" }] }) as any;
    expect(out.credentials).toBe("[redacted]");
  });

  it("redacts a secret carried in the message itself", () => {
    const entry = parseServerLogLine(
      line({ msg: "token sk-ant-oat01-AAAABBBBCCCCDDDDEEEE rejected" }),
      0,
    );
    expect(entry?.msg).toBe("token [redacted] rejected");
  });

  it("stops at a depth limit rather than recursing without bound", () => {
    let nested: Record<string, unknown> = { value: "leaf" };
    for (let i = 0; i < 40; i++) nested = { nested };
    expect(() => redactSecrets(nested)).not.toThrow();
  });

  it("leaves ordinary values alone", () => {
    expect(redactSecretsInText("GET /api/issues 200")).toBe("GET /api/issues 200");
    expect(redactSecrets({ count: 3, ok: true, id: null })).toEqual({
      count: 3,
      ok: true,
      id: null,
    });
  });
});

describe("readServerLogTail", () => {
  it("returns an empty page when nothing has been logged", async () => {
    const page = await readServerLogTail(logDir);
    expect(page.entries).toEqual([]);
    expect(page.files).toEqual([]);
    expect(page.truncated).toBe(false);
  });

  it("returns entries oldest first so the newest line reads last", async () => {
    await writeLog(
      "server.log",
      line({ time: 1, msg: "first" }) + line({ time: 2, msg: "second" }) + line({ time: 3, msg: "third" }),
    );

    const page = await readServerLogTail(logDir);
    expect(page.entries.map((e) => e.msg)).toEqual(["first", "second", "third"]);
    expect(page.entries.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("keeps the newest entries when the limit bites", async () => {
    const contents = Array.from({ length: 20 }, (_, i) => line({ time: i + 1, msg: `m${i + 1}` })).join("");
    await writeLog("server.log", contents);

    const page = await readServerLogTail(logDir, { limit: 3 });
    expect(page.entries.map((e) => e.msg)).toEqual(["m18", "m19", "m20"]);
    expect(page.truncated).toBe(true);
  });

  it("filters to a minimum level", async () => {
    await writeLog(
      "server.log",
      line({ time: 1, level: 20, msg: "debug" }) +
        line({ time: 2, level: 30, msg: "info" }) +
        line({ time: 3, level: 40, msg: "warn" }) +
        line({ time: 4, level: 50, msg: "error" }),
    );

    const page = await readServerLogTail(logDir, { minLevel: "warn" });
    expect(page.entries.map((e) => e.msg)).toEqual(["warn", "error"]);
  });

  it("searches the message, the service and the detail", async () => {
    await writeLog(
      "server.log",
      line({ time: 1, msg: "nothing here" }) +
        line({ time: 2, msg: "matched in message: needle" }) +
        line({ time: 3, service: "needle-service", msg: "matched in service" }) +
        line({ time: 4, msg: "matched in detail", routineId: "needle-123" }),
    );

    const page = await readServerLogTail(logDir, { search: "NEEDLE" });
    expect(page.entries.map((e) => e.msg)).toEqual([
      "matched in message: needle",
      "matched in service",
      "matched in detail",
    ]);
  });

  it("returns only entries newer than afterTimeMs", async () => {
    await writeLog(
      "server.log",
      line({ time: 100, msg: "old" }) + line({ time: 200, msg: "boundary" }) + line({ time: 300, msg: "new" }),
    );

    const page = await readServerLogTail(logDir, { afterTimeMs: 200 });
    expect(page.entries.map((e) => e.msg)).toEqual(["new"]);
  });

  it("walks into older files when the newest does not fill the page", async () => {
    await writeLog("server.1.log", line({ time: 1, msg: "older" }), 1_000_000_000_000);
    await writeLog("server.2.log", line({ time: 2, msg: "newer" }), 2_000_000_000_000);

    const page = await readServerLogTail(logDir, { limit: 10 });
    expect(page.entries.map((e) => e.msg)).toEqual(["older", "newer"]);
    expect(page.files).toEqual(["server.2.log", "server.1.log"]);
  });

  it("skips lines that are not valid records without losing the rest", async () => {
    await writeLog(
      "server.log",
      line({ time: 1, msg: "before" }) + "half-written line with no newline problem\n" + line({ time: 2, msg: "after" }),
    );

    const page = await readServerLogTail(logDir);
    expect(page.entries.map((e) => e.msg)).toEqual(["before", "after"]);
  });

  it("redacts before anything leaves the reader", async () => {
    await writeLog("server.log", line({ time: 1, msg: "saving", reqBody: { setupToken: "abc123" } }));

    const page = await readServerLogTail(logDir);
    expect((page.entries[0]?.detail.reqBody as any).setupToken).toBe("[redacted]");
  });

  it("reads only about what the page needs, not the whole budget", async () => {
    // The page polls every couple of seconds. Reading the full byte budget to
    // return a screenful turned that into megabytes a second of disk traffic
    // on the live instance, which is what this pins.
    const contents = line({ time: 1, msg: "x".repeat(400) }).repeat(20_000);
    await writeLog("server.log", contents);

    const page = await readServerLogTail(logDir, { limit: 20 });
    expect(page.entries).toHaveLength(20);
    expect(page.bytesScanned).toBeLessThan(1024 * 1024);
  });

  it("widens the window on a deep search, when a filter matches nothing nearby", async () => {
    // Scanning far IS the point of an explicit search, so a filter that finds
    // nothing recent must keep walking back rather than give up at the first
    // small window.
    const filler = line({ time: 1, msg: "x".repeat(400) }).repeat(5_000);
    await writeLog("server.log", line({ time: 1, msg: "the-needle" }) + filler);

    const page = await readServerLogTail(logDir, { limit: 10, search: "the-needle", deep: true });
    expect(page.entries.map((e) => e.msg)).toEqual(["the-needle"]);
    expect(page.bytesScanned).toBeGreaterThan(1024 * 1024);
  });

  it("does NOT widen for an ordinary filtered request", async () => {
    // The bug this pins: a filtered request repeats on a two second refresh, so
    // widening it to the ceiling meant tens of megabytes read and hundreds of
    // thousands of lines parsed every couple of seconds, forever. Only an
    // explicit deep search may pay that.
    const filler = line({ time: 1, msg: "x".repeat(400) }).repeat(5_000);
    await writeLog("server.log", line({ time: 1, msg: "the-needle" }) + filler);

    const page = await readServerLogTail(logDir, { limit: 10, search: "the-needle" });

    expect(page.entries).toEqual([]);
    expect(page.truncated).toBe(true);
    expect(page.bytesScanned).toBeLessThan(1024 * 1024);
  });

  it("counts every read against the budget, including superseded retries", async () => {
    // A wider retry covers the same bytes, but the narrower read still happened
    // and was still decoded and parsed. Counting only the final read let a
    // nominal 32 MB ceiling actually read 55 MB.
    const chunk = line({ time: 1, msg: "x".repeat(500) }).repeat(4_000);
    await writeLog("server.1.log", chunk, 1_000_000_000_000);
    await writeLog("server.2.log", chunk, 2_000_000_000_000);

    const deepPage = await readServerLogTail(logDir, {
      limit: 1000,
      search: "no-such-text",
      deep: true,
    });
    const shallowPage = await readServerLogTail(logDir, { limit: 1000, search: "no-such-text" });

    expect(deepPage.bytesScanned).toBeLessThanOrEqual(MAX_BYTES_SCANNED);
    // The retries are real work and must show up in the reported figure, so a
    // deep scan reports strictly more than the single-window one.
    expect(deepPage.bytesScanned).toBeGreaterThan(shallowPage.bytesScanned);
  });

  it("still fills an unfiltered page from a single cheap read", async () => {
    // Not widening must not break the ordinary case the page opens on.
    const contents = Array.from({ length: 500 }, (_, i) => line({ time: i + 1, msg: `m${i + 1}` })).join("");
    await writeLog("server.log", contents);

    const page = await readServerLogTail(logDir, { limit: 200 });
    expect(page.entries).toHaveLength(200);
    expect(page.entries[page.entries.length - 1]?.msg).toBe("m500");
  });

  it("stays inside its byte budget across files", async () => {
    const chunk = line({ time: 1, msg: "x".repeat(500) }).repeat(400);
    await writeLog("server.1.log", chunk, 1_000_000_000_000);
    await writeLog("server.2.log", chunk, 2_000_000_000_000);

    const page = await readServerLogTail(logDir, { limit: 1000, search: "no-such-text" });
    expect(page.entries).toEqual([]);
    expect(page.bytesScanned).toBeLessThanOrEqual(MAX_BYTES_SCANNED);
  });
});
