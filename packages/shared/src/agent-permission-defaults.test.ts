import { describe, expect, it } from "vitest";
import {
  mergeSkipPermissionsByAdapterType,
  patchCompanyAgentDefaultsSchema,
  resolveAgentSkipPermissions,
} from "./agent-permission-defaults.js";
import { patchInstanceAgentDefaultsSchema } from "./validators/instance.js";

describe("resolveAgentSkipPermissions", () => {
  const company = { skipPermissionsByAdapterType: { claude_local: false } };
  const instance = { skipPermissionsByAdapterType: { claude_local: true, codex_local: false } };

  it("uses the agent's own value first", () => {
    expect(
      resolveAgentSkipPermissions({
        adapterType: "claude_local",
        adapterConfig: { dangerouslySkipPermissions: true },
        companyDefaults: company,
        instanceDefaults: instance,
      }),
    ).toMatchObject({ skipPermissions: true, source: "agent" });
  });

  it("falls back to the company default, then the instance default, then the code default", () => {
    expect(
      resolveAgentSkipPermissions({ adapterType: "claude_local", adapterConfig: {}, companyDefaults: company, instanceDefaults: instance }),
    ).toMatchObject({ skipPermissions: false, source: "company" });
    expect(
      resolveAgentSkipPermissions({ adapterType: "codex_local", adapterConfig: {}, companyDefaults: company, instanceDefaults: instance }),
    ).toMatchObject({ skipPermissions: false, source: "instance", configKey: "dangerouslyBypassApprovalsAndSandbox" });
    expect(
      resolveAgentSkipPermissions({ adapterType: "opencode_local", adapterConfig: {}, companyDefaults: company, instanceDefaults: instance }),
    ).toMatchObject({ skipPermissions: true, source: "code" });
  });

  it("treats null or a non-boolean stored value as unset", () => {
    expect(
      resolveAgentSkipPermissions({
        adapterType: "claude_local",
        adapterConfig: { dangerouslySkipPermissions: null },
        companyDefaults: company,
      }),
    ).toMatchObject({ skipPermissions: false, source: "company" });
  });

  it("counts the legacy Codex key as set on the agent", () => {
    expect(
      resolveAgentSkipPermissions({
        adapterType: "codex_local",
        adapterConfig: { dangerouslyBypassSandbox: false },
        instanceDefaults: { skipPermissionsByAdapterType: { codex_local: true } },
      }),
    ).toMatchObject({ skipPermissions: false, source: "agent" });
  });

  it("returns null for adapters without the setting", () => {
    expect(resolveAgentSkipPermissions({ adapterType: "http", adapterConfig: {} })).toBeNull();
  });
});

describe("mergeSkipPermissionsByAdapterType", () => {
  it("sets booleans, clears on null and leaves unmentioned entries alone", () => {
    expect(
      mergeSkipPermissionsByAdapterType(
        { claude_local: true, codex_local: true },
        { codex_local: null, opencode_local: false },
      ),
    ).toEqual({ claude_local: true, opencode_local: false });
  });
});

describe("patch schemas", () => {
  it("reject unknown adapter types and non-boolean values", () => {
    expect(patchCompanyAgentDefaultsSchema.safeParse({ skipPermissionsByAdapterType: { http: true } }).success).toBe(false);
    expect(patchCompanyAgentDefaultsSchema.safeParse({ skipPermissionsByAdapterType: { claude_local: "yes" } }).success).toBe(false);
    expect(patchInstanceAgentDefaultsSchema.safeParse({ skipPermissionsByAdapterType: { claude_local: null } }).success).toBe(true);
  });
});
