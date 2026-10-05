import { EventEmitter } from "node:events";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => ({
  ...await vi.importActual<typeof import("node:child_process")>("node:child_process"),
  spawn: vi.fn(),
  execFile: vi.fn(),
}));
vi.mock("node:fs", async () => ({
  ...await vi.importActual<typeof import("node:fs")>("node:fs"),
  readFileSync: vi.fn(), existsSync: vi.fn(), openSync: vi.fn(),
  mkdirSync: vi.fn(), closeSync: vi.fn(),
}));
vi.mock("../home-paths.js", async () => ({
  ...await vi.importActual<typeof import("../home-paths.js")>("../home-paths.js"),
  resolvePaperclipHomeDir: () => "/test-home",
}));
vi.mock("../middleware/logger.js", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("../services/check-for-updates.js", () => ({ checkForRemoteUpdate: vi.fn() }));

import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, openSync, closeSync } from "node:fs";
import { systemRoutes } from "../routes/system.js";
import { errorHandler } from "../middleware/error-handler.js";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

// The script's `--check` run: answer as bash would, then call back.
function preflightAnswers(error: (Error & { killed?: boolean }) | null, stderr = "") {
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    queueMicrotask(() => callback(error, "", stderr));
    return {};
  }) as any);
}
function app(admin = true) {
  const value = express();
  value.use((req, _res, next) => {
    req.actor = { type: "board", source: "session", isInstanceAdmin: admin, userId: "user-1" };
    next();
  });
  value.use("/api", systemRoutes());
  value.use(errorHandler);
  return value;
}

describe("installed Unix maintenance launchers", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
    vi.stubEnv("PAPERCLIP_MANAGED_INSTALL", "1");
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ repoPath: "/repo with spaces" }));
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(openSync).mockReturnValue(19);
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => child.emit("spawn"));
      return child as any;
    });
    preflightAnswers(null);
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", platformDescriptor);
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("launches the Unix updater as an argument and logs progress", async () => {
    const response = await request(app()).post("/api/system/update");
    expect(response.status).toBe(200);
    expect(spawn).toHaveBeenCalledWith("/bin/bash", [expect.stringMatching(/repo with spaces[\\/]scripts[\\/]launchers[\\/]unix[\\/]update-paperclip\.sh$/)], expect.objectContaining({ detached: true, stdio: ["ignore", 19, 19] }));
    expect(response.body.message).toContain("maintenance.log");
    expect(response.body.message).toContain("Terminal window");
    expect(closeSync).toHaveBeenCalledWith(19);
  });
  it("does not promise a Terminal window on Linux", async () => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
    const response = await request(app()).post("/api/system/rebuild");
    expect(response.status).toBe(200);
    expect(response.body.message).toContain("maintenance.log");
    expect(response.body.message).not.toContain("Terminal");
  });
  it("requires instance admin authority before starting a process", async () => {
    const response = await request(app(false)).post("/api/system/rebuild");
    expect(response.status).toBe(403);
    expect(spawn).not.toHaveBeenCalled();
  });
  it("requires a managed installation and leaves unmanaged servers running", async () => {
    vi.stubEnv("PAPERCLIP_MANAGED_INSTALL", "");
    const response = await request(app()).post("/api/system/update");
    expect(response.status).toBe(409);
    expect(spawn).not.toHaveBeenCalled();
  });
  it("reports asynchronous spawn failure without crashing or shutting down", async () => {
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => child.emit("error", new Error("bash unavailable")));
      return child as any;
    });
    const response = await request(app()).post("/api/system/rebuild");
    expect(response.status).toBe(500);
    expect(response.body.error).toContain("bash unavailable");
    expect(closeSync).toHaveBeenCalledWith(19);
  });

  // A refusal the detached run reached on its own never got back to the
  // browser, which had already been told the update started.
  it("shows the script's own refusal before anything is stopped", async () => {
    const reason = "The checkout has local changes. Commit or move them before updating.";
    preflightAnswers(Object.assign(new Error("Command failed"), { code: 1 }), `From github.com:x/y\n${reason}\n`);
    const response = await request(app()).post("/api/system/update");
    expect(response.status).toBe(409);
    expect(response.body.error).toBe(`${reason} Server is still running.`);
    expect(spawn).not.toHaveBeenCalled();
  });
  it("runs the checks without the log marker, so their reason can be read back", async () => {
    vi.stubEnv("PAPERCLIP_MAINTENANCE_LOG", "/somewhere/else.log");
    await request(app()).post("/api/system/rebuild");
    const [file, args, options] = vi.mocked(execFile).mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(file).toBe("/bin/bash");
    expect(args).toEqual([expect.stringMatching(/rebuild-paperclip\.sh$/), "--check"]);
    expect(options.env.PAPERCLIP_MAINTENANCE_LOG).toBeUndefined();
    expect(options.env.GIT_TERMINAL_PROMPT).toBe("0");
  });
  it("says so when the checks take too long, and starts nothing", async () => {
    preflightAnswers(Object.assign(new Error("timed out"), { killed: true }));
    const response = await request(app()).post("/api/system/update");
    expect(response.status).toBe(409);
    expect(response.body.error).toContain("did not finish");
    expect(spawn).not.toHaveBeenCalled();
  });
  it("tells the run where its output goes, which is also how it knows nobody is watching", async () => {
    await request(app()).post("/api/system/update");
    const options = vi.mocked(spawn).mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
    expect(options.env?.PAPERCLIP_MAINTENANCE_LOG).toMatch(/test-home[\\/]logs[\\/]maintenance\.log$/);
  });

  describe("restart", () => {
    let kill: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      // The route ends this process a moment after replying.
      kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    });
    afterEach(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      kill.mockRestore();
    });

    it("keeps the environment off the trampoline's command line and hands the log path down", async () => {
      vi.stubEnv("SOME_TOKEN", "secret-value-123");
      const response = await request(app()).post("/api/system/restart");
      expect(response.status).toBe(200);
      const [command, args, options] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
      expect(command).toBe(process.execPath);
      // Any local user can read a command line with `ps`.
      expect(args.join(" ")).not.toContain("secret-value-123");
      expect(args.join(" ")).toMatch(/restart-paperclip\.sh/);
      expect(options.env.SOME_TOKEN).toBe("secret-value-123");
      expect(options.env.PAPERCLIP_MAINTENANCE_LOG).toMatch(/test-home[\\/]logs[\\/]maintenance\.log$/);
    });
  });
});
