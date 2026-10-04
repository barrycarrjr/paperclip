import { EventEmitter } from "node:events";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => ({
  ...await vi.importActual<typeof import("node:child_process")>("node:child_process"),
  spawn: vi.fn(),
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

import { spawn } from "node:child_process";
import { existsSync, readFileSync, openSync, closeSync } from "node:fs";
import { systemRoutes } from "../routes/system.js";
import { errorHandler } from "../middleware/error-handler.js";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
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
    expect(closeSync).toHaveBeenCalledWith(19);
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
});
