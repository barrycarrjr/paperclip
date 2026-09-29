import type { Agent } from "@paperclipai/shared";
import { useAgentWorkState } from "../hooks/useAgentWorkState";
import { AgentStatusBadge } from "./AgentStatusBadge";

/**
 * Whether the agent page's header reads the Team page's state for the badge.
 *
 * Only on the dashboard tab, whose current-work panel already loads the same
 * lists under the same keys, so the header adds no request. A plugin's tab
 * also parses as the dashboard but does not show that panel, so there the
 * header would be fetching the whole company's tasks on its own. Every other
 * tab keeps the stored status.
 */
export function agentHeaderReadsWorkState(view: string, isPluginTab: boolean): boolean {
  return view === "dashboard" && !isPluginTab;
}

/**
 * The status badge in the agent page's header, so an agent waiting on you
 * says "Needs you" there too rather than "idle".
 */
export function AgentHeaderStatusBadge({
  agent,
  companyId,
  view,
  isPluginTab,
}: {
  agent: Agent;
  companyId: string | null | undefined;
  /** The page's current tab. */
  view: string;
  isPluginTab: boolean;
}) {
  const workState = useAgentWorkState(
    agent,
    companyId,
    agentHeaderReadsWorkState(view, isPluginTab),
  );
  return <AgentStatusBadge status={agent.status} workState={workState} />;
}
