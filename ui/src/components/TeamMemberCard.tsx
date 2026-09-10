import { Link } from "@/lib/router";
import { Bot, Clock, Radio } from "lucide-react";
import { AGENT_ROLE_LABELS } from "@paperclipai/shared";
import { AgentIcon } from "./AgentIconPicker";
import { TeamMemberControls } from "./TeamMemberControls";
import type { TeamMemberActions } from "../hooks/useTeamMemberActions";
import { getAdapterLabel } from "../adapters/adapter-display-registry";
import { RUN_NOW_LINE_TONE_CLASSES } from "../lib/run-now-line";
import {
  TEAM_WORK_STATE_DESCRIPTIONS,
  TEAM_WORK_STATE_LABELS,
  type TeamAgentWork,
} from "../lib/team-current-work";
import {
  teamWorkStateBadge,
  teamWorkStateCardEdge,
  teamWorkStateDot,
  teamWorkStateDotDefault,
} from "../lib/status-colors";
import { agentUrl, cn, relativeTime } from "../lib/utils";
import { formatElapsed } from "../lib/clippy-tool-labels";

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

/**
 * One team member as a card.
 *
 * There is no progress bar here and that is on purpose. Nothing in the app
 * knows how far through its work a run is, because there is no total to
 * measure against, so a percentage would be a number somebody made up. What
 * the app genuinely knows is how long the run has been going, when the agent
 * last did something real, and whether the run has gone quiet, and all three
 * of those are on the card instead. A quiet run is the thing a percentage
 * would have hidden.
 */
export function TeamMemberCard({
  row,
  actions,
  nowMs,
}: {
  row: TeamAgentWork;
  actions: TeamMemberActions;
  /** A clock the whole page shares, so every card ticks together. */
  nowMs: number;
}) {
  const { agent } = row;
  const roleLabel = roleLabels[agent.role] ?? agent.role;
  const startedMs = row.runStartedAt ? new Date(row.runStartedAt).getTime() : null;
  const running = startedMs !== null && Number.isFinite(startedMs);
  const taskHref = row.task ? `/issues/${row.task.identifier ?? row.task.issueId}` : null;

  return (
    <div
      className={cn(
        "flex h-full flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm transition-colors",
        teamWorkStateCardEdge[row.state] ?? "border-border/70",
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted/60">
          {agent.icon ? (
            <AgentIcon icon={agent.icon} className="h-4 w-4" />
          ) : (
            <Bot className="h-4 w-4 text-muted-foreground" />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <Link
              to={agentUrl(agent)}
              className="truncate font-medium text-foreground hover:underline"
            >
              {agent.name}
            </Link>
            <span
              title={TEAM_WORK_STATE_DESCRIPTIONS[row.state]}
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium",
                teamWorkStateBadge[row.state] ?? "bg-muted text-muted-foreground",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "inline-block h-1.5 w-1.5 rounded-full",
                  teamWorkStateDot[row.state] ?? teamWorkStateDotDefault,
                )}
              />
              {TEAM_WORK_STATE_LABELS[row.state]}
            </span>
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {roleLabel}
            {agent.title ? ` - ${agent.title}` : ""}
          </p>
        </div>
      </div>

      <div className="min-w-0 space-y-1">
        <p className="text-sm text-foreground">{row.line}</p>
        {row.detail && (
          <p
            className={cn(
              "text-xs",
              row.detailTone
                ? RUN_NOW_LINE_TONE_CLASSES[row.detailTone]
                : "text-muted-foreground",
            )}
          >
            {row.detail}
          </p>
        )}
      </div>

      {taskHref && row.task && (
        <Link
          to={taskHref}
          className="flex min-w-0 items-baseline gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        >
          {row.task.identifier && (
            <span className="shrink-0 font-mono">{row.task.identifier}</span>
          )}
          <span className="truncate">{row.task.title}</span>
        </Link>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {running && (
          <span className="inline-flex items-center gap-1" title="How long this run has been going">
            <Radio className="h-3 w-3" />
            {formatElapsed(nowMs - startedMs!)} so far
          </span>
        )}
        {row.lastActivityAt && (
          <span className="inline-flex items-center gap-1" title="When this team member last did something">
            <Clock className="h-3 w-3" />
            {relativeTime(row.lastActivityAt)}
          </span>
        )}
        <span
          className="rounded border border-border/60 px-1.5 py-0.5"
          title="The provider this team member runs on"
        >
          {getAdapterLabel(agent.adapterType)}
        </span>
        {row.state !== "needs_review" && row.reviewWaiting.length > 0 && (
          <span className="text-violet-600 dark:text-violet-400">
            {row.reviewWaiting.length} waiting on your review
          </span>
        )}
      </div>

      <div className="mt-auto flex items-center justify-end pt-1">
        <TeamMemberControls row={row} actions={actions} />
      </div>
    </div>
  );
}
