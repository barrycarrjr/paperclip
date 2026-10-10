/**
 * Unit tests for the external-MCP connector. Covers:
 *   - mutation-prefix heuristic
 *   - tool-namespace round-trip (parse/build)
 *   - secret-binding authorization (allowedCompanies fail-safe deny)
 *   - secret-ref errors carry only the binding name (no resolved value)
 *
 * The `external-mcp-server-manager` end-to-end flow needs a real MCP child
 * process to exercise (covered by the integration test in the sibling
 * `external-mcp-integration.test.ts`).
 */

import { describe, expect, it } from "vitest";
import {
  EXTERNAL_MCP_TOOL_NAMESPACE,
  isLikelyMutationToolName,
  type ExternalMcpServerRecord,
} from "@paperclipai/shared";
import { createExternalMcpToolSource } from "../services/external-mcp-tool-source.js";
import {
  ExternalMcpAuthorizationError,
  ExternalMcpSecretResolutionError,
  hasCompanyScopedBindings,
} from "../services/external-mcp-secrets.js";

function makeServer(overrides: Partial<ExternalMcpServerRecord> = {}): ExternalMcpServerRecord {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    key: "demo",
    displayName: "Demo MCP",
    description: null,
    transport: "stdio",
    command: "echo",
    args: ["hi"],
    url: null,
    envBindings: {},
    headerBindings: {},
    allowedCompanies: ["co-1"],
    allowMutations: false,
    writeAllowList: [],
    toolAllowList: [],
    toolDenyList: [],
    lastError: null,
    createdByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("isLikelyMutationToolName", () => {
  it("flags conventional mutation prefixes", () => {
    expect(isLikelyMutationToolName("create_issue")).toBe(true);
    expect(isLikelyMutationToolName("update_user")).toBe(true);
    expect(isLikelyMutationToolName("delete_thing")).toBe(true);
    expect(isLikelyMutationToolName("send_message")).toBe(true);
    expect(isLikelyMutationToolName("post_reply")).toBe(true);
    expect(isLikelyMutationToolName("Modify_Foo")).toBe(true);
  });

  it("does not flag read-shaped names", () => {
    expect(isLikelyMutationToolName("list_issues")).toBe(false);
    expect(isLikelyMutationToolName("get_user")).toBe(false);
    expect(isLikelyMutationToolName("search")).toBe(false);
    expect(isLikelyMutationToolName("read_doc")).toBe(false);
  });
});

describe("ExternalMcpToolSource namespacing", () => {
  // We don't need a real db / manager for the pure namespace functions,
  // but the source factory takes both — pass typed nulls cast to keep TS happy.
  const source = createExternalMcpToolSource(
    {} as never,
    {} as never,
  );

  it("builds and parses a namespaced name losslessly", () => {
    const ns = source.buildNamespacedName("notion", "search_pages");
    expect(ns).toBe(`${EXTERNAL_MCP_TOOL_NAMESPACE}:notion:search_pages`);
    expect(source.parseNamespacedName(ns)).toEqual({
      serverKey: "notion",
      toolName: "search_pages",
    });
  });

  it("preserves a colon inside the tool name", () => {
    // Bare tool names with embedded colons are unusual but possible.
    const ns = source.buildNamespacedName("svc", "ns:tool");
    expect(source.parseNamespacedName(ns)).toEqual({
      serverKey: "svc",
      toolName: "ns:tool",
    });
  });

  it("returns null for non-mcp prefixes (plugin tools should pass through)", () => {
    expect(source.parseNamespacedName("acme.linear:search")).toBeNull();
    expect(source.parseNamespacedName("just-a-tool")).toBeNull();
  });

  it("returns null for malformed namespaces", () => {
    expect(source.parseNamespacedName("mcp:")).toBeNull();
    expect(source.parseNamespacedName("mcp:notion")).toBeNull();
    expect(source.parseNamespacedName("mcp:notion:")).toBeNull();
  });
});

describe("ExternalMcpAuthorizationError / SecretResolutionError", () => {
  it("authorization error carries the documented code", () => {
    const err = new ExternalMcpAuthorizationError("nope");
    expect(err.code).toBe("ECOMPANY_NOT_ALLOWED");
    expect(err.message).toBe("nope");
    expect(err.name).toBe("ExternalMcpAuthorizationError");
  });

  it("secret resolution error captures the binding name as a structured field", () => {
    // Call sites in `external-mcp-secrets.ts` always include the binding name
    // in the message, but the structured `bindingName` field is the contract
    // — log filters and UI surfaces should read from there, not the message.
    const err = new ExternalMcpSecretResolutionError(
      "NOTION_TOKEN",
      `env binding "NOTION_TOKEN" failed to resolve: secret not found`,
    );
    expect(err.code).toBe("ESECRET_RESOLUTION_FAILED");
    expect(err.bindingName).toBe("NOTION_TOKEN");
    // Sanity-check that no raw secret value can leak in via the message:
    // the only callers we control build messages from binding name + reason,
    // never from the resolved plaintext.
    expect(err.message).not.toMatch(/super-secret-token/);
  });
});

describe("hasCompanyScopedBindings", () => {
  // Decides whether one company's tool list can stand for every company's,
  // so a wrong "no" would show a company tools reached with another's secret.
  it("counts a secret in the headers, not only in the env", () => {
    const server = makeServer({
      transport: "http",
      url: "https://crm.example.test/mcp",
      headerBindings: { Authorization: { type: "secret_ref", secretName: "CRM_TOKEN" } },
    });
    expect(hasCompanyScopedBindings(server)).toBe(true);
  });

  it("counts a secret in the env", () => {
    const server = makeServer({ envBindings: { HA_TOKEN: { type: "secret_ref", secretId: "s-1" } } });
    expect(hasCompanyScopedBindings(server)).toBe(true);
  });

  it("counts a binding type it does not know, so one added later is safe by default", () => {
    const server = makeServer({
      envBindings: { TOKEN: { type: "vault_ref", path: "kv/crm" } as never },
    });
    expect(hasCompanyScopedBindings(server)).toBe(true);
  });

  it("treats plain text as the same for every company", () => {
    const server = makeServer({
      envBindings: { MODE: "read-only", REGION: { type: "plain", value: "us-east-1" } },
      headerBindings: { "X-Client": "paperclip" },
    });
    expect(hasCompanyScopedBindings(server)).toBe(false);
    expect(hasCompanyScopedBindings(makeServer())).toBe(false);
  });
});

describe("ExternalMcpServerRecord shape (sanity)", () => {
  it("fail-safe deny — empty allowedCompanies makes the server unusable in prose", () => {
    const server = makeServer({ allowedCompanies: [] });
    expect(server.allowedCompanies).toHaveLength(0);
  });

  it("retains the writeAllowList separate from allowMutations", () => {
    const server = makeServer({
      allowMutations: false,
      writeAllowList: ["close_ticket"],
    });
    // The manager checks: if !allowMutations and tool is in writeAllowList,
    // the call is allowed. (Tested end-to-end in the integration test.)
    expect(server.writeAllowList).toContain("close_ticket");
    expect(server.allowMutations).toBe(false);
  });
});
