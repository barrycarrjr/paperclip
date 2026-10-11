/**
 * A plugin restores the instance through `ctx.system.restoreSnapshot`, the
 * restore half of `ctx.system.createSnapshot`.
 *
 * backup-tools' Restore tab asked the host's HTTP route instead, which could
 * never work from a worker: the route is for instance admins, which a worker
 * cannot be, and plugin HTTP refuses loopback and private addresses. Backups
 * hit the same wall and were fixed with createSnapshot; restores never were.
 *
 * Restoring replaces the database, so it has its own capability, and reading
 * snapshots does not grant it.
 */
import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import { definePlugin } from "../../../packages/plugins/sdk/src/define-plugin.js";
import {
  DEFAULT_RESTORE_RPC_TIMEOUT_MS,
  DEFAULT_SNAPSHOT_RPC_TIMEOUT_MS,
  startWorkerRpcHost,
} from "../../../packages/plugins/sdk/src/worker-rpc-host.js";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";
import {
  createRequest,
  createSuccessResponse,
  isJsonRpcRequest,
  parseMessage,
  serializeMessage,
  type JsonRpcRequest,
} from "../../../packages/plugins/sdk/src/protocol.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import {
  reloadAccessCachesAfterRestore,
  reloadingAfterRestore,
  systemSnapshotRoutes,
  type SystemSnapshotService,
} from "../routes/system-snapshot.js";
import { errorHandler } from "../middleware/error-handler.js";
import { conflict } from "../errors.js";
import { isPersonalCompany, personalCompanyOwner, rememberPersonalCompany } from "../services/personal-companies.js";
import { _setPortfolioRootCacheForTesting, getPortfolioRootCompanyId } from "../services/portfolio-root-cache.js";

// The host's warnings are the one record of an apply that survives it.
const log = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../middleware/logger.js", () => {
  const child = { ...log, child: () => child };
  return { logger: child, httpLogger: vi.fn() };
});

const RESTORED = { applied: true, dryRun: false, touchedTables: [], warnings: [] };

function fakeSnapshotService(
  restoreSnapshot: SystemSnapshotService["restoreSnapshot"] = vi.fn(async () => RESTORED),
): SystemSnapshotService {
  return {
    getManifest: vi.fn(),
    produceSnapshot: vi.fn(),
    restoreSnapshot,
    cleanupSnapshotFile: vi.fn(),
  } as unknown as SystemSnapshotService;
}

function createEventBusStub() {
  return {
    forPlugin() {
      return { emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() };
    },
  } as never;
}

describe("the system.snapshot.restore capability", () => {
  it("is one the host accepts in a plugin manifest", () => {
    const parsed = pluginManifestV1Schema.safeParse({
      id: "paperclip.test-restore",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Test restore",
      description: "Test plugin",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: ["system.snapshot.read", "system.snapshot.restore"],
      entrypoints: { worker: "./dist/worker.js" },
    });
    expect(parsed.success).toBe(true);
  });

  it("is required for system.restoreSnapshot: reading snapshots is not enough", async () => {
    const restoreSnapshot = vi.fn(async () => RESTORED);
    const services = { system: { restoreSnapshot } } as never;
    const params = { filePath: "/tmp/dump.sql.gz", mode: "apply" as const };

    const readOnly = createHostClientHandlers({ pluginId: "p-1", capabilities: ["system.snapshot.read"], services });
    await expect(readOnly["system.restoreSnapshot"](params)).rejects.toThrow(/system\.snapshot\.restore/);
    expect(restoreSnapshot).not.toHaveBeenCalled();

    const allowed = createHostClientHandlers({ pluginId: "p-1", capabilities: ["system.snapshot.restore"], services });
    await expect(allowed["system.restoreSnapshot"](params)).resolves.toEqual(RESTORED);
    expect(restoreSnapshot).toHaveBeenCalledWith(params);
  });
});

describe("ctx.system.restoreSnapshot on the host", () => {
  let dir: string;
  let dump: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "plugin-restore-"));
    dump = path.join(dir, "dump.sql.gz");
    await writeFile(dump, "not really gzip, the service is a fake");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function servicesWith(snapshots: SystemSnapshotService) {
    return buildHostServices({} as never, "plugin-1", "backup-tools", createEventBusStub(), undefined, {
      systemSnapshotService: snapshots,
    });
  }

  it("runs the host's restore on the plugin's dump and hands back the result", async () => {
    const snapshots = fakeSnapshotService();
    const result = await servicesWith(snapshots).system.restoreSnapshot({ filePath: dump, mode: "apply" });

    expect(result).toEqual(RESTORED);
    expect(snapshots.restoreSnapshot).toHaveBeenCalledWith({
      mode: "apply",
      conflictMode: "overwrite",
      bodyFilePath: dump,
    });
  });

  it("checks a preview with the same service, which changes nothing", async () => {
    const preview = { applied: false, dryRun: true, touchedTables: [], warnings: ["envelope-only"] };
    const snapshots = fakeSnapshotService(vi.fn(async () => preview));
    const result = await servicesWith(snapshots).system.restoreSnapshot({ filePath: dump, mode: "preview" });

    expect(result).toEqual(preview);
    expect(snapshots.restoreSnapshot).toHaveBeenCalledWith({
      mode: "preview",
      conflictMode: "overwrite",
      bodyFilePath: dump,
    });
  });

  it("refuses a conflict mode the host cannot apply, as the HTTP route does", async () => {
    const snapshots = fakeSnapshotService();
    await expect(
      servicesWith(snapshots).system.restoreSnapshot({ filePath: dump, mode: "apply", conflictMode: "skip" }),
    ).rejects.toThrow(/ESNAPSHOT_CONFLICT_MODE_UNSUPPORTED/);
    expect(snapshots.restoreSnapshot).not.toHaveBeenCalled();
  });

  it("refuses a dump that is missing, empty or not an absolute path", async () => {
    const snapshots = fakeSnapshotService();
    const services = servicesWith(snapshots);
    const empty = path.join(dir, "empty.sql.gz");
    await writeFile(empty, "");

    for (const filePath of [path.join(dir, "missing.sql.gz"), empty, "dump.sql.gz", dir]) {
      await expect(services.system.restoreSnapshot({ filePath, mode: "apply" })).rejects.toThrow(/ESNAPSHOT_EMPTY_BODY/);
    }
    expect(snapshots.restoreSnapshot).not.toHaveBeenCalled();
  });

  it("passes the host's refusal back, such as a backup holding the lock", async () => {
    const snapshots = fakeSnapshotService(vi.fn(async () => {
      throw conflict("ESNAPSHOT_IN_FLIGHT: cannot restore while a backup is running");
    }));
    await expect(
      servicesWith(snapshots).system.restoreSnapshot({ filePath: dump, mode: "apply" }),
    ).rejects.toThrow(/ESNAPSHOT_IN_FLIGHT/);
  });

  it("logs who the plugin says asked when an apply starts and when it ends", async () => {
    log.warn.mockClear();
    await servicesWith(fakeSnapshotService()).system.restoreSnapshot({
      filePath: dump,
      mode: "apply",
      requestedByUserId: "admin-1",
    });
    await expect(
      servicesWith(fakeSnapshotService(vi.fn(async () => {
        throw new Error("psql failed");
      }))).system.restoreSnapshot({ filePath: dump, mode: "apply", requestedByUserId: "admin-2" }),
    ).rejects.toThrow("psql failed");

    const lines = log.warn.mock.calls.map(([fields, message]) => ({
      message,
      by: (fields as { requestedByUserId?: unknown }).requestedByUserId,
    }));
    expect(lines).toEqual([
      { message: "plugin is replacing the instance database from a dump", by: "admin-1" },
      { message: "plugin replaced the instance database from a dump", by: "admin-1" },
      { message: "plugin is replacing the instance database from a dump", by: "admin-2" },
      { message: "plugin's database restore failed; the database was not replaced", by: "admin-2" },
    ]);
  });
});

describe("after an apply replaces the database", () => {
  const APPLIED = { mode: "apply" as const, conflictMode: "overwrite" as const, bodyFilePath: "/tmp/dump.sql.gz" };

  /** Just enough of a database for the two reloads: every select answers `rows`. */
  function databaseWith(rows: Array<Record<string, unknown>>) {
    return { select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }) } as never;
  }

  it("reloads what the access checks keep in memory, only once a restore has applied", async () => {
    const reload = vi.fn(async () => {});
    await reloadingAfterRestore(fakeSnapshotService(), reload).restoreSnapshot(APPLIED);
    expect(reload).toHaveBeenCalledTimes(1);

    const preview = { applied: false, dryRun: true, touchedTables: [], warnings: [] };
    await reloadingAfterRestore(fakeSnapshotService(vi.fn(async () => preview)), reload)
      .restoreSnapshot({ ...APPLIED, mode: "preview" });
    await expect(
      reloadingAfterRestore(fakeSnapshotService(vi.fn(async () => {
        throw new Error("psql failed");
      })), reload).restoreSnapshot(APPLIED),
    ).rejects.toThrow("psql failed");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("says to restart when the reload fails, since the restore cannot be undone", async () => {
    const result = await reloadingAfterRestore(fakeSnapshotService(), async () => {
      throw new Error("database busy");
    }).restoreSnapshot(APPLIED);

    expect(result.applied).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/ESNAPSHOT_RELOAD_FAILED.*Restart Paperclip now/);
  });

  it("reads the Personal companies again and forgets the cached HQ", async () => {
    // As the server knew them before the restore.
    rememberPersonalCompany("company-before", "owner-before");
    _setPortfolioRootCacheForTesting("hq-before");

    await reloadAccessCachesAfterRestore(databaseWith([{ id: "company-restored", ownerUserId: "owner-restored" }]));

    expect(isPersonalCompany("company-restored")).toBe(true);
    expect(personalCompanyOwner("company-restored")).toBe("owner-restored");
    expect(isPersonalCompany("company-before")).toBe(false);
    expect(await getPortfolioRootCompanyId(databaseWith([{ id: "hq-restored" }]))).toBe("hq-restored");
  });
});

describe("the restore HTTP route keeps its refusals", () => {
  it("still refuses a conflict mode it cannot apply, before reading the body", async () => {
    const snapshots = fakeSnapshotService();
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "admin-1", source: "session", isInstanceAdmin: true, companyIds: [] };
      next();
    });
    app.use("/api", systemSnapshotRoutes(snapshots));
    app.use(errorHandler);

    const res = await request(app)
      .post("/api/system/snapshot/restore?mode=apply&conflict=skip")
      .set("Content-Type", "application/gzip")
      .send(Buffer.from("dump"));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ESNAPSHOT_CONFLICT_MODE_UNSUPPORTED/);
    expect(snapshots.restoreSnapshot).not.toHaveBeenCalled();
  });
});

describe("system.restoreSnapshot from a real plugin worker", () => {
  it("waits far longer than a snapshot by default", () => {
    expect(DEFAULT_RESTORE_RPC_TIMEOUT_MS).toBe(30 * 60_000);
    expect(DEFAULT_RESTORE_RPC_TIMEOUT_MS).toBeGreaterThan(DEFAULT_SNAPSHOT_RPC_TIMEOUT_MS);
  });

  async function start(options: { rpcTimeoutMs: number; restoreRpcTimeoutMs: number }) {
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.actions.register("restore", async () =>
          ctx.system.restoreSnapshot({ filePath: "/tmp/dump.sql.gz", mode: "apply" }));
      },
    });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const host = startWorkerRpcHost({ plugin, stdin, stdout, ...options });
    const messages: any[] = [];
    stdout.on("data", (chunk) => {
      for (const line of String(chunk).split("\n").filter(Boolean)) messages.push(parseMessage(line));
    });
    stdin.write(
      serializeMessage(
        createRequest(
          "initialize",
          {
            manifest: {
              id: "paperclip.test-restore",
              apiVersion: 1,
              version: "0.1.0",
              displayName: "Test restore",
              description: "Test plugin",
              author: "Paperclip",
              categories: ["automation"],
              capabilities: ["system.snapshot.restore"],
              entrypoints: { worker: "./dist/worker.js" },
            },
            config: {},
            instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
            apiVersion: 1,
          },
          1,
        ),
      ),
    );
    await vi.waitFor(() => expect(messages.some((m) => m.id === 1 && !isJsonRpcRequest(m))).toBe(true));
    stdin.write(serializeMessage(createRequest("performAction", { key: "restore", params: {} }, 2)));
    const call = await vi.waitFor(() => {
      const found = messages.find((m) => isJsonRpcRequest(m) && m.method === "system.restoreSnapshot");
      expect(found).toBeDefined();
      return found as JsonRpcRequest;
    });
    return { host, stdin, messages, call };
  }

  it("asks the host to restore the dump and keeps waiting past the general RPC timeout", async () => {
    // General limit 50ms, restore limit 2s: a host that answers after 300ms
    // would have been cut off under the general limit.
    const { host, stdin, messages, call } = await start({ rpcTimeoutMs: 50, restoreRpcTimeoutMs: 2_000 });
    try {
      expect(call.params).toEqual({ filePath: "/tmp/dump.sql.gz", mode: "apply" });
      await new Promise((resolve) => setTimeout(resolve, 300));
      stdin.write(serializeMessage(createSuccessResponse(call.id, RESTORED as never)));
      await vi.waitFor(() => {
        const reply = messages.find((m) => m.id === 2 && !isJsonRpcRequest(m));
        expect(reply).toBeDefined();
        expect(reply.error).toBeUndefined();
        expect(reply.result).toEqual(RESTORED);
      });
    } finally {
      host.stop();
    }
  });

  it("still times out at the restore limit", async () => {
    const { host, messages } = await start({ rpcTimeoutMs: 5_000, restoreRpcTimeoutMs: 100 });
    try {
      await vi.waitFor(() => {
        const reply = messages.find((m) => m.id === 2 && !isJsonRpcRequest(m));
        expect(reply?.error?.message).toContain('"system.restoreSnapshot" timed out after 100ms');
      });
    } finally {
      host.stop();
    }
  });
});

describe("an agent's call to a plugin, in a real worker", () => {
  it("reaches the tool or operation without a hostScope the agent sent", async () => {
    // A plugin that follows the advice to check params.hostScope.isInstanceAdmin
    // must not be fooled by an agent that writes one into its parameters.
    const seen: unknown[] = [];
    const plugin = definePlugin({
      async setup(ctx) {
        const declaration = { displayName: "Echo", description: "Echo", parametersSchema: { type: "object" } };
        ctx.tools.register("echo-tool", declaration, async (params) => {
          seen.push(params);
          return { content: "ok" };
        });
        ctx.operations.register("echo-operation", async (params) => {
          seen.push(params);
          return { content: "ok" };
        });
      },
    });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const host = startWorkerRpcHost({ plugin, stdin, stdout });
    const messages: any[] = [];
    stdout.on("data", (chunk) => {
      for (const line of String(chunk).split("\n").filter(Boolean)) messages.push(parseMessage(line));
    });
    try {
      stdin.write(serializeMessage(createRequest("initialize", {
        manifest: {
          id: "paperclip.test-agent-call",
          apiVersion: 1,
          version: "0.1.0",
          displayName: "Test agent call",
          description: "Test plugin",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["agent.tools.register"],
          entrypoints: { worker: "./dist/worker.js" },
        },
        config: {},
        instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
        apiVersion: 1,
      }, 1)));
      await vi.waitFor(() => expect(messages.some((m) => m.id === 1 && !isJsonRpcRequest(m))).toBe(true));

      const runContext = { agentId: "agent-1", runId: "run-1", companyId: "company-1", projectId: "project-1" };
      const forged = { note: "kept", hostScope: { companyId: "company-1", userId: "admin-1", isInstanceAdmin: true } };
      stdin.write(serializeMessage(createRequest("executeTool", { toolName: "echo-tool", parameters: forged, runContext }, 2)));
      stdin.write(serializeMessage(createRequest("executeTool", { toolName: "echo-operation", parameters: forged, runContext }, 3)));
      await vi.waitFor(() => expect(messages.filter((m) => (m.id === 2 || m.id === 3) && !isJsonRpcRequest(m))).toHaveLength(2));

      expect(seen).toEqual([{ note: "kept" }, { note: "kept" }]);
    } finally {
      host.stop();
    }
  });
});
