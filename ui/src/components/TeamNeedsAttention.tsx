import { Link } from "@/lib/router";
import { AlertCircle } from "lucide-react";
import type { TeamAttentionItem } from "../lib/team-hierarchy";
import { TEAM_WORK_STATE_LABELS } from "../lib/team-current-work";
import { teamWorkStateDot, teamWorkStateDotDefault } from "../lib/status-colors";
import { TeamMemberControls } from "./TeamMemberControls";
import type { TeamMemberActions } from "../hooks/useTeamMemberActions";
import { agentUrl, cn } from "../lib/utils";

/**
 * Everything in the company waiting on a person, wherever it is in the
 * organization.
 *
 * This exists because the operator should not have to open each department
 * to find out that a QA engineer three levels down has failing tests. The
 * problems come to the front page instead, each one saying which
 * organization it is in and who manages the member, so it is obvious both
 * what is wrong and who it belongs to.
 *
 * It only lists states the app can actually see: a question waiting for an
 * answer, finished work waiting for a look, and an agent stopped with an
 * error. A budget hard stop shows up here too, because it pauses the agent
 * with a recorded reason. Things the brief lists that the app does not
 * record as an agent state, such as a tool permission problem, are not
 * invented here; when the app learns them they belong in
 * lib/team-current-work.ts as states, and this list picks them up for free.
 */
export function TeamNeedsAttention({
  items,
  actions,
  onShowMember,
}: {
  items: TeamAttentionItem[];
  actions: TeamMemberActions;
  /** Narrow the list below to one member, when the view can. */
  onShowMember?: (agentId: string) => void;
}) {
  if (items.length === 0) return null;

  // Grouped by organization so a branch with three problems reads as one
  // unhealthy department rather than three unrelated rows.
  const groups = new Map<string, { title: string; items: TeamAttentionItem[] }>();
  for (const item of items) {
    // The top of the company has no branch because every branch is beneath
    // them, which is not the same as having no place in the company. Filing
    // an unwell CEO with the unplaced agents would say the wrong thing.
    const key = item.isTop ? "__top__" : item.branch?.id ?? "__none__";
    const title = item.isTop
      ? "Executive leadership"
      : item.branch?.name ?? "Not in the reporting line";
    const group = groups.get(key) ?? { title, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }

  return (
    <section
      data-testid="team-needs-attention"
      className="rounded-xl border border-destructive/40 bg-destructive/5 p-3"
    >
      <h2 className="flex items-center gap-1.5 px-1 pb-2 text-sm font-semibold text-destructive">
        <AlertCircle className="h-4 w-4" />
        Needs you - {items.length}
      </h2>

      <div className="space-y-3">
        {[...groups.entries()].map(([key, group]) => (
          <div key={key}>
            <p className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {group.title}
            </p>
            <ul className="space-y-1.5">
              {group.items.map((item) => (
                <li
                  key={item.row.agent.id}
                  className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span
                        aria-hidden
                        className={cn(
                          "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
                          teamWorkStateDot[item.row.state] ?? teamWorkStateDotDefault,
                        )}
                      />
                      {onShowMember ? (
                        <button
                          type="button"
                          onClick={() => onShowMember(item.row.agent.id)}
                          className="truncate text-sm font-medium hover:underline"
                        >
                          {item.row.agent.name}
                        </button>
                      ) : (
                        <Link
                          to={agentUrl(item.row.agent)}
                          className="truncate text-sm font-medium hover:underline"
                        >
                          {item.row.agent.name}
                        </Link>
                      )}
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {TEAM_WORK_STATE_LABELS[item.row.state]}
                      </span>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">{item.row.line}</p>
                    {item.row.detail && (
                      <p className="truncate text-[11px] text-muted-foreground">{item.row.detail}</p>
                    )}
                    {item.manager && (
                      <p className="truncate text-[11px] text-muted-foreground">
                        Reports to {item.manager.name}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 justify-end">
                    <TeamMemberControls row={item.row} actions={actions} size="xs" />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
