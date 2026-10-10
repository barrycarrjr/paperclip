import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { definePlugin } from "../../../packages/plugins/sdk/src/define-plugin.js";
import {
  DEFAULT_SNAPSHOT_RPC_TIMEOUT_MS,
  SNAPSHOT_RPC_TIMEOUT_ENV,
  resolveSnapshotRpcTimeoutMs,
  startWorkerRpcHost,
} from "../../../packages/plugins/sdk/src/worker-rpc-host.js";
import {
  createRequest,
  createSuccessResponse,
  isJsonRpcRequest,
  parseMessage,
  serializeMessage,
  type JsonRpcRequest,
} from "../../../packages/plugins/sdk/src/protocol.js";

describe("resolveSnapshotRpcTimeoutMs", () => {
  it("defaults to 120s, well above the 30s general limit", () => {
    expect(DEFAULT_SNAPSHOT_RPC_TIMEOUT_MS).toBe(120_000);
    expect(resolveSnapshotRpcTimeoutMs(undefined, {})).toBe(120_000);
  });

  it("reads the environment variable and ignores junk values", () => {
    expect(resolveSnapshotRpcTimeoutMs(undefined, { [SNAPSHOT_RPC_TIMEOUT_ENV]: "300000" })).toBe(300_000);
    expect(resolveSnapshotRpcTimeoutMs(undefined, { [SNAPSHOT_RPC_TIMEOUT_ENV]: "abc" })).toBe(120_000);
    expect(resolveSnapshotRpcTimeoutMs(undefined, { [SNAPSHOT_RPC_TIMEOUT_ENV]: "-5" })).toBe(120_000);
  });

  it("prefers an explicit option over the environment", () => {
    expect(resolveSnapshotRpcTimeoutMs(5_000, { [SNAPSHOT_RPC_TIMEOUT_ENV]: "300000" })).toBe(5_000);
  });
});

describe("system.createSnapshot from a real plugin worker", () => {
  async function start(options: { rpcTimeoutMs: number; snapshotRpcTimeoutMs: number }) {
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.actions.register("snap", async () => ctx.system.createSnapshot());
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
              id: "paperclip.test-snapshot",
              apiVersion: 1,
              version: "0.1.0",
              displayName: "Test snapshot",
              description: "Test plugin",
              author: "Paperclip",
              categories: ["automation"],
              capabilities: ["system.snapshot.read"],
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
    stdin.write(serializeMessage(createRequest("performAction", { key: "snap", params: {} }, 2)));
    const call = await vi.waitFor(() => {
      const found = messages.find((m) => isJsonRpcRequest(m) && m.method === "system.createSnapshot");
      expect(found).toBeDefined();
      return found as JsonRpcRequest;
    });
    return { host, stdin, messages, call };
  }

  it("keeps waiting past the general RPC timeout", async () => {
    // General limit 50ms, snapshot limit 2s: a host that answers after 300ms
    // would have been cut off under the old single limit.
    const { host, stdin, messages, call } = await start({ rpcTimeoutMs: 50, snapshotRpcTimeoutMs: 2_000 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      stdin.write(serializeMessage(createSuccessResponse(call.id, { filePath: "/tmp/snap.tar", sizeBytes: 1 } as never)));
      await vi.waitFor(() => {
        const reply = messages.find((m) => m.id === 2 && !isJsonRpcRequest(m));
        expect(reply).toBeDefined();
        expect(reply.error).toBeUndefined();
      });
    } finally {
      host.stop();
    }
  });

  it("still times out at the snapshot limit", async () => {
    const { host, messages } = await start({ rpcTimeoutMs: 5_000, snapshotRpcTimeoutMs: 100 });
    try {
      await vi.waitFor(() => {
        const reply = messages.find((m) => m.id === 2 && !isJsonRpcRequest(m));
        expect(reply?.error?.message).toContain('"system.createSnapshot" timed out after 100ms');
      });
    } finally {
      host.stop();
    }
  });
});
