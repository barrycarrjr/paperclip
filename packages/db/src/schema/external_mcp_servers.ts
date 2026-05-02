import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  ExternalMcpBindings,
  ExternalMcpTransport,
} from "@paperclipai/shared";

/**
 * `external_mcp_servers` — operator-registered external MCP servers that
 * agents can call as tools. One row per server. Board-only writes; agents
 * read filtered by allowedCompanies.
 *
 * The connector is the inbound counterpart to packages/mcp-server (which
 * exposes Paperclip's API outbound). It's first-class in core because
 * stdio MCP servers spawn child processes — outside the plugin sandbox.
 *
 * Tools from these servers are registered into the shared tool registry
 * with namespace `mcp:<server.key>:<tool.name>` so they sit alongside
 * plugin tools without name collisions.
 */
export const externalMcpServers = pgTable(
  "external_mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Slug used in namespaced tool IDs (e.g. "mcp:notion:..."). Lowercase. */
    key: text("key").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    transport: text("transport").$type<ExternalMcpTransport>().notNull(),
    /** Stdio only — executable to spawn (e.g. "npx"). */
    command: text("command"),
    /** Stdio only — argv tail (e.g. ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]). */
    args: jsonb("args").$type<string[]>(),
    /** http/sse only — endpoint URL. */
    url: text("url"),
    /**
     * Stdio only — env-var bindings (project-style):
     * `{ NAME: "literal" | { type: "plain" | "secret_ref", ... } }`.
     * secret_refs resolve against the calling company's vault by name at
     * spawn time, mirroring the project / agent env editor flow.
     */
    envBindings: jsonb("env_bindings")
      .$type<ExternalMcpBindings>()
      .notNull()
      .default({}),
    /** http/sse only — header bindings, same shape as envBindings. */
    headerBindings: jsonb("header_bindings")
      .$type<ExternalMcpBindings>()
      .notNull()
      .default({}),
    /**
     * Companies whose agents may invoke this server's tools. Empty = fail-safe deny.
     * Mirrors the per-account allowedCompanies pattern in the Help Scout plugin.
     */
    allowedCompanies: jsonb("allowed_companies").$type<string[]>().notNull().default([]),
    /** Master switch for write tools. When false, only the writeAllowList is callable. */
    allowMutations: boolean("allow_mutations").notNull().default(false),
    /** Bare tool names that are explicitly write-allowed even when allowMutations=false. */
    writeAllowList: jsonb("write_allow_list").$type<string[]>().notNull().default([]),
    /** If non-empty, ONLY these bare tool names are exposed (block-list takes precedence). */
    toolAllowList: jsonb("tool_allow_list").$type<string[]>().notNull().default([]),
    /** Bare tool names to hide entirely. */
    toolDenyList: jsonb("tool_deny_list").$type<string[]>().notNull().default([]),
    /** Last setup-time error from a connect attempt; cleared on a successful connect. */
    lastError: text("last_error"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    keyIdx: uniqueIndex("external_mcp_servers_key_idx").on(table.key),
  }),
);
