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
  Code2,
  Container,
  Database,
  FileText,
  Folder,
  House,
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
  {
    key: "home-assistant",
    displayName: "Home Assistant",
    tagline: "Smart-home control — lights, locks, climate, sensors",
    description:
      "Drives a Home Assistant instance as agent tools — read entity state, toggle switches, set thermostats, run scripts, query history. Works against any HA instance reachable from the Paperclip host (local LAN URL or Nabu Casa remote URL).",
    icon: House,
    transport: "stdio",
    command: "uvx",
    args: ["ha-mcp@latest"],
    envBindings: {
      HOMEASSISTANT_URL: secretRef("HOMEASSISTANT_URL"),
      HOMEASSISTANT_TOKEN: secretRef("HOMEASSISTANT_TOKEN"),
    },
    requiredSecrets: ["HOMEASSISTANT_URL", "HOMEASSISTANT_TOKEN"],
    notes:
      "Requires `uv` installed on the Paperclip host (uvx fetches the ha-mcp package on first run). Create a long-lived access token in Home Assistant under Profile → Security → Long-lived access tokens. Use the Nabu Casa URL for remote access or the local http://homeassistant.local:8123 URL for LAN-only.",
  },
  {
    key: "docker",
    displayName: "Docker MCP Gateway",
    tagline: "Catalog of containerized MCP servers via Docker Desktop",
    description:
      "Routes tool calls to MCP servers running as Docker containers, managed by Docker Desktop's MCP Toolkit. One gateway exposes the full Docker MCP catalog — GitHub, Playwright, Atlassian, Slack, Notion, and many more — without spawning a separate stdio process per server.",
    icon: Container,
    transport: "stdio",
    command: "docker",
    args: ["mcp", "gateway", "run"],
    notes:
      "Requires Docker Desktop with the MCP Toolkit extension enabled. Enable the servers you want exposed in Docker Desktop → MCP Toolkit, then sign in / supply credentials there — auth and per-server config live in Docker Desktop, not in Paperclip. The gateway inherits the host's Docker socket, so make sure the user running Paperclip can talk to Docker.",
  },
  {
    key: "phpstorm",
    displayName: "PhpStorm",
    tagline: "Drive a running PhpStorm IDE — files, refactor, run",
    description:
      "Talks to a running PhpStorm (or other JetBrains IDE) via its built-in MCP server over a local SSE bridge. Lets agents read open files, navigate symbols, run inspections, and trigger refactors against the IDE's authoritative project model.",
    icon: Code2,
    transport: "stdio",
    command: "npx",
    args: ["-y", "mcp-remote", "http://127.0.0.1:64342/sse"],
    notes:
      "PhpStorm must be running on the same host as Paperclip with the JetBrains MCP plugin enabled (Settings → Tools → MCP Server). The default port is 64342 — check Settings if you've customized it. No credentials; the SSE endpoint is local-only.",
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
