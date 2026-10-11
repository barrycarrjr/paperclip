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
});
