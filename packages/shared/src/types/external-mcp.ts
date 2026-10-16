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
  "accept_",
  "acknowledge_",
  "activate_",
  "attach_",
  "approve_",
  "apply_",
  "assign_",
  "ban_",
  "cancel_",
  "capture_",
  "change_",
  "charge_",
  "clear_",
  "close_",
  "complete_",
  "commit_",
  "confirm_",
  "connect_",
  "copy_",
  "create_",
  "deploy_",
  "deposit_",
  "demote_",
  "destroy_",
  "detach_",
  "disable_",
  "disconnect_",
  "download_",
  "dismiss_",
  "edit_",
  "enable_",
  "expire_",
  "finalize_",
  "fork_",
  "grant_",
  "update_",
  "delete_",
  "hangup_",
  "install_",
  "invite_",
  "launch_",
  "lock_",
  "mark_",
  "merge_",
  "remove_",
  "send_",
  "post_",
  "patch_",
  "put_",
  "execute_",
  "export_",
  "write_",
  "set_",
  "modify_",
  "add_",
  "append_",
  "archive_",
  "import_",
  "link_",
  "move_",
  "park_",
  "pay_",
  "payout_",
  "pause_",
  "pickup_",
  "provision_",
  "promote_",
  "publish_",
  "purchase_",
  "push_",
  "print_",
  "refund_",
  "reject_",
  "replace_",
  "rename_",
  "renew_",
  "reply_",
  "resolve_",
  "reboot_",
  "reset_",
  "resize_",
  "restart_",
  "resume_",
  "restore_",
  "revoke_",
  "rotate_",
  "save_",
  "schedule_",
  "scale_",
  "share_",
  "sign_",
  "start_",
  "stop_",
  "submit_",
  "subscribe_",
  "suspend_",
  "sync_",
  "terminate_",
  "transfer_",
  "trigger_",
  "unarchive_",
  "uninstall_",
  "unlock_",
  "unban_",
  "unsubscribe_",
  "upload_",
  "upsert_",
  "overwrite_",
  "withdraw_",
  "redeem_",
] as const;

const EXTERNAL_MCP_KNOWN_READ_TOOLS = new Set([
  "backup_archive_describe",
  "support_check_skill_sync",
  "support_resolve_owner",
  "unifi_restart_status",
]);

export function isLikelyMutationToolName(name: string): boolean {
  const lower = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLowerCase();
  if (EXTERNAL_MCP_KNOWN_READ_TOOLS.has(lower)) return false;
  const tokens = lower.split("_").filter(Boolean);
  const mutationTokens = new Set(EXTERNAL_MCP_MUTATION_PREFIXES.map((prefix) => prefix.slice(0, -1)));
  const mutationIndex = tokens.findIndex((token) => mutationTokens.has(token));
  const readTokens = new Set([
    "calculate", "check", "compare", "describe", "estimate", "find", "get", "history",
    "inspect", "list", "lookup", "predict", "preview", "query", "read", "report",
    "scan", "search", "status", "summary", "transcript", "validate",
  ]);
  const readIndex = tokens.findIndex((token) => readTokens.has(token));
  const compoundRunIndex = tokens.findIndex((token) => token === "run");
  const hasCommandShape = tokens.some(
    (token) => token === "command" || token === "script" || token === "shell",
  );
  if (compoundRunIndex >= 0 && hasCommandShape && (readIndex < 0 || compoundRunIndex < readIndex)) {
    return true;
  }
  if (mutationIndex < 0) return false;
  if (readIndex < 0 || mutationIndex < readIndex) return true;
  const connectorIndex = tokens.findIndex(
    (token, index) => index > readIndex && (token === "and" || token === "or" || token === "then"),
  );
  if (connectorIndex >= 0 && tokens.slice(connectorIndex + 1).some((token) => mutationTokens.has(token))) {
    return true;
  }
  if (
    connectorIndex >= 0 &&
    tokens.slice(connectorIndex + 1).includes("run") &&
    hasCommandShape
  ) {
    return true;
  }
  const directMutationAfterRead = new Set([
    "add", "complete", "create", "delete", "edit", "execute", "modify", "move",
    "post", "publish", "remove", "send", "set", "submit", "trigger", "update",
    "upload", "upsert", "write",
  ]);
  return tokens.slice(readIndex + 1).some((token) => directMutationAfterRead.has(token));
}

/** Tool-namespace prefix used for external MCP tools (e.g. `mcp:notion:search`). */
export const EXTERNAL_MCP_TOOL_NAMESPACE = "mcp";
