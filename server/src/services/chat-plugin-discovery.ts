import type { AnthropicToolSpec } from "./chat-tools.js";

/** Give adapter sessions a compact index even when their MCP tools are deferred. */
export function pluginDiscoveryInstructions(tools: Pick<AnthropicToolSpec, "name" | "description">[]): string {
  if (tools.length === 0) return "";
  const groups = new Map<string, string[]>();
  for (const tool of tools) {
    const separator = tool.name.indexOf("__");
    const plugin = separator < 0 ? tool.name : tool.name.slice(0, separator);
    const label = tool.description.split(" — ")[0].replace(/\s+/g, " ").slice(0, 160);
    const entries = groups.get(plugin) ?? [];
    entries.push(`${tool.name} (${label})`);
    groups.set(plugin, entries);
  }
  return [
    "Installed plugin tool directory for this turn (availability is not proof of company setup):",
    ...[...groups].map(([plugin, entries]) => `- ${plugin}: ${entries.join("; ")}`),
    "Choose the plugin that owns the requested task before searching unrelated records, using a local shell, or asking for credentials. If its tools are deferred, discover their full schemas first (for example with ToolSearch); use the matching tool names above. A plugin may use saved company credentials that are different from the local shell's identity. A local access-denied error does not establish that the plugin lacks access. Try the relevant plugin workflow and report its actual setup or permission result. Never retrieve secret values into a shell or bypass a plugin's company access, user permission, or repair confirmation checks.",
  ].join("\n");
}
