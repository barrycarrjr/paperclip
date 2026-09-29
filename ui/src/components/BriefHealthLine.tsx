import { Fragment } from "react";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";
import type { BriefErroredAgent, BriefHealth, BriefHealthTone } from "../lib/brief-health";

export type { BriefErroredAgent };

/** The hero's left edge on both Brief pages, coloured to match the dot. */
export const BRIEF_HEALTH_BAR_CLASS: Record<BriefHealthTone, string> = {
  green: "bg-emerald-500/55",
  amber: "bg-amber-500/55",
  red: "bg-red-500/55",
};

const DOT_CLASS: Record<BriefHealthTone, string> = {
  green: "bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.18)]",
  amber: "bg-amber-500 shadow-[0_0_0_3px_rgba(245,158,11,0.18)]",
  red: "bg-red-500 shadow-[0_0_0_3px_rgba(239,68,68,0.18)]",
};

const TEXT_CLASS: Record<BriefHealthTone, string> = {
  green: "text-emerald-600 dark:text-emerald-400",
  amber: "text-amber-600 dark:text-amber-400",
  red: "text-red-600 dark:text-red-400",
};

const NAMED_AGENTS_SHOWN = 3;

/**
 * The health dot and the line beside it at the top of the Brief. "1 agent
 * error." on its own left the operator to go and find out which one, so the
 * agents in error are named here, each linking to its own page.
 */
export function BriefHealthLine({
  health,
  erroredAgents = [],
  moreAgentsHref,
}: {
  health: BriefHealth;
  erroredAgents?: BriefErroredAgent[];
  /** Where "N more" goes when there are too many agents to name. Plain text when omitted. */
  moreAgentsHref?: string;
}) {
  const named = erroredAgents.slice(0, NAMED_AGENTS_SHOWN);
  const unnamed = erroredAgents.length - named.length;

  return (
    <span className={cn("inline-flex items-center gap-1.5", TEXT_CLASS[health.tone])}>
      <span
        aria-hidden
        data-tone={health.tone}
        className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", DOT_CLASS[health.tone])}
      />
      <span className="font-medium text-foreground">
        {health.parts.length === 0
          ? health.headline
          : health.parts.map((part, index) => (
              <Fragment key={part.kind}>
                {index > 0 && ", "}
                {part.text}
                {part.kind === "agentErrors" && named.length > 0 && (
                  <>
                    {" ("}
                    {named.map((agent, agentIndex) => (
                      <Fragment key={agent.id}>
                        {agentIndex > 0 && ", "}
                        <Link
                          to={agent.href}
                          title={agent.title}
                          className="underline underline-offset-2 hover:text-red-600 dark:hover:text-red-400"
                        >
                          {agent.name}
                        </Link>
                      </Fragment>
                    ))}
                    {unnamed > 0 &&
                      (moreAgentsHref ? (
                        <>
                          {", "}
                          <Link
                            to={moreAgentsHref}
                            className="underline underline-offset-2 hover:text-red-600 dark:hover:text-red-400"
                          >
                            {unnamed} more
                          </Link>
                        </>
                      ) : (
                        `, ${unnamed} more`
                      ))}
                    {")"}
                  </>
                )}
              </Fragment>
            ))}
        {health.parts.length > 0 && "."}
      </span>
    </span>
  );
}
