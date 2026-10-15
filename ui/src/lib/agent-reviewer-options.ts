import type { Agent } from "@paperclipai/shared";

export type AutomaticReviewerOption = {
  id: string;
  label: string;
  unavailable: boolean;
};

export function getAutomaticReviewerOptions(
  agents: Agent[],
  currentAgentId: string,
  selectedReviewerId: string,
): AutomaticReviewerOption[] {
  const options = agents
    .filter((agent) => (
      agent.id !== currentAgentId
      && agent.status !== "terminated"
      && agent.status !== "pending_approval"
    ))
    .map((agent) => ({ id: agent.id, label: agent.name, unavailable: false }));

  if (selectedReviewerId && !options.some((option) => option.id === selectedReviewerId)) {
    const selectedAgent = agents.find((agent) => agent.id === selectedReviewerId);
    options.push({
      id: selectedReviewerId,
      label: `${selectedAgent?.name ?? "Saved reviewer"} (unavailable)`,
      unavailable: true,
    });
  }

  return options;
}
