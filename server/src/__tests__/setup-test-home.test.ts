import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePaperclipHomeDir } from "../home-paths.js";
import { resolveServerLogDir } from "../middleware/log-file-target.js";

describe("server test home", () => {
  const savedLogDir = process.env.PAPERCLIP_LOG_DIR;
  const savedConfig = process.env.PAPERCLIP_CONFIG;

  afterEach(() => {
    if (savedLogDir === undefined) delete process.env.PAPERCLIP_LOG_DIR;
    else process.env.PAPERCLIP_LOG_DIR = savedLogDir;
    if (savedConfig === undefined) delete process.env.PAPERCLIP_CONFIG;
    else process.env.PAPERCLIP_CONFIG = savedConfig;
  });

  it("is a throwaway folder, never the developer's own ~/.paperclip", () => {
    const home = resolvePaperclipHomeDir();
    expect(home).not.toBe(path.resolve(os.homedir(), ".paperclip"));
    expect(path.relative(path.resolve(os.tmpdir()), home).startsWith("..")).toBe(false);
  });

  it("sits in this run's folder, which the run removes when it finishes", () => {
    const runDir = process.env.PAPERCLIP_VITEST_RUN_DIR;
    expect(runDir).toBeTruthy();
    expect(path.relative(runDir!, resolvePaperclipHomeDir()).startsWith("..")).toBe(false);
  });

  it("holds the server log, so a test run never writes into a real instance's logs", () => {
    delete process.env.PAPERCLIP_LOG_DIR;
    delete process.env.PAPERCLIP_CONFIG;
    const logDir = resolveServerLogDir();
    expect(path.relative(resolvePaperclipHomeDir(), logDir).startsWith("..")).toBe(false);
  });
});
