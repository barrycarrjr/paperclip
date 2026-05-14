/**
 * Unit tests for `computeCapabilityEscalation` — the pure helper that the
 * loader's `upgradePlugin` uses to decide whether an upgrade introduces new
 * capabilities and whether the operator has acknowledged them.
 *
 * The previous implementation threw whenever any new capability was declared,
 * with no way to approve from the UI. The acknowledgement flow keeps that
 * gate but lets the operator clear it after seeing the escalation set; these
 * tests lock in the four corners of that behaviour.
 */
import { describe, expect, it } from "vitest";
import {
  computeCapabilityEscalation,
  PluginCapabilityEscalationError,
} from "../services/plugin-loader.js";

describe("computeCapabilityEscalation", () => {
  it("returns no escalation when the new manifest is a subset of the old", () => {
    const result = computeCapabilityEscalation(
      ["issues.read", "issues.update"],
      ["issues.read"],
    );
    expect(result.escalated).toEqual([]);
    expect(result.approved).toBe(true);
  });

  it("returns no escalation when both manifests declare the same set", () => {
    const result = computeCapabilityEscalation(
      ["issues.read", "issues.update"],
      ["issues.update", "issues.read"],
    );
    expect(result.escalated).toEqual([]);
    expect(result.approved).toBe(true);
  });

  it("flags added capabilities and reports unapproved without an ack", () => {
    const result = computeCapabilityEscalation(
      ["issues.read"],
      ["issues.read", "issues.update", "ui.page.register"],
    );
    expect(result.escalated).toEqual(["issues.update", "ui.page.register"]);
    expect(result.approved).toBe(false);
  });

  it("treats the escalation as approved when ack covers every new cap", () => {
    const result = computeCapabilityEscalation(
      ["issues.read"],
      ["issues.read", "issues.update", "ui.page.register"],
      ["issues.update", "ui.page.register"],
    );
    expect(result.escalated).toEqual(["issues.update", "ui.page.register"]);
    expect(result.approved).toBe(true);
  });

  it("rejects a partial ack that does not cover the full escalation", () => {
    const result = computeCapabilityEscalation(
      ["issues.read"],
      ["issues.read", "issues.update", "ui.page.register"],
      ["issues.update"], // ack omits ui.page.register
    );
    expect(result.escalated).toEqual(["issues.update", "ui.page.register"]);
    expect(result.approved).toBe(false);
  });

  it("ignores extraneous ack entries that don't correspond to escalations", () => {
    // Operator can submit a superset (e.g. the prior version's full cap list);
    // the gate only cares that every escalated entry is covered.
    const result = computeCapabilityEscalation(
      ["issues.read"],
      ["issues.read", "issues.update"],
      ["issues.update", "ui.page.register", "agents.read"],
    );
    expect(result.escalated).toEqual(["issues.update"]);
    expect(result.approved).toBe(true);
  });

  it("handles empty manifests on both sides", () => {
    const result = computeCapabilityEscalation([], []);
    expect(result.escalated).toEqual([]);
    expect(result.approved).toBe(true);
  });

  it("flags every new cap when the prior version declared none", () => {
    const result = computeCapabilityEscalation(
      [],
      ["issues.read", "issues.update"],
    );
    expect(result.escalated).toEqual(["issues.read", "issues.update"]);
    expect(result.approved).toBe(false);
  });
});

describe("PluginCapabilityEscalationError", () => {
  it("preserves the pluginId, capability snapshots, and the escalation set", () => {
    const err = new PluginCapabilityEscalationError({
      pluginId: "phone-tools",
      previousCapabilities: ["issues.read"],
      nextCapabilities: ["issues.read", "issues.update", "ui.page.register"],
      escalated: ["issues.update", "ui.page.register"],
    });

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PluginCapabilityEscalationError");
    expect(err.code).toBe("capability_escalation");
    expect(err.pluginId).toBe("phone-tools");
    expect(err.previousCapabilities).toEqual(["issues.read"]);
    expect(err.nextCapabilities).toEqual([
      "issues.read",
      "issues.update",
      "ui.page.register",
    ]);
    expect(err.escalated).toEqual(["issues.update", "ui.page.register"]);
    expect(err.message).toContain("phone-tools");
    expect(err.message).toContain("issues.update");
    expect(err.message).toContain("ui.page.register");
  });

  it("defensively copies the arrays so mutating callers can't poison the error", () => {
    const previous = ["issues.read"];
    const next = ["issues.read", "issues.update"];
    const escalated = ["issues.update"];

    const err = new PluginCapabilityEscalationError({
      pluginId: "p",
      previousCapabilities: previous,
      nextCapabilities: next,
      escalated,
    });

    previous.push("mutated");
    next.push("mutated");
    escalated.push("mutated");

    expect(err.previousCapabilities).toEqual(["issues.read"]);
    expect(err.nextCapabilities).toEqual(["issues.read", "issues.update"]);
    expect(err.escalated).toEqual(["issues.update"]);
  });
});
