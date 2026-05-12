import { Link } from "@/lib/router";

export interface LiveRunIndicatorProps {
  agentRef: string;
  runId: string;
  liveCount: number;
}

/**
 * Animated pulse + count chip linking to the agent's currently-running run.
 * Used in the agent list views (per-company and portfolio) to surface that an
 * agent is actively working without having to drill into its detail page.
 */
export function LiveRunIndicator({ agentRef, runId, liveCount }: LiveRunIndicatorProps) {
  return (
    <Link
      to={`/agents/${agentRef}/runs/${runId}`}
      className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-500/10 hover:bg-blue-500/20 transition-colors no-underline"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="relative flex h-2 w-2">
        <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
      </span>
      <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">
        Live{liveCount > 1 ? ` (${liveCount})` : ""}
      </span>
    </Link>
  );
}
