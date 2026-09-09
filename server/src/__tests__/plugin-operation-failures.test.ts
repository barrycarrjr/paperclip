/**
 * Structured failures — telling "try again later" apart from "a person has to
 * reconnect the account".
 *
 * A failure used to be a bare string, so an agent had no way to choose between
 * retrying, changing its input, and giving up and telling the user. These
 * tests pin the code list, the guidance each code produces, and the rule that
 * `error` and `failure` always agree so no existing caller changes behaviour.
 *
 * @see PLUGIN_SPEC.md §11.6 — Operation failures
 */

import { describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  PLUGIN_OPERATION_ERROR_CODES,
  describeOperationFailure,
  isPluginOperationFailure,
  isRetryableOperationError,
  operationErrorNeedsPerson,
} from "@paperclipai/shared";
import { createTestHarness } from "../../../packages/plugins/sdk/src/testing.js";
import {
  OperationFailed,
  operationFailure,
} from "../../../packages/plugins/sdk/src/types.js";
import { createPluginToolRegistry } from "../services/plugin-tool-registry.js";

function manifest(overrides: Partial<PaperclipPluginManifestV1> = {}): PaperclipPluginManifestV1 {
  return {
    id: "paperclip.test-failures",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Test Failures",
    description: "Test plugin",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["agent.tools.register", "ui.action.register"],
    entrypoints: { worker: "./dist/worker.js" },
    operations: [{
      key: "sync",
      displayName: "Sync",
      description: "Sync with the connected account.",
      parametersSchema: { type: "object" },
    }],
    ...overrides,
  };
}

describe("operation failure vocabulary", () => {
  it("classifies every code as retryable or not, with no gaps", () => {
    // A code nobody classified would silently read as "do not retry", which is
    // the wrong default for an outage.
    const retryable = PLUGIN_OPERATION_ERROR_CODES.filter(isRetryableOperationError);
    expect(retryable).toEqual(["unavailable", "timeout"]);
  });

  it("names the codes only a person can clear", () => {
    const needsPerson = PLUGIN_OPERATION_ERROR_CODES.filter(operationErrorNeedsPerson);
    expect(needsPerson).toEqual(["not_authorized", "needs_reconnect"].sort((a, b) =>
      PLUGIN_OPERATION_ERROR_CODES.indexOf(a as never)
      - PLUGIN_OPERATION_ERROR_CODES.indexOf(b as never)));
  });

  it("gives every code its own instruction", () => {
    const sentences = PLUGIN_OPERATION_ERROR_CODES.map((code) =>
      describeOperationFailure({ code, message: "Upstream said no." }));

    // Every code says something, and no two say the same thing — otherwise the
    // distinction the code draws is invisible to the agent reading it.
    expect(new Set(sentences).size).toBe(PLUGIN_OPERATION_ERROR_CODES.length);
    for (const sentence of sentences) {
      expect(sentence.startsWith("Upstream said no.")).toBe(true);
    }
  });

  it("tells a retryable failure apart from a hopeless one in the text itself", () => {
    const outage = describeOperationFailure({
      code: "unavailable",
      message: "Help Scout returned 503.",
    });
    const expired = describeOperationFailure({
      code: "needs_reconnect",
      message: "Help Scout returned 401.",
    });

    expect(outage).toContain("safe to try again later");
    expect(expired).toContain("Do not retry");
    expect(expired).toContain("reconnected by a person");
  });

  it("passes on a wait time only when waiting could help", () => {
    expect(describeOperationFailure({
      code: "unavailable",
      message: "Rate limited.",
      retryAfterMs: 30_000,
    })).toContain("Wait about 30 seconds first.");

    // A retry-after on a permanent failure is noise; repeating it would invite
    // a retry the code has just ruled out.
    expect(describeOperationFailure({
      code: "not_authorized",
      message: "Nope.",
      retryAfterMs: 30_000,
    })).not.toContain("Wait about");
  });

  it("falls back to the plain message for a plugin with no codes", () => {
    expect(describeOperationFailure(undefined, "Something broke.")).toBe("Something broke.");
  });

  it("refuses a failure shape it does not recognise", () => {
    expect(isPluginOperationFailure(
      { code: "kaput", message: "x" },
      PLUGIN_OPERATION_ERROR_CODES,
    )).toBe(false);
    expect(isPluginOperationFailure(
      { code: "unavailable" },
      PLUGIN_OPERATION_ERROR_CODES,
    )).toBe(false);
    expect(isPluginOperationFailure(
      { code: "unavailable", message: "busy" },
      PLUGIN_OPERATION_ERROR_CODES,
    )).toBe(true);
  });
});

describe("failures from a plugin handler", () => {
  it("fills in the plain error string when a handler returns a code", async () => {
    const harness = createTestHarness({ manifest: manifest() });
    harness.ctx.operations.register("sync", async () =>
      operationFailure("needs_reconnect", "The Help Scout token was revoked."));

    const result = await harness.executeTool("sync", {});

    // Every existing caller in the host reads `error`. A result carrying only
    // a code would look like a success to all of them.
    expect(result.error).toBe("The Help Scout token was revoked.");
    expect(result.failure).toEqual({
      code: "needs_reconnect",
      message: "The Help Scout token was revoked.",
    });
  });

  it("fills in a code when a handler returns only a plain error string", async () => {
    const harness = createTestHarness({ manifest: manifest() });
    harness.ctx.operations.register("sync", async () => ({ error: "It broke." }));

    const result = await harness.executeTool("sync", {});

    // "failed" is the honest reading of an uncoded error: we do not know
    // whether retrying would help, so we must not imply that it would.
    expect(result.failure).toEqual({ code: "failed", message: "It broke." });
  });

  it("converts a thrown OperationFailed into the same result", async () => {
    const harness = createTestHarness({ manifest: manifest() });
    harness.ctx.operations.register("sync", async () => {
      throw new OperationFailed("unavailable", "Upstream is down.", { retryAfterMs: 5_000 });
    });

    const result = await harness.executeTool("sync", {});

    expect(result.error).toBe("Upstream is down.");
    expect(result.failure).toEqual({
      code: "unavailable",
      message: "Upstream is down.",
      retryAfterMs: 5_000,
    });
  });

  it("lets an unrecognised exception through instead of dressing it as a failure", async () => {
    const harness = createTestHarness({ manifest: manifest() });
    harness.ctx.operations.register("sync", async () => {
      throw new TypeError("cannot read property of undefined");
    });

    // A crash is not a failure with a known cause. Turning it into a tidy
    // `failed` result would hide a bug behind a plausible-looking answer.
    await expect(harness.executeTool("sync", {})).rejects.toThrow(TypeError);
  });

  it("carries a failure through the UI lane too", async () => {
    const harness = createTestHarness({ manifest: manifest() });
    harness.ctx.operations.register("sync", async () =>
      operationFailure("not_found", "No mailbox configured."));

    const result = await harness.performAction<{ failure?: { code: string } }>("sync", {
      hostScope: { companyId: "co-1", userId: "user-1" },
    });

    expect(result.failure?.code).toBe("not_found");
  });

  it("leaves a successful result alone", async () => {
    const harness = createTestHarness({ manifest: manifest() });
    harness.ctx.operations.register("sync", async () => ({ content: "done", data: { n: 1 } }));

    const result = await harness.executeTool("sync", {});

    expect(result).toEqual({ content: "done", data: { n: 1 } });
    expect(result.failure).toBeUndefined();
  });
});

describe("host-side normalisation of worker results", () => {
  function registryWithResult(result: unknown) {
    const workerManager = {
      isRunning: () => true,
      call: async () => result,
    };
    const registry = createPluginToolRegistry(workerManager as never);
    registry.registerPlugin("acme.sync", manifest(), "acme.sync");
    return registry;
  }

  it("keeps a well-formed failure and backfills the error string", async () => {
    const registry = registryWithResult({
      failure: { code: "unavailable", message: "Busy.", retryAfterMs: 1000 },
    });

    const exec = await registry.executeTool("acme.sync:sync", {}, {
      agentId: "a", runId: "r", companyId: "c",
    });

    expect(exec.result.error).toBe("Busy.");
    expect(exec.result.failure?.code).toBe("unavailable");
  });

  it("downgrades a failure code the host has never heard of", async () => {
    const registry = registryWithResult({
      failure: { code: "explosion", message: "Boom." },
    });

    const exec = await registry.executeTool("acme.sync:sync", {}, {
      agentId: "a", runId: "r", companyId: "c",
    });

    // The worker is a separate process; a code outside the list would make
    // every caller that branches on it fall through unpredictably.
    expect(exec.result.failure).toEqual({ code: "failed", message: "Boom." });
    expect(exec.result.error).toBe("Boom.");
  });

  it("adds a code to a legacy error-only result", async () => {
    const registry = registryWithResult({ error: "Old style failure." });

    const exec = await registry.executeTool("acme.sync:sync", {}, {
      agentId: "a", runId: "r", companyId: "c",
    });

    expect(exec.result.failure).toEqual({ code: "failed", message: "Old style failure." });
  });

  it("does not invent a failure on a successful result", async () => {
    const registry = registryWithResult({ content: "fine" });

    const exec = await registry.executeTool("acme.sync:sync", {}, {
      agentId: "a", runId: "r", companyId: "c",
    });

    expect(exec.result).toEqual({ content: "fine" });
  });
});
