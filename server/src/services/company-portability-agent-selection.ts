import { normalizeAgentUrlKey } from "@paperclipai/shared";

interface ExportAgentCandidate {
  id: string;
  name: string;
  status: string;
  defaultReviewerAgentId?: string | null;
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

  const allAgentsById = new Map(liveAgentRows.map((agent) => [agent.id, agent] as const));
  const pendingReviewerDependencies = [...selectedAgents.values()];
  for (const agent of pendingReviewerDependencies) {
    if (!agent.defaultReviewerAgentId || selectedAgents.has(agent.defaultReviewerAgentId)) continue;
    const reviewer = allAgentsById.get(agent.defaultReviewerAgentId);
    if (!reviewer) {
      warnings.push(`Agent ${agent.name} references a missing automatic reviewer and was exported without that link.`);
      continue;
    }
    selectedAgents.set(reviewer.id, reviewer);
    pendingReviewerDependencies.push(reviewer);
    warnings.push(`Included automatic reviewer ${reviewer.name} because it is required by ${agent.name}.`);
  }

  return { agents: Array.from(selectedAgents.values()), warnings };
}
