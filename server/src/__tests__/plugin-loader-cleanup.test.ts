/**
 * Unit tests for `computeCleanupTargets` — the path-set computation that
 * `cleanupInstallArtifacts` uses to decide what to `rm -rf` on uninstall.
 *
 * The earlier implementation only walked paths under `localPluginDir`
 * (.paperclip/plugins/), which silently leaked the directory created by
 * .pcplugin uploads and local-filesystem installs (those land under
 * `managedPluginDir`/.paperclip/installed-plugins/<pluginKey>/). These tests
 * lock in the fix so a regression is caught before it ships.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { computeCleanupTargets } from "../services/plugin-loader.js";

const dirs = {
  localPluginDir: "/home/op/.paperclip/plugins",
  managedPluginDir: "/home/op/.paperclip/installed-plugins",
};

function plugin(over: {
  pluginKey: string;
  packageName: string;
  packagePath?: string | null;
}) {
  return {
    pluginKey: over.pluginKey,
    packageName: over.packageName,
    packagePath: over.packagePath ?? null,
  };
}

describe("computeCleanupTargets", () => {
  it("includes the managed directory keyed by pluginKey for .pcplugin installs", () => {
    // Simulates a .pcplugin upload — installPlugin extracts to
    // managedPluginDir/<pluginKey>/ and records that path on packagePath.
    const targets = computeCleanupTargets(
      plugin({
        pluginKey: "google-workspace",
        packageName: "paperclip-plugin-google-workspace",
        packagePath: path.join(dirs.managedPluginDir, "google-workspace"),
      }),
      dirs,
    );

    expect(targets).toContain(path.join(dirs.managedPluginDir, "google-workspace"));
  });

  it("includes the managed directory even when packagePath is null", () => {
    // A defensive case: registry record has packagePath=null but the install
    // dir still exists on disk (e.g. because an earlier write succeeded but
    // the registry update partially failed). Cleanup should still nuke it.
    const targets = computeCleanupTargets(
      plugin({
        pluginKey: "google-workspace",
        packageName: "paperclip-plugin-google-workspace",
        packagePath: null,
      }),
      dirs,
    );

    expect(targets).toContain(path.join(dirs.managedPluginDir, "google-workspace"));
  });

  it("includes both npm-style and managed-dir paths simultaneously", () => {
    const targets = computeCleanupTargets(
      plugin({
        pluginKey: "google-workspace",
        packageName: "paperclip-plugin-google-workspace",
        packagePath: null,
      }),
      dirs,
    );

    // managed-keyed dir
    expect(targets).toContain(path.join(dirs.managedPluginDir, "google-workspace"));
    // node_modules path that an npm install would leave behind
    expect(targets).toContain(
      path.join(dirs.localPluginDir, "node_modules", "paperclip-plugin-google-workspace"),
    );
    // direct layout under localPluginDir (legacy npm install)
    expect(targets).toContain(
      path.join(dirs.localPluginDir, "paperclip-plugin-google-workspace"),
    );
  });

  it("rejects a pluginKey that would escape the managed root", () => {
    // Path-traversal safety: a malformed pluginKey must not be able to point
    // cleanup at a directory outside managedPluginDir.
    const targets = computeCleanupTargets(
      plugin({
        pluginKey: "../../etc/passwd",
        packageName: "paperclip-plugin-evil",
        packagePath: null,
      }),
      dirs,
    );

    // No path containing /etc should appear. The managed-keyed branch is
    // gated by isPathInsideDir, so it's filtered out.
    for (const target of targets) {
      expect(target.includes("/etc/passwd")).toBe(false);
    }
  });

  it("rejects a packagePath that lives outside both managed roots", () => {
    const targets = computeCleanupTargets(
      plugin({
        pluginKey: "evil",
        packageName: "paperclip-plugin-evil",
        packagePath: "/etc",
      }),
      dirs,
    );

    expect(targets).not.toContain("/etc");
  });

  it("accepts a scoped npm package name", () => {
    const targets = computeCleanupTargets(
      plugin({
        pluginKey: "acme-plugin",
        packageName: "@acme/plugin-foo",
        packagePath: null,
      }),
      dirs,
    );

    // Scoped packages live at node_modules/<scope>/<name>
    expect(targets).toContain(
      path.join(dirs.localPluginDir, "node_modules", "@acme", "plugin-foo"),
    );
  });
});
