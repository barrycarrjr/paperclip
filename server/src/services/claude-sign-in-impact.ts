/**
 * How many agents on this machine cannot sign in to Claude.
 *
 * Agents share one Claude sign-in per machine unless they have been given their
 * own saved token, so when that sign-in stops working every agent that relies on
 * it stops working - across every company on the machine. The failure page could
 * only ever see the one agent it was showing, which is how ten agents in several
 * companies came to be failing for three days while each of their pages implied
 * a problem with that agent alone.
 *
 * Deliberately just a number. The count crosses company boundaries, so it says
 * how many rather than which: an operator with access to one company learns that
 * the machine's sign-in is broken, which is a fact about their own agents too,
 * without learning anything about anyone else's.
 */

import { and, eq, not, sql } from "drizzle-orm";
import { agents as agentsTable, heartbeatRuns, type Db } from "@paperclipai/db";

/** The error code adapters use when a Claude sign-in is what failed. */
const CLAUDE_AUTH_ERROR_CODE = "claude_auth_required";

export interface ClaudeSignInImpact {
  /** Agents whose most recent run failed because Claude could not sign in. */
  signedOutAgents: number;
}

/**
 * Counted from each agent's MOST RECENT run, not from its failures.
 *
 * An agent that failed to sign in yesterday and has succeeded since is not
 * broken now, and counting its old failures would inflate the number every time
 * an operator looked. This is "how many are broken right now".
 */
export async function countClaudeSignedOutAgents(
  db: Db,
  options: { excludeAgentId?: string | null } = {},
): Promise<ClaudeSignInImpact> {
  const latestRun = db
    .select({
      agentId: heartbeatRuns.agentId,
      errorCode: heartbeatRuns.errorCode,
      rank: sql<number>`row_number() over (partition by ${heartbeatRuns.agentId} order by ${heartbeatRuns.createdAt} desc)`.as(
        "rank",
      ),
    })
    .from(heartbeatRuns)
    .as("latest_run");

  const rows = await db
    .select({ agentId: agentsTable.id })
    .from(agentsTable)
    .innerJoin(latestRun, eq(latestRun.agentId, agentsTable.id))
    .where(
      and(
        eq(agentsTable.adapterType, "claude_local"),
        not(eq(agentsTable.status, "terminated")),
        eq(latestRun.rank, 1),
        eq(latestRun.errorCode, CLAUDE_AUTH_ERROR_CODE),
      ),
    );

  const excluded = options.excludeAgentId ?? null;
  const signedOutAgents = rows.filter((row) => row.agentId !== excluded).length;
  return { signedOutAgents };
}

/**
 * Does this agent carry its own Claude token, rather than sharing the machine's?
 *
 * Reads the binding, never a value: the adapter config holds a pointer to a
 * stored secret. Exported so the route and its tests agree on what "has its own
 * token" means, since the shape is easy to get subtly wrong.
 */
export function agentHasOwnClaudeToken(adapterConfig: unknown): boolean {
  if (!adapterConfig || typeof adapterConfig !== "object") return false;
  const env = (adapterConfig as Record<string, unknown>).env;
  if (!env || typeof env !== "object") return false;
  const binding = (env as Record<string, unknown>).CLAUDE_CODE_OAUTH_TOKEN;
  if (!binding) return false;
  if (typeof binding === "string") return binding.trim().length > 0;
  if (typeof binding !== "object") return false;
  const record = binding as Record<string, unknown>;
  if (record.type === "secret_ref") return typeof record.secretId === "string" && record.secretId.length > 0;
  if (record.type === "plain") return typeof record.value === "string" && record.value.trim().length > 0;
  return false;
}
