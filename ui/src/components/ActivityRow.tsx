import { Link } from "@/lib/router";
import { Identity } from "./Identity";
import { IssueReferenceActivitySummary } from "./IssueReferenceActivitySummary";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import { formatActivityVerb } from "../lib/activity-format";
import { deriveProjectUrlKey, type ActivityEvent, type Agent } from "@paperclipai/shared";
import type { CompanyUserProfile } from "../lib/company-members";

/**
 * Build the canonical in-app link for an activity entity. Pass
 * opts.companyPrefix (like "/ACME") to get a company-scoped path for
 * portfolio surfaces; when it is missing the path is unprefixed.
 */
export function entityLink(
  entityType: string,
  entityId: string,
  name?: string | null,
  opts?: { companyPrefix?: string | null },
): string | null {
  const prefix = opts?.companyPrefix ?? "";
  switch (entityType) {
    case "issue": return `${prefix}/issues/${name ?? entityId}`;
    case "agent": return `${prefix}/agents/${entityId}`;
    case "project": return `${prefix}/projects/${deriveProjectUrlKey(name, entityId)}`;
    case "goal": return `${prefix}/goals/${entityId}`;
    case "approval": return `${prefix}/approvals/${entityId}`;
    default: return null;
  }
}

interface ActivityRowProps {
  event: ActivityEvent;
  agentMap: Map<string, Agent>;
  userProfileMap?: Map<string, CompanyUserProfile>;
  entityNameMap: Map<string, string>;
  entityTitleMap?: Map<string, string>;
  /**
   * Company-scoped path prefix (like "/ACME") for portfolio surfaces.
   * When absent, links stay unprefixed (the single-company default).
   */
  companyPrefix?: string;
  className?: string;
}

export function ActivityRow({ event, agentMap, userProfileMap, entityNameMap, entityTitleMap, companyPrefix, className }: ActivityRowProps) {
  const verb = formatActivityVerb(event.action, event.details, { agentMap, userProfileMap });

  const isHeartbeatEvent = event.entityType === "heartbeat_run";
  const heartbeatAgentId = isHeartbeatEvent
    ? (event.details as Record<string, unknown> | null)?.agentId as string | undefined
    : undefined;

  const name = isHeartbeatEvent
    ? (heartbeatAgentId ? entityNameMap.get(`agent:${heartbeatAgentId}`) : null)
    : entityNameMap.get(`${event.entityType}:${event.entityId}`);

  const entityTitle = entityTitleMap?.get(`${event.entityType}:${event.entityId}`);

  const link = isHeartbeatEvent && heartbeatAgentId
    ? `${companyPrefix ?? ""}/agents/${heartbeatAgentId}/runs/${event.entityId}`
    : entityLink(event.entityType, event.entityId, name, { companyPrefix });

  const actor = event.actorType === "agent" ? agentMap.get(event.actorId) : null;
  const userProfile = event.actorType === "user" ? userProfileMap?.get(event.actorId) : null;
  const actorName = actor?.name ?? (event.actorType === "system" ? "System" : userProfile?.label ?? (event.actorType === "user" ? "Board" : event.actorId || "Unknown"));
  const actorAvatarUrl = userProfile?.image ?? null;

  const headline = (
    <div className="flex gap-3">
      <p className="flex-1 min-w-0 truncate">
        <Identity
          name={actorName}
          avatarUrl={actorAvatarUrl}
          size="xs"
          className="align-middle"
        />
        <span className="text-muted-foreground ml-1">{verb} </span>
        {name && <span className="font-medium">{name}</span>}
        {entityTitle && <span className="text-muted-foreground ml-1">— {entityTitle}</span>}
      </p>
      <span className="text-xs text-muted-foreground shrink-0 pt-0.5">{timeAgo(event.createdAt)}</span>
    </div>
  );

  const classes = cn(
    "px-4 py-2 text-sm space-y-2",
    link && "hover:bg-accent/50 transition-colors",
    className,
  );

  // The headline links to the activity's primary entity, while the
  // IssueReferenceActivitySummary renders its own per-issue pill links. We
  // keep them as siblings so anchors never nest.
  return (
    <div className={classes}>
      {link ? (
        <Link to={link} className="no-underline text-inherit block cursor-pointer">
          {headline}
        </Link>
      ) : (
        headline
      )}
      <IssueReferenceActivitySummary event={event} />
    </div>
  );
}
