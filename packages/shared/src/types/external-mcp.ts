/**
 * External MCP server connector — types for operator-registered Model Context
 * Protocol servers whose tools become callable by Paperclip agents.
 *
 * The connector is the inbound counterpart to `@paperclipai/mcp-server`
 * (which exposes Paperclip's API outbound). It lives in core (not as a
 * plugin) because stdio MCP servers spawn child processes — outside the
 * plugin sandbox.
 *
 * Env bindings reuse the project / agent `EnvBinding` shape:
 * `Record<string, string | EnvPlainBinding | EnvSecretRefBinding>`. Secret
 * refs are resolved against the **calling company's** vault at spawn time,
 * so a single MCP server config can serve multiple companies — each
 * company supplies its own secret under the bound name.
 */

import type { EnvBinding } from "./secrets.js";

export const EXTERNAL_MCP_TRANSPORTS = ["stdio", "http", "sse"] as const;
export type ExternalMcpTransport = (typeof EXTERNAL_MCP_TRANSPORTS)[number];

/**
 * Bindings keyed by env-var (or header) name, value is the existing project /
 * agent `EnvBinding` union (plain string, `{type:"plain",value}`, or
 * `{type:"secret_ref",secretId|secretName,version?}`).
 */
export type ExternalMcpBindings = Record<string, EnvBinding>;

/**
 * Persisted record matching the `external_mcp_servers` table.
 */
export interface ExternalMcpServerRecord {
  id: string;
  key: string;
  displayName: string;
  description: string | null;
  transport: ExternalMcpTransport;
  command: string | null;
  args: string[] | null;
  url: string | null;
  /** Stdio transport only — env vars injected into the spawned child. */
  envBindings: ExternalMcpBindings;
  /** http/sse transport only — headers attached to outbound requests. */
  headerBindings: ExternalMcpBindings;
  /**
   * Companies whose agents may call this server's tools. `["*"]` =
   * portfolio-wide. Empty array = unusable (fail-safe deny). Mirrors the
   * `format: company-id` array convention used by plugin instanceConfig.
   */
  allowedCompanies: string[];
  allowMutations: boolean;
  /** Bare tool names that are write-allowed even when allowMutations=false. */
  writeAllowList: string[];
  /** If non-empty, ONLY these bare tool names are exposed. */
  toolAllowList: string[];
  /** Bare tool names hidden from agents entirely. */
  toolDenyList: string[];
  lastError: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const PORTFOLIO_WIDE_COMPANY_TOKEN = "*";

export function isPortfolioWide(allowedCompanies: string[]): boolean {
  return allowedCompanies.includes(PORTFOLIO_WIDE_COMPANY_TOKEN);
}

export function isCompanyAllowed(allowedCompanies: string[], companyId: string): boolean {
  if (allowedCompanies.length === 0) return false;
  if (allowedCompanies.includes(PORTFOLIO_WIDE_COMPANY_TOKEN)) return true;
  return allowedCompanies.includes(companyId);
}

/** Minimal tool descriptor reported back to the UI from a `test-connect` probe. */
export interface ExternalMcpToolPreview {
  name: string;
  description: string;
  parametersSchema: Record<string, unknown>;
}

export interface ExternalMcpTestConnectResult {
  ok: boolean;
  toolCount: number;
  tools: ExternalMcpToolPreview[];
  error: string | null;
}

/**
 * Heuristic mutation prefixes — used as a default classification when the
 * operator hasn't pinned a tool to writeAllowList. Any tool whose bare name
 * starts with one of these prefixes is treated as a mutation and is gated
 * by `allowMutations`. The MCP spec doesn't carry mutation metadata so this
 * is necessarily conservative.
 */
export const EXTERNAL_MCP_MUTATION_PREFIXES = [
  "create_",
  "update_",
  "delete_",
  "remove_",
  "send_",
  "post_",
  "patch_",
  "put_",
  "execute_",
  "write_",
  "set_",
  "modify_",
] as const;

export function isLikelyMutationToolName(name: string): boolean {
  const lower = name.toLowerCase();
  return EXTERNAL_MCP_MUTATION_PREFIXES.some((p) => lower.startsWith(p));
}

/** Tool-namespace prefix used for external MCP tools (e.g. `mcp:notion:search`). */
export const EXTERNAL_MCP_TOOL_NAMESPACE = "mcp";
