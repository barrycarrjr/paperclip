import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * One folder per test run holds every test file's throwaway home (see
 * setup-test-home.ts). Vitest stops its test workers without a normal exit,
 * so a test file cannot remove its own home; the run removes the whole folder
 * when it finishes instead.
 */
export function setup(): () => void {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-vitest-run-"));
  process.env.PAPERCLIP_VITEST_RUN_DIR = runDir;
  return () => {
    try {
      fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    } catch (err) {
      console.warn(`[vitest] could not remove test homes in ${runDir}: ${String(err)}`);
    }
  };
}
