import { describe, expect, it } from "vitest";
import {
  createEmbeddedPostgresLogBuffer,
  formatEmbeddedPostgresError,
  isStaleEmbeddedPostgresCluster,
} from "./embedded-postgres-error.js";

describe("formatEmbeddedPostgresError", () => {
  it("adds a shared-memory hint when initdb logs expose the real cause", () => {
    const error = formatEmbeddedPostgresError("Postgres init script exited with code 1.", {
      fallbackMessage: "Failed to initialize embedded PostgreSQL cluster",
      recentLogs: [
        "running bootstrap script ...",
        "FATAL:  could not create shared memory segment: Cannot allocate memory",
        "DETAIL:  Failed system call was shmget(key=123, size=56, 03600).",
      ],
    });

    expect(error.message).toContain("could not allocate shared memory");
    expect(error.message).toContain("kern.sysv.shm");
    expect(error.message).toContain("could not create shared memory segment");
  });

  it("recognises a cluster still held by the last run's processes", () => {
    expect(
      isStaleEmbeddedPostgresCluster(new Error("Failed to start embedded PostgreSQL"), [
        "FATAL:  pre-existing shared memory block is still in use",
        'HINT:  Terminate any old server processes associated with data directory "C:/Users/b/.paperclip/instances/default/db".',
      ]),
    ).toBe(true);
  });

  it("reads the reason off the error itself when nothing was logged", () => {
    // embedded-postgres rejects with no value at all on some paths, so the
    // reason can arrive either way round.
    expect(
      isStaleEmbeddedPostgresCluster("pre-existing shared memory block is still in use"),
    ).toBe(true);
  });

  it("does not call any other start failure stale", () => {
    // This decision force-kills processes, so everything else has to be a no.
    for (const log of [
      "FATAL:  could not create shared memory segment: Cannot allocate memory",
      'FATAL:  could not bind IPv4 address "127.0.0.1": Address already in use',
      "FATAL:  data directory has wrong ownership",
      "PANIC:  could not locate a valid checkpoint record",
    ]) {
      expect(isStaleEmbeddedPostgresCluster(new Error("start failed"), [log])).toBe(false);
    }
  });

  it("keeps only recent non-empty log lines in the collector", () => {
    const buffer = createEmbeddedPostgresLogBuffer(2);
    buffer.append("line one\n\n");
    buffer.append("line two");
    buffer.append("line three");

    expect(buffer.getRecentLogs()).toEqual(["line two", "line three"]);
  });
});
