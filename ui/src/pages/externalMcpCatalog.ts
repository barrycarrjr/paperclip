/**
 * Curated catalog of well-known external MCP servers.
 *
 * Each entry pre-fills the External MCP server registration form with
 * sensible defaults — transport, command/args/url, and templated env or
 * header bindings that reference conventional ALL_CAPS_SNAKE_CASE secret
 * names. The operator still picks `allowedCompanies` and confirms (or
 * edits) the bindings before clicking Register.
 *
 * Adding an entry: just append to `EXTERNAL_MCP_CATALOG`. Static module —
 * no migrations, no backend work. The form on the page already validates
 * the payload, so a stale package name is recoverable by editing the field
 * before submit.
 */

import {
  Brain,
  Bug,
  Database,
  FileText,
  Folder,
  Github,
  Globe,
  MessageSquare,
  MousePointerClick,
  Network,
  Search,
  type LucideIcon,
} from "lucide-react";
import type { EnvBinding, ExternalMcpBindings, ExternalMcpTransport } from "@paperclipai/shared";

export interface CatalogEntry {
  /** Default `key` for the server record. Operator can rename before submit. */
  key: string;
  displayName: string;
  /** Short one-liner for the tile. */
  tagline: string;
  /** Longer copy shown on hover or after selection — credential hints belong here. */
  description: string;
  icon: LucideIcon;
  transport: ExternalMcpTransport;
  /** stdio only */
  command?: string;
  /** stdio only — pre-joined for the form's args textarea. */
  args?: string[];
  /** http / sse only */
  url?: string;
  /** Pre-templated env bindings (stdio). Bound to secret names by convention. */
  envBindings?: ExternalMcpBindings;
  /** Pre-templated header bindings (http / sse). */
  headerBindings?: ExternalMcpBindings;
  /**
   * Conventional secret names the operator needs to create on each
   * `allowedCompany` before this server will work. Rendered as a checklist
   * on the tile-detail step.
   */
  requiredSecrets?: string[];
  /**
   * Notes shown beneath the form when this preset is loaded — typically a
   * link to vendor docs or a heads-up about OAuth-only auth.
   */
  notes?: string;
}

const bearer = (secretName: string): ExternalMcpBindings => ({
  Authorization: { type: "secret_ref", secretName },
});

const secretRef = (secretName: string): EnvBinding => ({
  type: "secret_ref",
  secretName,
});

export const EXTERNAL_MCP_CATALOG: CatalogEntry[] = [
  {
    key: "github",
    displayName: "GitHub",
    tagline: "Issues, PRs, files, commits",
    description:
      "Official MCP server for GitHub. Reads and writes issues, pull requests, files, and commits using a personal access token.",
    icon: Github,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    envBindings: {
      GITHUB_PERSONAL_ACCESS_TOKEN: secretRef("GITHUB_PERSONAL_ACCESS_TOKEN"),
    },
    requiredSecrets: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    notes:
      "Create a fine-grained PAT at github.com/settings/tokens and store it as GITHUB_PERSONAL_ACCESS_TOKEN in Company Secrets.",
  },
  {
    key: "filesystem",
    displayName: "Filesystem",
    tagline: "Read & write files in a sandboxed path",
    description:
      "Exposes a single directory tree (and below) to agents. Pass the absolute path as the last arg; the server refuses to read outside it.",
    icon: Folder,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/sandbox"],
    notes:
      "Replace `/path/to/sandbox` with the absolute directory you want agents to access. The server denies traversal above this root.",
  },
  {
    key: "postgres",
    displayName: "PostgreSQL",
    tagline: "Read-only SQL against a Postgres database",
    description:
      "Read-only query access to a Postgres database. Pass the connection string as an arg; the server refuses writes.",
    icon: Database,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres", "postgres://user:pass@host:5432/db"],
    notes:
      "Replace the connection string with your own, or move it to a secret and reference it via env binding. Server is read-only by default.",
  },
  {
    key: "slack",
    displayName: "Slack",
    tagline: "Read channels, threads, search",
    description:
      "Read access to Slack channels, threads, users, and search. Requires a bot token with channels:history, channels:read, users:read, and search:read scopes.",
    icon: MessageSquare,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    envBindings: {
      SLACK_BOT_TOKEN: secretRef("SLACK_BOT_TOKEN"),
      SLACK_TEAM_ID: secretRef("SLACK_TEAM_ID"),
    },
    requiredSecrets: ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"],
    notes:
      "If you already use the first-party slack-tools plugin, prefer that — it's polished and audited. Use this MCP server for raw access workflows.",
  },
  {
    key: "brave-search",
    displayName: "Brave Search",
    tagline: "Web search via Brave's API",
    description:
      "Web search via the Brave Search API. Free tier supports 2k queries/month.",
    icon: Search,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    envBindings: {
      BRAVE_API_KEY: secretRef("BRAVE_API_KEY"),
    },
    requiredSecrets: ["BRAVE_API_KEY"],
    notes: "Get an API key at brave.com/search/api and store it as BRAVE_API_KEY.",
  },
  {
    key: "fetch",
    displayName: "Fetch",
    tagline: "Fetch web pages as markdown",
    description:
      "Fetches arbitrary URLs and converts HTML to markdown for the model. No credentials required.",
    icon: Globe,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-fetch"],
  },
  {
    key: "memory",
    displayName: "Memory",
    tagline: "Persistent knowledge graph for the agent",
    description:
      "Local persistent knowledge graph. Agent stores entities, relations, and observations across sessions. Paperclip's own Memory feature is usually a better fit — use this for experiments.",
    icon: Brain,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
  },
  {
    key: "puppeteer",
    displayName: "Puppeteer",
    tagline: "Headless browser automation",
    description:
      "Drives a headless Chrome via Puppeteer. Useful for scraping, screenshotting, or filling forms — anything that needs real DOM execution.",
    icon: MousePointerClick,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-puppeteer"],
  },
  {
    key: "sentry",
    displayName: "Sentry",
    tagline: "Read recent issues and events",
    description:
      "Read access to Sentry issues, events, and projects. If you already use the first-party rollbar-tools plugin for a similar workflow, that path is more battle-tested.",
    icon: Bug,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sentry"],
    envBindings: {
      SENTRY_AUTH_TOKEN: secretRef("SENTRY_AUTH_TOKEN"),
    },
    requiredSecrets: ["SENTRY_AUTH_TOKEN"],
  },
  {
    key: "notion",
    displayName: "Notion",
    tagline: "Search & edit Notion pages (remote MCP)",
    description:
      "Notion's hosted MCP server. Auth is a Notion internal integration token sent as a bearer header. OAuth flow is not yet wired up in Paperclip — use an integration token.",
    icon: FileText,
    transport: "http",
    url: "https://mcp.notion.com/mcp",
    headerBindings: bearer("NOTION_TOKEN"),
    requiredSecrets: ["NOTION_TOKEN"],
    notes:
      "Create an internal integration at notion.so/profile/integrations and share the relevant pages/databases with it. Store the secret as NOTION_TOKEN — the value must include the `Bearer ` prefix (e.g. `Bearer ntn_xxx`) because the header binding is injected verbatim.",
  },
];

/** Sentinel entry that opens an empty form for users who want full manual control. */
export const CUSTOM_CONNECTOR_TILE = {
  key: "__custom__",
  displayName: "Custom connector",
  tagline: "Roll your own — point at any MCP server",
  description: "Register an MCP server that isn't in the catalog. You'll fill in every field by hand.",
  icon: Network,
};
