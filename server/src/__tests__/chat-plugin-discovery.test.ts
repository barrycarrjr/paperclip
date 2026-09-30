import { describe, expect, it } from "vitest";
import { pluginDiscoveryInstructions } from "../services/chat-plugin-discovery.js";
import { systemPromptFor, type ChatSession } from "../services/chat.js";

describe("Clippy plugin discovery context", () => {
  it("includes the live tool directory in the turn's system instructions", () => {
    const prompt = systemPromptFor({ pageContext: null } as ChatSession, "company-a", [
      { name: "customer-support__support_open_case", description: "Investigate a computer — Uses saved company support access", input_schema: { type: "object", properties: {} } },
    ]);
    expect(prompt).toContain("customer-support__support_open_case (Investigate a computer)");
    expect(prompt).toContain("Current company id (default for tools that take companyId): company-a");
  });
  it("gives deferred-tool adapters an index including newly installed support tools", () => {
    const directory = pluginDiscoveryInstructions([
      { name: "backup-tools__list", description: "List backups — Read backup records" },
      { name: "customer-support__support_open_case", description: "Investigate a computer — Uses saved company support access" },
      { name: "customer-support__support_diagnose_case", description: "Check the computer — Run diagnostics" },
    ]);
    expect(directory).toContain("customer-support__support_open_case (Investigate a computer)");
    expect(directory).toContain("customer-support__support_diagnose_case (Check the computer)");
    expect(directory).toContain("ToolSearch");
    expect(directory).toContain("different from the local shell's identity");
    expect(directory).toContain("repair confirmation checks");
  });
  it("does not invent support tools when the plugin is absent", () => {
    expect(pluginDiscoveryInstructions([])).toBe("");
    const directory = pluginDiscoveryInstructions([{ name: "example__lookup", description: "Lookup — Find a record" }]);
    expect(directory).not.toContain("customer-support");
    expect(directory).toContain("availability is not proof of company setup");
    expect(directory).not.toContain("Find a record"); // compact labels; discovery supplies schemas/descriptions
  });
});
