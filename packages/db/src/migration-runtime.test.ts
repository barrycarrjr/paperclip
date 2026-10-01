import { afterEach, describe, expect, it, vi } from "vitest";
import { exitMigrationScript } from "./migration-runtime.js";

describe("exitMigrationScript", () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
  });

  it("keeps the exit code and forces the exit when something holds the process open", () => {
    // A postgres worker that outlived the stop held the script's pipes open,
    // and the update waiting on the script hung on 2026-09-30.
    vi.useFakeTimers();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    exitMigrationScript(1);
    expect(process.exitCode).toBe(1);
    expect(exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
