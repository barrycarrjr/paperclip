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
import { systemSnapshotRoutes, type SystemSnapshotService } from "../routes/system-snapshot.js";
import { errorHandler } from "../middleware/error-handler.js";
import { conflict } from "../errors.js";

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
