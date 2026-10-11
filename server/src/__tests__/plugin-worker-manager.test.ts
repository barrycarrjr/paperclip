import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SNAPSHOT_RPC_TIMEOUT_ENV } from "../../../packages/plugins/sdk/src/worker-rpc-host.js";
import {
  appendStderrExcerpt,
  createPluginWorkerHandle,
  formatWorkerFailureMessage,
} from "../services/plugin-worker-manager.js";

describe("plugin-worker-manager stderr failure context", () => {
  it("appends worker stderr context to failure messages", () => {
    expect(
      formatWorkerFailureMessage(
        "Worker process exited (code=1, signal=null)",
        "TypeError: Unknown file extension \".ts\"",
      ),
    ).toBe(
      "Worker process exited (code=1, signal=null)\n\nWorker stderr:\nTypeError: Unknown file extension \".ts\"",
    );
  });

  it("does not duplicate stderr that is already present", () => {
    const message = [
      "Worker process exited (code=1, signal=null)",
      "",
      "Worker stderr:",
      "TypeError: Unknown file extension \".ts\"",
    ].join("\n");

    expect(
      formatWorkerFailureMessage(message, "TypeError: Unknown file extension \".ts\""),
    ).toBe(message);
  });

  it("keeps only the latest stderr excerpt", () => {
    let excerpt = "";
    excerpt = appendStderrExcerpt(excerpt, "first line");
    excerpt = appendStderrExcerpt(excerpt, "second line");

    expect(excerpt).toContain("first line");
    expect(excerpt).toContain("second line");

    excerpt = appendStderrExcerpt(excerpt, "x".repeat(9_000));

    expect(excerpt).not.toContain("first line");
    expect(excerpt).not.toContain("second line");
    expect(excerpt.length).toBeLessThanOrEqual(8_000);
  });
});

// A stand-in worker that answers initialize, reports two variables from its
// own environment through health, and exits on shutdown.
const ENV_REPORTING_WORKER = `
import { createInterface } from "node:readline";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, { ok: true, supportedMethods: [] });
  if (message.method === "health") {
    reply(message.id, {
      status: "ok",
      details: {
        snapshotTimeout: process.env.${SNAPSHOT_RPC_TIMEOUT_ENV} ?? null,
        hostSecret: process.env.PAPERCLIP_TEST_HOST_SECRET ?? null,
      },
    });
  }
  if (message.method === "shutdown") {
    reply(message.id, null);
    setImmediate(() => process.exit(0));
  }
});
`;

describe("plugin-worker-manager worker environment", () => {
  it("passes the snapshot timeout override to the worker and still keeps other host variables out", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-worker-env-"));
    const entrypointPath = path.join(dir, "worker.mjs");
    await writeFile(entrypointPath, ENV_REPORTING_WORKER);
    const saved = {
      snapshotTimeout: process.env[SNAPSHOT_RPC_TIMEOUT_ENV],
      hostSecret: process.env.PAPERCLIP_TEST_HOST_SECRET,
    };
    process.env[SNAPSHOT_RPC_TIMEOUT_ENV] = "300000";
    process.env.PAPERCLIP_TEST_HOST_SECRET = "must-not-reach-the-worker";

    const handle = createPluginWorkerHandle("env-test", {
      entrypointPath,
      manifest: { id: "env-test" } as never,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: {},
      autoRestart: false,
    });
    try {
      await handle.start();
      const health = await handle.call("health", {});
      expect(health.details).toEqual({ snapshotTimeout: "300000", hostSecret: null });
    } finally {
      await handle.stop();
      if (saved.snapshotTimeout === undefined) delete process.env[SNAPSHOT_RPC_TIMEOUT_ENV];
      else process.env[SNAPSHOT_RPC_TIMEOUT_ENV] = saved.snapshotTimeout;
      if (saved.hostSecret === undefined) delete process.env.PAPERCLIP_TEST_HOST_SECRET;
      else process.env.PAPERCLIP_TEST_HOST_SECRET = saved.hostSecret;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
