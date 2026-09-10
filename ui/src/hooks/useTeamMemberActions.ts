import { useMutation, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";

/**
 * The four things a person can do to a team member from a list: wake it,
 * pause it, let it go again, or stop the run it is in the middle of.
 *
 * All four already existed on the agent's own page; this only gathers them
 * so the card view, the table view and the agent's own page call the same
 * code and report the same way when something goes wrong.
 *
 * It lives in its own file rather than beside the buttons because a file
 * that exports both a hook and a component cannot be hot-reloaded in place
 * while the app is running, and this one is edited alongside the views.
 */
export function useTeamMemberActions(companyId: string) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  // One invalidation set for all of them: every control changes what the
  // roster, the live-run list or both should say, and getting that wrong is
  // how a button ends up looking like it did nothing.
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.liveRuns(companyId) });
  };

  const fail = (what: string) => (error: unknown) =>
    pushToast({
      title: `Could not ${what}`,
      body: error instanceof Error ? error.message : String(error),
      tone: "error",
    });

  const pause = useMutation({
    mutationFn: (agentId: string) => agentsApi.pause(agentId, companyId),
    onSuccess: (agent) => {
      refresh();
      pushToast({ title: `${agent.name} paused`, tone: "info" });
    },
    onError: fail("pause that team member"),
  });

  const resume = useMutation({
    mutationFn: (agentId: string) => agentsApi.resume(agentId, companyId),
    onSuccess: (agent) => {
      refresh();
      pushToast({ title: `${agent.name} resumed`, tone: "success" });
    },
    onError: fail("resume that team member"),
  });

  const wake = useMutation({
    mutationFn: (agentId: string) => agentsApi.invoke(agentId, companyId),
    onSuccess: () => {
      refresh();
      pushToast({ title: "Woken up", body: "A run has been started.", tone: "success" });
    },
    onError: fail("wake that team member"),
  });

  const stopRun = useMutation({
    mutationFn: (runId: string) => heartbeatsApi.cancel(runId),
    onSuccess: () => {
      refresh();
      pushToast({ title: "Run stopped", tone: "info" });
    },
    onError: fail("stop that run"),
  });

  const busy = pause.isPending || resume.isPending || wake.isPending || stopRun.isPending;

  // Returned fresh each render rather than memoised. Memoising it on `busy`
  // alone would hand the buttons mutation objects from an earlier render,
  // which works today only because `.mutate` happens to be stable, and would
  // silently start lying the first time anything else on them is read.
  return { pause, resume, wake, stopRun, busy };
}

export type TeamMemberActions = ReturnType<typeof useTeamMemberActions>;
