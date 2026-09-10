import { Link } from "@/lib/router";
import { AlertCircle, ChevronRight, Network } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { TEAM_WORK_STATE_LABELS, type TeamAgentWork } from "../lib/team-current-work";
import { teamWorkStateDot, teamWorkStateDotDefault } from "../lib/status-colors";
import {
  BOARD_MANAGER_LABEL,
  chainOfCommand,
  describeRollup,
  rollupForManager,
  type TeamHierarchy,
} from "../lib/team-hierarchy";
import { agentUrl, cn } from "../lib/utils";

/**
 * Where this member sits in the company, on their own page.
 *
 * This is the drill-down the Team views point at: from the company, to an
 * executive, to a manager, to the person doing the work. Opening a manager
 * should answer what their organization is doing, not only what they
 * personally are doing, so their direct reports are listed here with their
 * live state and anything beneath them that needs a person is pulled up.
 *
 * Everything is read from the same reporting lines as the org chart. Nobody
 * is placed anywhere by this panel.
 */
export function AgentOrgPanel({
  agent,
  hierarchy,
  rows,
}: {
  agent: Agent;
  hierarchy: TeamHierarchy;
  /** One row per member of the company, for the states shown below. */
  rows: TeamAgentWork[];
}) {
  const node = hierarchy.byId.get(agent.id);
  if (!node) return null;

  const rowsById = new Map(rows.map((row) => [row.agent.id, row]));
  const chain = chainOfCommand(hierarchy, agent.id);
  const isTop = hierarchy.topId === agent.id;
  const directReports = node.directReportIds
    .map((id) => hierarchy.byId.get(id)?.agent)
    .filter((one): one is Agent => one !== undefined);
  const rollup = directReports.length > 0 ? rollupForManager(hierarchy, agent.id, rowsById) : null;

  // Nothing worth a panel: no manager, no reports, and no company shape to
  // place them in.
  if (chain.length === 0 && directReports.length === 0 && !isTop) return null;

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4">
      <h3 className="flex items-center gap-1.5 text-sm font-medium">
        <Network className="h-3.5 w-3.5 text-muted-foreground" />
        Where this sits
      </h3>

      <div>
        <p className="text-xs font-medium text-muted-foreground">Reports to</p>
        {chain.length === 0 && !isTop ? (
          <p className="text-sm text-muted-foreground">Nobody is set as this member's manager.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-1 pt-0.5 text-sm">
            {chain.map((manager, index) => (
              <span key={manager.id} className="inline-flex items-center gap-1">
                {index > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                <Link to={agentUrl(manager)} className="hover:underline">
                  {manager.name}
                </Link>
              </span>
            ))}
            {/*
              The line always ends at the board, because the board is what the
              CEO answers to. It is the human operator, so it is written in
              words and links nowhere.
            */}
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              {chain.length > 0 && <ChevronRight className="h-3 w-3" />}
              {BOARD_MANAGER_LABEL}
            </span>
          </div>
        )}
      </div>

      {directReports.length > 0 && rollup && (
        <div>
          <p className="text-xs font-medium text-muted-foreground">
            Direct reports - {directReports.length}
          </p>
          <ul className="space-y-1 pt-1">
            {directReports.map((report) => {
              const row = rowsById.get(report.id);
              return (
                <li key={report.id} className="flex min-w-0 items-center gap-1.5 text-sm">
                  <span
                    aria-hidden
                    className={cn(
                      "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
                      row ? teamWorkStateDot[row.state] ?? teamWorkStateDotDefault : "bg-muted",
                    )}
                  />
                  <Link to={agentUrl(report)} className="truncate hover:underline">
                    {report.name}
                  </Link>
                  {row && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {TEAM_WORK_STATE_LABELS[row.state]}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>

          {rollup.total > directReports.length && (
            <p className="pt-1.5 text-xs text-muted-foreground">
              Whole organization: {describeRollup(rollup)}
            </p>
          )}

          {rollup.attention.length > 0 && (
            <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-2">
              <p className="flex items-center gap-1 text-xs font-medium text-destructive">
                <AlertCircle className="h-3 w-3" />
                Needs you, beneath this member
              </p>
              <ul className="pt-1">
                {rollup.attention.map((item) => (
                  <li key={item.agent.id} className="min-w-0 text-xs">
                    <Link to={agentUrl(item.agent)} className="font-medium hover:underline">
                      {item.agent.name}
                    </Link>
                    <span className="text-muted-foreground"> - {item.line}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
