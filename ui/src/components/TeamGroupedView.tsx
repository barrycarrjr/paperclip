import { useState } from "react";
import { Link } from "@/lib/router";
import { Bot, ChevronDown, ChevronRight, Filter } from "lucide-react";
import { AgentIcon } from "./AgentIconPicker";
import { TeamMemberCard } from "./TeamMemberCard";
import { TeamMemberControls } from "./TeamMemberControls";
import { OrgRollupStrip, ReportsToLine } from "./TeamOrgContextLine";
import type { TeamMemberActions } from "../hooks/useTeamMemberActions";
import {
  TEAM_WORK_STATE_DESCRIPTIONS,
  TEAM_WORK_STATE_LABELS,
  type TeamAgentWork,
} from "../lib/team-current-work";
import {
  teamWorkStateBadge,
  teamWorkStateDot,
  teamWorkStateDotDefault,
} from "../lib/status-colors";
import type { TeamGroupedSection, TeamOrgContext } from "../lib/team-hierarchy";
import { agentUrl, cn } from "../lib/utils";

/**
 * The whole company on one screen, in the shape the company actually has.
 *
 * The flat card grid answers "what is everybody doing" but it answers it as
 * though the company were flat, which it is not: it has a CEO, executives
 * who each run a part of the company, managers under them, and the people
 * doing the work. Reading a flat grid of thirty cards, there is no way to
 * see that the technology side is in trouble while marketing is fine.
 *
 * So this view keeps the same cards and the same controls, and only changes
 * what is next to what: one section per executive organization, each headed
 * by the executive with their own state AND a summary of everybody beneath
 * them. Collapse a section you are not interested in and the rest of the
 * company stays readable.
 *
 * Nothing here decides who reports to whom. The sections come from
 * lib/team-hierarchy.ts, which reads the same `reportsTo` links the org
 * chart draws.
 */
export function TeamGroupedView({
  sections,
  actions,
  nowMs,
  orgById,
  onShowOrg,
}: {
  sections: TeamGroupedSection[];
  actions: TeamMemberActions;
  nowMs: number;
  orgById: Map<string, TeamOrgContext>;
  onShowOrg: (agentId: string) => void;
}) {
  return (
    <div className="space-y-4">
      {sections.map((section) => (
        <TeamGroupSection
          key={section.id ?? "__unattached__"}
          section={section}
          actions={actions}
          nowMs={nowMs}
          orgById={orgById}
          onShowOrg={onShowOrg}
        />
      ))}
    </div>
  );
}

function TeamGroupSection({
  section,
  actions,
  nowMs,
  orgById,
  onShowOrg,
}: {
  section: TeamGroupedSection;
  actions: TeamMemberActions;
  nowMs: number;
  orgById: Map<string, TeamOrgContext>;
  onShowOrg: (agentId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const leader = section.leaderRow;
  const hasMembers = section.memberRows.length > 0;
  const leaderOrg = leader ? orgById.get(leader.agent.id) : undefined;
  // For an executive's own section the heading and the leader's name are the
  // same words, so the small heading above the name is only printed when it
  // says something else, as the top of the company's does. A section with no
  // leader at all prints its title as the heading instead, further down, so
  // it must not print it here as well.
  const showTitle = Boolean(leader) && section.title !== leader!.agent.name;

  return (
    <section className="rounded-xl border border-border/70 bg-card/40">
      <header className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-2">
          {hasMembers ? (
            <button
              type="button"
              onClick={() => setOpen((current) => !current)}
              aria-expanded={open}
              aria-label={open ? `Collapse ${section.title}` : `Expand ${section.title}`}
              className="mt-0.5 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
          ) : (
            <span className="w-5" aria-hidden />
          )}

          <div className="min-w-0">
            {showTitle && (
              <p className="pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {section.title}
              </p>
            )}
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {leader ? (
                <>
                  <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded bg-muted/60">
                    {leader.agent.icon ? (
                      <AgentIcon icon={leader.agent.icon} className="h-3.5 w-3.5" />
                    ) : (
                      <Bot className="h-3 w-3 text-muted-foreground" />
                    )}
                  </span>
                  <Link
                    to={agentUrl(leader.agent)}
                    className="truncate text-sm font-semibold hover:underline"
                  >
                    {leader.agent.name}
                  </Link>
                  <span
                    title={TEAM_WORK_STATE_DESCRIPTIONS[leader.state]}
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium",
                      teamWorkStateBadge[leader.state] ?? "bg-muted text-muted-foreground",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "inline-block h-1.5 w-1.5 rounded-full",
                        teamWorkStateDot[leader.state] ?? teamWorkStateDotDefault,
                      )}
                    />
                    {TEAM_WORK_STATE_LABELS[leader.state]}
                  </span>
                </>
              ) : (
                <h2 className="truncate text-sm font-semibold">{section.title}</h2>
              )}
            </div>

            {leader && (
              <>
                {leaderOrg && <ReportsToLine context={leaderOrg} className="pt-0.5" />}
                <p className="truncate pt-0.5 text-xs text-muted-foreground">{leader.line}</p>
              </>
            )}
            {!leader && hasMembers && section.rollup && (
              // The leader is filtered out but their people are not, so the
              // heading says whose organization this is rather than showing a
              // group of cards with no explanation.
              <p className="truncate pt-0.5 text-xs text-muted-foreground">
                {section.memberRows.length === 1
                  ? "1 person in this organization matches"
                  : `${section.memberRows.length} people in this organization match`}
              </p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {section.rollup && section.rollup.total > 0 && (
            <OrgRollupStrip rollup={section.rollup} />
          )}
          {section.id && (
            <button
              type="button"
              onClick={() => onShowOrg(section.id!)}
              title="Show only this organization"
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Filter className="h-3 w-3" />
              Only this
            </button>
          )}
          {leader && <TeamMemberControls row={leader} actions={actions} size="xs" />}
        </div>
      </header>

      {open && hasMembers && (
        <div className="grid grid-cols-1 gap-3 border-t border-border/60 p-3 sm:grid-cols-2 xl:grid-cols-3">
          {section.memberRows.map((row) => (
            <TeamMemberCard
              key={row.agent.id}
              row={row}
              actions={actions}
              nowMs={nowMs}
              org={orgById.get(row.agent.id)}
              onShowOrg={() => onShowOrg(row.agent.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
