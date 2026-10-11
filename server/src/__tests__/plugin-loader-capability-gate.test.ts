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
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeCapabilityEscalation,
  PluginCapabilityEscalationError,
  pluginLoader,
  warnedCapabilitiesNeedingApproval,
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

describe("a first install of a plugin that can copy or replace the whole database", () => {
  const SNAPSHOT_CAPABILITIES = ["system.snapshot.read", "system.snapshot.restore"];
  let dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    dirs = [];
  });

  /** A plugin folder as the library install unpacks it, asking for both snapshot capabilities. */
  async function snapshotPlugin() {
    const dir = await mkdtemp(path.join(tmpdir(), "plugin-first-install-"));
    const managedDir = await mkdtemp(path.join(tmpdir(), "plugin-first-install-managed-"));
    dirs.push(dir, managedDir);
    await writeFile(path.join(dir, "package.json"), JSON.stringify({
      name: "paperclip-plugin-snapshot-test",
      version: "0.1.0",
      type: "module",
      paperclipPlugin: { manifest: "./manifest.js", worker: "./worker.js" },
    }));
    await writeFile(path.join(dir, "manifest.js"), `export default ${JSON.stringify({
      id: "snapshot-test",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Snapshot test",
      description: "Asks for the whole database",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: ["issues.read", ...SNAPSHOT_CAPABILITIES],
      entrypoints: { worker: "./worker.js" },
    })};\n`);
    await writeFile(path.join(dir, "worker.js"), "\n");
    const loader = pluginLoader({} as never, { localPluginDir: managedDir, managedPluginDir: managedDir });
    return { dir, managedDir, loader };
  }

  it("names the capabilities with a warning that are not approved yet", () => {
    expect(warnedCapabilitiesNeedingApproval(["issues.read", ...SNAPSHOT_CAPABILITIES])).toEqual(SNAPSHOT_CAPABILITIES);
    expect(warnedCapabilitiesNeedingApproval(SNAPSHOT_CAPABILITIES, ["system.snapshot.read"])).toEqual([
      "system.snapshot.restore",
    ]);
    expect(warnedCapabilitiesNeedingApproval(["issues.read", "toString"])).toEqual([]);
  });

  it("asks before installing from the library, and installs nothing until approved", async () => {
    const { dir, managedDir, loader } = await snapshotPlugin();

    const asked = await loader.installPlugin({ localPath: dir, askBeforeWarnedCapabilities: true }).catch((err) => err);
    expect(asked).toBeInstanceOf(PluginCapabilityEscalationError);
    expect(asked).toMatchObject({ escalated: SNAPSHOT_CAPABILITIES, previousCapabilities: [] });
    expect(asked.message).toContain('Installing "snapshot-test"');
    expect(existsSync(path.join(managedDir, "snapshot-test"))).toBe(false);

    // Approved, it goes on to install. This test has no database, so it
    // stops there, at something other than the question.
    const approved = await loader.installPlugin({
      localPath: dir,
      askBeforeWarnedCapabilities: true,
      acknowledgeCapabilities: SNAPSHOT_CAPABILITIES,
    }).catch((err) => err);
    expect(approved).not.toBeInstanceOf(PluginCapabilityEscalationError);
  });
});
