import { normalizeAgentUrlKey } from "@paperclipai/shared";

interface ExportAgentCandidate {
  id: string;
  name: string;
  status: string;
}

/**
 * The agents a company export takes, and the warnings about the ones it
 * skips. Shared by the export itself and the export routes, which must judge
 * exactly the agents the export will read, as upstream.
 */
export function resolvePortableExportAgentSelection<T extends ExportAgentCandidate>(
  allAgentRows: T[],
  selectors: string[] | undefined,
  includeAgents: boolean,
): { agents: T[]; warnings: string[] } {
  const warnings: string[] = [];
  const liveAgentRows = allAgentRows.filter((agent) => agent.status !== "terminated");
  if (includeAgents) {
    const skipped = allAgentRows.length - liveAgentRows.length;
    if (skipped > 0) {
      warnings.push(`Skipped ${skipped} terminated agent${skipped === 1 ? "" : "s"} from export.`);
    }
  }

  const agentByReference = new Map<string, T>();
  for (const agent of liveAgentRows) {
    agentByReference.set(agent.id, agent);
    agentByReference.set(agent.name, agent);
    const normalizedName = normalizeAgentUrlKey(agent.name);
    if (normalizedName) {
      agentByReference.set(normalizedName, agent);
    }
  }

  const selectedAgents = new Map<string, T>();
  for (const selector of selectors ?? []) {
    const trimmed = selector.trim();
    if (!trimmed) continue;
    const normalized = normalizeAgentUrlKey(trimmed) ?? trimmed;
    const match = agentByReference.get(trimmed) ?? agentByReference.get(normalized);
    if (!match) {
      warnings.push(`Agent selector "${selector}" was not found and was skipped.`);
      continue;
    }
    selectedAgents.set(match.id, match);
  }

  if (includeAgents && selectedAgents.size === 0) {
    for (const agent of liveAgentRows) {
      selectedAgents.set(agent.id, agent);
    }
  }

  return { agents: Array.from(selectedAgents.values()), warnings };
}
