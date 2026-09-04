import { useQuery } from "@tanstack/react-query";
import { useActiveCompanyId } from "@/hooks/useRouteCompany";
import { Link } from "@/lib/router";
import { AGENT_ROLE_LABELS, type Agent, type AgentRuntimeState } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { getAdapterLabel } from "../adapters/adapter-display-registry";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "./StatusBadge";
import { Identity } from "./Identity";
import { formatDate, agentUrl } from "../lib/utils";
import { Separator } from "@/components/ui/separator";

interface AgentPropertiesProps {
  agent: Agent;
  runtimeState?: AgentRuntimeState;
}

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

/**
 * How old a failed run has to be before its `error` status is worth flagging
 * as possibly out of date. An hour is long enough that a genuine, current
 * failure isn't second-guessed, and short enough to catch the real case —
 * a flag left behind by a run that died days ago.
 */
const STALE_ERROR_MS = 60 * 60 * 1000;

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="text-xs text-muted-foreground shrink-0 w-20 mt-0.5">{label}</span>
      <div className="flex items-center gap-1.5 min-w-0 flex-1 flex-wrap">{children}</div>
    </div>
  );
}

export function AgentProperties({ agent, runtimeState }: AgentPropertiesProps) {
  // Was the context selection, so the agent list could briefly be the
  // previous company's after a switch. See useRouteCompany.ts.
  const selectedCompanyId = useActiveCompanyId();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && !!agent.reportsTo,
  });

  const reportsToAgent = agent.reportsTo ? agents?.find((a) => a.id === agent.reportsTo) : null;

  // An `error` status whose failing run finished a while ago. The status flag
  // itself carries no time, so without this the badge cannot be told apart
  // from a failure that happened seconds ago.
  const errorAt = runtimeState?.updatedAt ?? agent.lastHeartbeatAt ?? null;
  const staleError =
    agent.status === "error" && errorAt && Date.now() - new Date(errorAt).getTime() > STALE_ERROR_MS
      ? { at: errorAt }
      : null;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <PropertyRow label="Status">
          <StatusBadge status={agent.status} />
          {staleError && (
            // `error` is sticky: it is set when a run fails and only cleared by
            // a later successful run. An agent with its schedule switched off
            // never gets that run, so a single old failure reads forever as
            // "broken right now". Two CEOs sat like this for three days after
            // an expired login that had long since been fixed. Say how old it
            // is, so a stale flag is recognisable as stale.
            <span className="text-xs text-muted-foreground">
              since {formatDate(staleError.at)} — may already be fixed; run it to confirm
            </span>
          )}
        </PropertyRow>
        <PropertyRow label="Role">
          <span className="text-sm">{roleLabels[agent.role] ?? agent.role}</span>
        </PropertyRow>
        {agent.title && (
          <PropertyRow label="Title">
            <span className="text-sm">{agent.title}</span>
          </PropertyRow>
        )}
        <PropertyRow label="Adapter">
          <span className="text-sm font-mono">{getAdapterLabel(agent.adapterType)}</span>
        </PropertyRow>
      </div>

      <Separator />

      <div className="space-y-1">
        {(runtimeState?.sessionDisplayId ?? runtimeState?.sessionId) && (
          <PropertyRow label="Session">
            <span className="text-xs font-mono">
              {String(runtimeState.sessionDisplayId ?? runtimeState.sessionId).slice(0, 12)}...
            </span>
          </PropertyRow>
        )}
        {runtimeState?.lastError && (
          <PropertyRow label="Last error">
            <span className="text-xs text-red-600 dark:text-red-400 break-words min-w-0">{runtimeState.lastError}</span>
          </PropertyRow>
        )}
        {agent.lastHeartbeatAt && (
          <PropertyRow label="Last Heartbeat">
            <span className="text-sm">{formatDate(agent.lastHeartbeatAt)}</span>
          </PropertyRow>
        )}
        {agent.reportsTo && (
          <PropertyRow label="Reports To">
            {reportsToAgent ? (
              <Link to={agentUrl(reportsToAgent)} className="hover:underline">
                <Identity name={reportsToAgent.name} size="sm" />
              </Link>
            ) : (
              <span className="text-sm font-mono">{agent.reportsTo.slice(0, 8)}</span>
            )}
          </PropertyRow>
        )}
        <PropertyRow label="Created">
          <span className="text-sm">{formatDate(agent.createdAt)}</span>
        </PropertyRow>
      </div>
    </div>
  );
}
