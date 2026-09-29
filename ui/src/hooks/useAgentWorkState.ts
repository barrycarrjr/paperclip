import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { buildTeamCurrentWork, type TeamWorkState } from "../lib/team-current-work";

/** Same refresh cadence as the Team page's live-run reading. */
const LIVE_RUN_REFRESH_MS = 15_000;

/** How many pending questions to read. Matches the Team page's ceiling. */
const PENDING_QUESTION_LIMIT = 50;

/**
 * The three company-wide lists that, with the agent itself, decide what an
 * agent is doing right now: live runs, tasks and questions waiting for an
 * answer.
 *
 * The agent's page reads them in two places (its header badge and the
 * current-work panel under it), and both use these exact query keys, so the
 * page asks the server once, not twice.
 */
export function useTeamWorkSources(companyId: string | null | undefined, enabled = true) {
  const on = enabled && Boolean(companyId);

  const { data: liveRuns } = useQuery({
    queryKey: [...queryKeys.liveRuns(companyId ?? "__none__"), "agent-current-work"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId!),
    refetchInterval: LIVE_RUN_REFRESH_MS,
    enabled: on,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(companyId ?? "__none__"),
    queryFn: () => issuesApi.list(companyId!),
    enabled: on,
  });

  const { data: pendingInteractions } = useQuery({
    queryKey: [
      ...queryKeys.issues.list(companyId ?? "__none__"),
      "pending-interactions",
      PENDING_QUESTION_LIMIT,
    ],
    queryFn: () => issuesApi.listPendingInteractions(companyId!, PENDING_QUESTION_LIMIT),
    enabled: on,
  });

  return { liveRuns, issues, pendingInteractions };
}

/**
 * What one agent is doing right now, decided exactly the way the Team page's
 * Right now tab decides it. Null while switched off, or for an agent the Team
 * page would not list (a terminated one).
 *
 * Switched off, it reads nothing and says nothing, rather than answering from
 * a list it is no longer keeping fresh.
 */
export function useAgentWorkState(
  agent: Agent | null | undefined,
  companyId: string | null | undefined,
  enabled = true,
): TeamWorkState | null {
  const on = enabled && Boolean(agent) && Boolean(companyId);
  const { liveRuns, issues, pendingInteractions } = useTeamWorkSources(companyId, on);

  return useMemo(() => {
    if (!on || !agent) return null;
    const rows = buildTeamCurrentWork({
      agents: [agent],
      liveRuns: liveRuns ?? [],
      issues: issues ?? [],
      pendingInteractions: pendingInteractions ?? [],
    });
    return rows[0]?.state ?? null;
  }, [on, agent, liveRuns, issues, pendingInteractions]);
}
