import { Link } from "@/lib/router";
import { AGENT_ROLE_LABELS, type Agent } from "@paperclipai/shared";
import type { OrgNode } from "../api/agents";
import { LiveRunIndicator } from "./LiveRunIndicator";
import { StatusBadge } from "./StatusBadge";
import { agentStatusDot, agentStatusDotDefault } from "../lib/status-colors";
import { getAdapterLabel } from "../adapters/adapter-display-registry";
import { agentRouteRef, agentUrl, cn, relativeTime } from "../lib/utils";

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

export interface OrgTreeNodeProps {
  node: OrgNode;
  depth: number;
  agentMap: Map<string, Agent>;
  liveRunByAgent: Map<string, { runId: string; liveCount: number }>;
  /** When true, paused agents are rendered at reduced opacity. */
  dimPaused?: boolean;
  /**
   * When supplied, links route to `/${companyPrefix}/agents/${id}` instead of
   * the company-auto-prefixed default. Required when rendering a tree that
   * belongs to a different company than the currently-selected one (e.g. the
   * portfolio view from HQ).
   */
  companyPrefix?: string;
}

export function OrgTreeNode({
  node,
  depth,
  agentMap,
  liveRunByAgent,
  dimPaused = true,
  companyPrefix,
}: OrgTreeNodeProps) {
  const agent = agentMap.get(node.id);
  const statusColor = agentStatusDot[node.status] ?? agentStatusDotDefault;

  const linkTarget = companyPrefix
    ? `/${companyPrefix}/agents/${agent ? agentRouteRef(agent) : node.id}`
    : agent
      ? agentUrl(agent)
      : `/agents/${node.id}`;

  return (
    <div style={{ paddingLeft: depth * 24 }}>
      <Link
        to={linkTarget}
        className={cn(
          "flex items-center gap-3 px-3 py-2 hover:bg-accent/30 transition-colors w-full text-left no-underline text-inherit",
          agent?.pausedAt && dimPaused && "opacity-50",
        )}
      >
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className={`absolute inline-flex h-full w-full rounded-full ${statusColor}`} />
        </span>
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium">{node.name}</span>
          <span className="text-xs text-muted-foreground ml-2">
            {roleLabels[node.role] ?? node.role}
            {agent?.title ? ` - ${agent.title}` : ""}
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="sm:hidden">
            {liveRunByAgent.has(node.id) ? (
              <LiveRunIndicator
                agentRef={agent ? agentRouteRef(agent) : node.id}
                runId={liveRunByAgent.get(node.id)!.runId}
                liveCount={liveRunByAgent.get(node.id)!.liveCount}
              />
            ) : (
              <StatusBadge status={node.status} />
            )}
          </span>
          <div className="hidden sm:flex items-center gap-3">
            {liveRunByAgent.has(node.id) && (
              <LiveRunIndicator
                agentRef={agent ? agentRouteRef(agent) : node.id}
                runId={liveRunByAgent.get(node.id)!.runId}
                liveCount={liveRunByAgent.get(node.id)!.liveCount}
              />
            )}
            {agent && (
              <>
                <span className="w-28 whitespace-nowrap text-right font-mono text-xs text-muted-foreground">
                  {getAdapterLabel(agent.adapterType)}
                </span>
                <span className="text-xs text-muted-foreground w-16 text-right">
                  {agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "—"}
                </span>
              </>
            )}
            <span className="w-20 flex justify-end">
              <StatusBadge status={node.status} />
            </span>
          </div>
        </div>
      </Link>
      {node.reports && node.reports.length > 0 && (
        <div className="border-l border-border/50 ml-4">
          {node.reports.map((child) => (
            <OrgTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              agentMap={agentMap}
              liveRunByAgent={liveRunByAgent}
              dimPaused={dimPaused}
              companyPrefix={companyPrefix}
            />
          ))}
        </div>
      )}
    </div>
  );
}
