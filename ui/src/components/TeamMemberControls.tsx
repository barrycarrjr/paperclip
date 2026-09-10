import { Link, useNavigate } from "@/lib/router";
import {
  MoreHorizontal,
  Pause,
  Play,
  Square,
  MessageSquareReply,
  ClipboardCheck,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { agentUrl } from "../lib/utils";
import type { TeamMemberActions } from "../hooks/useTeamMemberActions";
import type { TeamAgentWork } from "../lib/team-current-work";

/**
 * The controls next to one team member, on the card view and the table view
 * alike.
 *
 * Every button here calls something the app already does; nothing new was
 * invented for the sake of a control strip. Wake now is the same call the
 * agent's own page makes with its Invoke button, Pause and Resume are the
 * same two calls, and Stop run cancels the live run exactly as the run page
 * does. Answer and Review are not agent controls at all: they are the two
 * places a person has to go to unblock the work, so they sit here rather
 * than making you hunt for the task.
 *
 * The split between the one button on show and the rest behind the menu is
 * deliberate. The visible button is whatever this member's current state
 * says the next move is, so a row that needs you offers Answer and a row
 * that is running offers Stop, without you reading anything first.
 */

/** What the state of a row says the obvious next move is. */
function primaryActionFor(row: TeamAgentWork): "answer" | "review" | "stop" | "resume" | "wake" {
  if (row.state === "needs_you") return "answer";
  if (row.state === "needs_review") return "review";
  if (row.runId) return "stop";
  if (row.agent.status === "paused") return "resume";
  return "wake";
}

function taskHref(row: TeamAgentWork): string | null {
  if (!row.task) return null;
  return `/issues/${row.task.identifier ?? row.task.issueId}`;
}

export function TeamMemberControls({
  row,
  actions,
  size = "sm",
}: {
  row: TeamAgentWork;
  actions: TeamMemberActions;
  /** "sm" on a card, "xs" in a table row. */
  size?: "sm" | "xs";
}) {
  const navigate = useNavigate();
  const { agent } = row;
  const href = taskHref(row);
  const primary = primaryActionFor(row);
  const buttonSize = size === "xs" ? "xs" : "sm";
  const iconSize = size === "xs" ? "icon-xs" : "icon-sm";
  const disabled = actions.busy || agent.status === "terminated";

  const primaryButton = (() => {
    switch (primary) {
      case "answer":
        return href ? (
          <Button asChild size={buttonSize} variant="default">
            <Link to={href}>
              <MessageSquareReply />
              Answer
            </Link>
          </Button>
        ) : null;
      case "review":
        return href ? (
          <Button asChild size={buttonSize} variant="default">
            <Link to={href}>
              <ClipboardCheck />
              Review
            </Link>
          </Button>
        ) : null;
      case "stop":
        return (
          <Button
            size={buttonSize}
            variant="outline"
            disabled={disabled}
            onClick={() => row.runId && actions.stopRun.mutate(row.runId)}
            title="Stop the run that is going right now"
          >
            <Square />
            Stop
          </Button>
        );
      case "resume":
        return (
          <Button
            size={buttonSize}
            variant="outline"
            disabled={disabled}
            onClick={() => actions.resume.mutate(agent.id)}
            title="Let this team member pick work up again"
          >
            <Play />
            Resume
          </Button>
        );
      case "wake":
      default:
        return (
          <Button
            size={buttonSize}
            variant="outline"
            disabled={disabled}
            onClick={() => actions.wake.mutate(agent.id)}
            title="Start a run now instead of waiting for the schedule"
          >
            <Zap />
            Wake
          </Button>
        );
    }
  })();

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {primaryButton}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size={iconSize} aria-label={`More actions for ${agent.name}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => navigate(agentUrl(agent))}>
            Open {agent.name}
          </DropdownMenuItem>
          {href && (
            <DropdownMenuItem onSelect={() => navigate(href)}>Open current task</DropdownMenuItem>
          )}
          {row.runId && (
            <DropdownMenuItem
              onSelect={() => navigate(`${agentUrl(agent)}/runs/${row.runId}`)}
            >
              Open the live run
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          {primary !== "wake" && agent.status !== "paused" && (
            <DropdownMenuItem disabled={disabled} onSelect={() => actions.wake.mutate(agent.id)}>
              Wake now
            </DropdownMenuItem>
          )}
          {row.runId && primary !== "stop" && (
            <DropdownMenuItem
              disabled={disabled}
              onSelect={() => row.runId && actions.stopRun.mutate(row.runId)}
            >
              Stop the run
            </DropdownMenuItem>
          )}
          {agent.status === "paused" ? (
            <DropdownMenuItem disabled={disabled} onSelect={() => actions.resume.mutate(agent.id)}>
              <Play />
              Resume
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled={disabled} onSelect={() => actions.pause.mutate(agent.id)}>
              <Pause />
              Pause
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
