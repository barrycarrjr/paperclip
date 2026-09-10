import { Link } from "@/lib/router";
import { AlertCircle, Moon, Pause, Radio, Users } from "lucide-react";
import { BOARD_MANAGER_LABEL, type TeamOrgContext, type TeamOrgRollup } from "../lib/team-hierarchy";
import { agentUrl, cn } from "../lib/utils";

/**
 * Where a team member sits in the company, in one line.
 *
 * Every operational view shows this, because the whole point of the Team
 * screens showing everybody at once is that they must not imply everybody
 * reports to the CEO. A card that says only "Backend Developer, working" in
 * a list next to the CEO reads as a flat company; the same card saying
 * "Reports to Eng Manager" does not.
 *
 * The top of the company is the one member whose manager is not an agent.
 * Their line names the board in words and does not link anywhere, because
 * the human operator has no page and is not an employee.
 */
export function ReportsToLine({
  context,
  className,
}: {
  context: TeamOrgContext;
  className?: string;
}) {
  const classes = cn("truncate text-[11px] text-muted-foreground", className);

  if (context.isTop) {
    return (
      <p className={classes} title="The CEO answers to you, the board. The board is not an agent.">
        Reports to {BOARD_MANAGER_LABEL}
      </p>
    );
  }

  if (!context.manager) {
    // Nothing to say about the reporting lines in a company that has not
    // described any. Printing "no manager set" on every card there would be
    // noise about a decision nobody has made yet.
    if (!context.reportingLinesConfigured) return null;
    return (
      <p className={classes} title="Nobody is set as this member's manager.">
        No manager set
      </p>
    );
  }

  return (
    <p className={classes}>
      Reports to{" "}
      <Link to={agentUrl(context.manager)} className="hover:text-foreground hover:underline">
        {context.manager.name}
      </Link>
    </p>
  );
}

/**
 * How a manager's own organization is getting on: how many people are
 * beneath them, and how those people are doing right now.
 *
 * This is the difference between a manager's card and an individual's. "CTO,
 * working" leaves out the thing a person at the top actually needs, which is
 * whether the technology side of the company is healthy. Nobody counted here
 * includes the manager themselves, so the state on the card and the numbers
 * under it never count the same agent twice.
 */
export function OrgRollupStrip({
  rollup,
  onOpen,
  className,
}: {
  rollup: TeamOrgRollup;
  /** Narrow the page to this manager's organization, when the view can. */
  onOpen?: () => void;
  className?: string;
}) {
  const content = (
    <>
      <span className="inline-flex items-center gap-1" title="People beneath this member">
        <Users className="h-3 w-3" />
        {rollup.total === 1 ? "1 report" : `${rollup.total} reports`}
      </span>
      {rollup.counts.working > 0 && (
        <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
          <Radio className="h-3 w-3" />
          {rollup.counts.working} working
        </span>
      )}
      {rollup.counts.idle > 0 && (
        <span className="inline-flex items-center gap-1">
          <Moon className="h-3 w-3" />
          {rollup.counts.idle} idle
        </span>
      )}
      {rollup.counts.paused > 0 && (
        <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
          <Pause className="h-3 w-3" />
          {rollup.counts.paused} paused
        </span>
      )}
      {rollup.counts.attention > 0 && (
        <span className="inline-flex items-center gap-1 font-medium text-destructive">
          <AlertCircle className="h-3 w-3" />
          {rollup.counts.attention === 1
            ? "1 needs you"
            : `${rollup.counts.attention} need you`}
        </span>
      )}
    </>
  );

  const classes = cn(
    "flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5 text-[11px] text-muted-foreground",
    className,
  );

  if (!onOpen) return <div className={classes}>{content}</div>;

  return (
    <button
      type="button"
      onClick={onOpen}
      title="Show only this organization"
      className={cn(classes, "text-left transition-colors hover:bg-accent/50 hover:text-foreground")}
    >
      {content}
    </button>
  );
}
