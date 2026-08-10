import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema } from "./plugin.js";

/** A manifest that passes on its own, so each test changes only one thing. */
function manifest(overrides: Record<string, unknown> = {}) {
  return {
    id: "example.google-workspace",
    apiVersion: 1 as const,
    version: "1.0.0",
    displayName: "Google Workspace",
    description: "Calendar and Drive tools.",
    author: "Example",
    categories: ["connector"],
    capabilities: ["secrets.read-ref"],
    entrypoints: { worker: "./dist/worker.js" },
    instanceConfigSchema: {
      type: "object",
      properties: { accounts: { type: "array" } },
    },
    connectors: [
      {
        id: "google-calendar",
        surface: "calendar",
        displayName: "Google Calendar",
        connectionsKey: "accounts",
        companiesField: "allowedCompanies",
      },
    ],
    ...overrides,
  };
}

describe("plugin manifest connectors", () => {
  it("accepts a connector pointing at a real config property", () => {
    expect(pluginManifestV1Schema.safeParse(manifest()).success).toBe(true);
  });

  it("accepts a manifest with no connectors at all", () => {
    const withoutConnectors = manifest();
    delete (withoutConnectors as Record<string, unknown>).connectors;

    expect(pluginManifestV1Schema.safeParse(withoutConnectors).success).toBe(true);
  });

  // A typo here is invisible at runtime: the board would just report every
  // company as not connected and nobody would know why.
  it("rejects a connectionsKey that is not in instanceConfigSchema", () => {
    const result = pluginManifestV1Schema.safeParse(
      manifest({
        connectors: [
          {
            id: "google-calendar",
            surface: "calendar",
            displayName: "Google Calendar",
            connectionsKey: "acounts",
            companiesField: "allowedCompanies",
          },
        ],
      }),
    );

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("not a property of instanceConfigSchema");
  });

  it("rejects two connectors sharing an id", () => {
    const connector = {
      id: "google-calendar",
      surface: "calendar",
      displayName: "Google Calendar",
      connectionsKey: "accounts",
      companiesField: "allowedCompanies",
    };
    const result = pluginManifestV1Schema.safeParse(manifest({ connectors: [connector, connector] }));

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("Duplicate connector id");
  });

  it("rejects a surface the board does not have", () => {
    const result = pluginManifestV1Schema.safeParse(
      manifest({
        connectors: [
          {
            id: "google-calendar",
            surface: "spreadsheets",
            displayName: "Google Calendar",
            connectionsKey: "accounts",
            companiesField: "allowedCompanies",
          },
        ],
      }),
    );

    expect(result.success).toBe(false);
  });

  it("skips the config-property check when the plugin declares no config schema", () => {
    const withoutSchema = manifest();
    delete (withoutSchema as Record<string, unknown>).instanceConfigSchema;

    expect(pluginManifestV1Schema.safeParse(withoutSchema).success).toBe(true);
  });
});
