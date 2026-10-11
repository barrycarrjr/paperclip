import { describe, expect, it } from "vitest";
import { failedRequestLogProps } from "../middleware/http-log-props.js";
import { redactSensitive, stripSecretBearingUrlParts } from "../middleware/redact-sensitive.js";

// A stage's env as Pipeline Settings saves it: one plain value, one secret
// reference. A failed save (a 409 for an older revision, a 422) logs the body.
const stageEnvBody = {
  env: {
    OPENAI_API_KEY: { type: "plain", value: "sk-live-PLAIN-VALUE" },
    DATABASE_URL: { type: "secret_ref", secretId: "8d5c0d2e-0000-4000-8000-000000000001", version: "latest" },
  },
  baseRoutineRevisionId: "rev-1",
};

describe("failedRequestLogProps", () => {
  it("keeps env values out of a failed request's error context and keeps the rest", () => {
    const props = failedRequestLogProps({}, {
      __errorContext: {
        error: { message: "Stage automation routine was updated by someone else" },
        reqBody: stageEnvBody,
        reqParams: { id: "pipeline-1", stageId: "stage-1" },
        reqQuery: {},
      },
    });
    const line = JSON.stringify(props);

    expect(line).not.toContain("sk-live-PLAIN-VALUE");
    expect(line).toContain("OPENAI_API_KEY");
    expect(line).toContain("secret_ref");
    expect(line).toContain("updated by someone else");
    expect(line).toContain("stage-1");
  });

  it("keeps env values out when the error handler attached no context", () => {
    const props = failedRequestLogProps(
      {
        body: stageEnvBody,
        params: { id: "pipeline-1" },
        query: { token: "query-TOKEN" },
        route: { path: "/pipelines/:id/stages/:stageId/automation-env" },
      },
      {},
    );
    const line = JSON.stringify(props);

    expect(line).not.toContain("sk-live-PLAIN-VALUE");
    expect(line).not.toContain("query-TOKEN");
    expect(line).toContain("OPENAI_API_KEY");
    expect(props.routePath).toBe("/pipelines/:id/stages/:stageId/automation-env");
  });
});

describe("a refused restore request", () => {
  // A backup's passphrase, or the instance key pasted in its place. Any
  // refusal is logged: the bridge answers 502 to a worker refusal and the
  // restore API answers 400 or 409.
  const PASSPHRASE = "pasted-instance-key-0123456789abcdef";

  it("keeps the passphrase out of a page action's failed line", () => {
    const props = failedRequestLogProps(
      {
        body: {
          companyId: "company-1",
          params: { destinationId: "local-1", archiveKey: "20261009T030700-a.pcback", passphrase: PASSPHRASE },
        },
        params: { pluginId: "backup-tools", key: "restore.preview" },
      },
      {},
    );
    const line = JSON.stringify(props);

    expect(line).not.toContain(PASSPHRASE);
    expect(line).toContain("20261009T030700-a.pcback");
  });

  it("keeps the passphrase out of a restore API call's failed line", () => {
    const props = failedRequestLogProps({}, {
      __errorContext: {
        error: { message: "a restore is already running" },
        reqBody: { destinationId: "local-1", archiveKey: "a.pcback", passphrase: PASSPHRASE },
        reqParams: {},
        reqQuery: { companyId: "company-1" },
      },
    });

    expect(JSON.stringify(props)).not.toContain(PASSPHRASE);
  });
});

describe("redactSensitive", () => {
  it("matches sensitive keys in any letter case and at any depth", () => {
    const out = JSON.stringify(
      redactSensitive({
        apiKey: "k1",
        nested: { list: [{ Password: "p1" }, { client_secret: "c1" }] },
        name: "kept",
      }),
    );
    expect(out).not.toContain("k1");
    expect(out).not.toContain("p1");
    expect(out).not.toContain("c1");
    expect(out).toContain("kept");
  });

  it("drops the query string, fragment and sign-in part of an address", () => {
    expect(stripSecretBearingUrlParts("https://user:pw@example.com/hook?sig=abc#frag")).toBe(
      "https://example.com/hook",
    );
    expect(redactSensitive({ url: "/api/x?token=abc" })).toEqual({ url: "/api/x" });
  });

  it("stops at a fixed depth instead of following a deep payload", () => {
    let deep: Record<string, unknown> = { leaf: "bottom" };
    for (let i = 0; i < 10; i += 1) deep = { next: deep };
    expect(JSON.stringify(redactSensitive(deep))).not.toContain("bottom");
  });

  it("logs a binary body as its size, never byte by byte", () => {
    // A refused upload read with express.raw. Walked as an object, a Buffer
    // gave one key per byte, and a 45 MB one ran the server out of memory.
    const upload = Buffer.alloc(5 * 1024 * 1024, 7);
    const started = performance.now();

    expect(redactSensitive(upload)).toBe(`[binary, ${upload.byteLength} bytes]`);
    expect(redactSensitive({ file: new Uint8Array(3) })).toEqual({ file: "[binary, 3 bytes]" });
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("keeps a refused binary upload's log line small", () => {
    const props = failedRequestLogProps({ body: Buffer.alloc(1024 * 1024, 1), route: { path: "/plugins/install-file" } }, {});

    expect(props.reqBody).toBe("[binary, 1048576 bytes]");
    expect(JSON.stringify(props).length).toBeLessThan(200);
  });
});
