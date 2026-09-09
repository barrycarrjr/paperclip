/**
 * Operator control over who may run each plugin operation.
 *
 * The manifest says who an operation is FOR. This is where the operator says
 * what their own install allows. The rule that matters most is the direction:
 * an override can only narrow, never widen, so reviewing a manifest is enough
 * to know the ceiling on what installing a plugin can grant an agent.
 *
 * @see PLUGIN_SPEC.md §11.8 — Operator control over operations
 */

import { describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1, PluginOperationPolicy } from "@paperclipai/shared";
import {
  pluginOperationPolicySchema,
  policyAllowsAgents,
  policyAllowsUsers,
  resolveOperationPolicy,
} from "@paperclipai/shared";
import { createPluginToolRegistry } from "../services/plugin-tool-registry.js";

function manifest(operations: PaperclipPluginManifestV1["operations"]): PaperclipPluginManifestV1 {
  return {
    id: "acme.ops",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Ops",
    description: "Operations",
    author: "Acme",
    categories: ["automation"],
    capabilities: ["agent.tools.register", "ui.action.register"],
    entrypoints: { worker: "./dist/worker.js" },
    operations,
  };
}

const sendInvoice = {
  key: "send-invoice",
  displayName: "Send invoice",
  description: "Email an invoice to the customer.",
  parametersSchema: { type: "object" as const },
  writes: true,
};

describe("resolving an operator override against a manifest", () => {
  it("leaves the declared audience alone when there is no override", () => {
    expect(resolveOperationPolicy("both", undefined)).toEqual({
      audience: "both",
      requiresApproval: false,
      disabled: false,
      overrideIgnored: false,
    });
  });

  it("treats a missing declared audience as both", () => {
    expect(resolveOperationPolicy(undefined, undefined).audience).toBe("both");
  });

  it("narrows both down to either single lane", () => {
    expect(resolveOperationPolicy("both", { audience: "agents" }).audience).toBe("agents");
    expect(resolveOperationPolicy("both", { audience: "users" }).audience).toBe("users");
  });

  it("refuses to widen a single lane into both", () => {
    const result = resolveOperationPolicy("users", { audience: "both" });

    // This is the guarantee that makes reviewing a manifest meaningful:
    // installing a plugin can never give agents reach its author withheld.
    expect(result.audience).toBe("users");
    expect(result.overrideIgnored).toBe(true);
  });

  it("refuses to swap one lane for the other", () => {
    const result = resolveOperationPolicy("users", { audience: "agents" });

    expect(result.audience).toBe("users");
    expect(result.overrideIgnored).toBe(true);
  });

  it("accepts an override that restates the declared audience", () => {
    const result = resolveOperationPolicy("agents", { audience: "agents" });

    expect(result.audience).toBe("agents");
    expect(result.overrideIgnored).toBe(false);
  });

  it("switches an operation off for everyone", () => {
    const result = resolveOperationPolicy("both", { disabled: true });

    expect(result.audience).toBe("none");
    expect(policyAllowsAgents(result)).toBe(false);
    expect(policyAllowsUsers(result)).toBe(false);
  });

  it("drops an approval requirement on a disabled operation", () => {
    // Nothing runs, so nothing needs approving. Reporting both would let a
    // settings screen show "off" and "needs approval" at the same time.
    expect(resolveOperationPolicy("both", { disabled: true, requiresApproval: true })
      .requiresApproval).toBe(false);
  });

  it("carries an approval requirement through a narrowing override", () => {
    const result = resolveOperationPolicy("both", { audience: "agents", requiresApproval: true });

    expect(result.audience).toBe("agents");
    expect(result.requiresApproval).toBe(true);
  });
});

describe("the policy body validator", () => {
  it("accepts the three controls", () => {
    const parsed = pluginOperationPolicySchema.safeParse({
      "send-invoice": { audience: "users", requiresApproval: true, disabled: false },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown control so a typo cannot look like a working setting", () => {
    const parsed = pluginOperationPolicySchema.safeParse({
      "send-invoice": { requireApproval: true },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown audience", () => {
    expect(pluginOperationPolicySchema.safeParse({
      "send-invoice": { audience: "everyone" },
    }).success).toBe(false);
  });
});

describe("the registry honours the policy", () => {
  function register(policy: PluginOperationPolicy | undefined, audience?: "both" | "agents" | "users") {
    const registry = createPluginToolRegistry();
    registry.registerPlugin(
      "acme.ops",
      manifest([{ ...sendInvoice, ...(audience ? { audience } : {}) }]),
      "acme.ops",
      policy,
    );
    return registry;
  }

  it("keeps an operation off the agent tool list when the operator narrows it to users", () => {
    const registry = register({ "send-invoice": { audience: "users" } });

    // Not filtered at list time — never registered, so there is no path by
    // which an agent could reach it.
    expect(registry.getTool("acme.ops:send-invoice")).toBeNull();
  });

  it("keeps a disabled operation off the agent tool list", () => {
    const registry = register({ "send-invoice": { disabled: true } });

    expect(registry.getTool("acme.ops:send-invoice")).toBeNull();
  });

  it("marks an operation the operator wants approved", () => {
    const registry = register({ "send-invoice": { requiresApproval: true } });

    expect(registry.getTool("acme.ops:send-invoice")?.requiresApproval).toBe(true);
  });

  it("ignores an override that would widen, and still registers the declared audience", () => {
    const registry = register({ "send-invoice": { audience: "both" } }, "agents");

    const tool = registry.getTool("acme.ops:send-invoice");
    expect(tool).not.toBeNull();
    expect(tool?.audience).toBe("agents");
  });

  it("does not let a policy reach a legacy tool", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("acme.ops", {
      ...manifest([]),
      tools: [{
        name: "send-invoice",
        displayName: "Send invoice",
        description: "Legacy.",
        parametersSchema: { type: "object" },
      }],
    }, "acme.ops", { "send-invoice": { disabled: true } });

    // A legacy tool has no audience to narrow and no operation entry to match.
    // Silently applying an operation policy to it would be a surprise in the
    // dangerous direction: an operator would think they had switched off
    // something that kept running.
    expect(registry.getTool("acme.ops:send-invoice")).not.toBeNull();
    expect(registry.getTool("acme.ops:send-invoice")?.requiresApproval).toBe(false);
  });

  it("leaves everything alone when there is no policy at all", () => {
    const registry = register(undefined);

    const tool = registry.getTool("acme.ops:send-invoice");
    expect(tool?.audience).toBe("both");
    expect(tool?.requiresApproval).toBe(false);
    expect(tool?.writes).toBe(true);
  });
});
