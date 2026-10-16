import { createHash, randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import { PLUGIN_EVENT_TYPES, type PluginEventType } from "@paperclipai/shared";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { publishLiveEvent } from "./live-events.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import { redactSensitiveTextValues, sanitizeRecord } from "../redaction.js";
import { logger } from "../middleware/logger.js";
import type { PluginEventBus } from "./plugin-event-bus.js";
import { instanceSettingsService } from "./instance-settings.js";

const PLUGIN_EVENT_SET: ReadonlySet<string> = new Set(PLUGIN_EVENT_TYPES);
const ACTIVITY_ACTION_TO_PLUGIN_EVENT: Readonly<Record<string, PluginEventType>> = {
  issue_comment_added: "issue.comment.created",
  issue_comment_created: "issue.comment.created",
  issue_document_created: "issue.document.created",
  issue_document_updated: "issue.document.updated",
  issue_document_deleted: "issue.document.deleted",
  issue_blockers_updated: "issue.relations.updated",
  approval_approved: "approval.decided",
  approval_rejected: "approval.decided",
  approval_revision_requested: "approval.decided",
  budget_soft_threshold_crossed: "budget.incident.opened",
  budget_hard_threshold_crossed: "budget.incident.opened",
  budget_incident_resolved: "budget.incident.resolved",
};

let _pluginEventBus: PluginEventBus | null = null;

/** Wire the plugin event bus so domain events are forwarded to plugins. */
export function setPluginEventBus(bus: PluginEventBus): void {
  if (_pluginEventBus) {
    logger.warn("setPluginEventBus called more than once, replacing existing bus");
  }
  _pluginEventBus = bus;
}

function eventTypeForActivityAction(action: string): PluginEventType | null {
  if (PLUGIN_EVENT_SET.has(action)) return action as PluginEventType;
  return ACTIVITY_ACTION_TO_PLUGIN_EVENT[action.replaceAll(".", "_")] ?? null;
}

export function publishPluginDomainEvent(event: PluginEvent): void {
  if (!_pluginEventBus) return;
  void _pluginEventBus.emit(event).then(({ errors }) => {
    for (const { pluginId, error } of errors) {
      logger.warn({ pluginId, eventType: event.eventType, err: error }, "plugin event handler failed");
    }
  }).catch(() => {});
}

export interface LogActivityInput {
  /** Stable UUID for an event that must be safe to retry. */
  id?: string;
  companyId: string;
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId?: string | null;
  runId?: string | null;
  responsibleUserId?: string | null;
  details?: Record<string, unknown> | null;
}

export interface PersistedActivityLogInput {
  id?: string;
  companyId: string;
  actorType: LogActivityInput["actorType"];
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId: string | null;
  runId: string | null;
  responsibleUserId: string | null;
  details: Record<string, unknown> | null;
}

// Redacts details read back from the log the same way logActivity redacts
// them on the way in, for rows written before a redaction rule existed. It
// also clears tokens written into free text, such as a comment snippet, which
// the key-based pass cannot see.
export async function createActivityDetailsRedactor(db: Db) {
  const currentUserRedactionOptions = {
    enabled: (await instanceSettingsService(db).getGeneral()).censorUsernameInLogs,
  };
  return (details: Record<string, unknown> | null) => (
    details
      ? redactCurrentUserValue(redactSensitiveTextValues(sanitizeRecord(details)), currentUserRedactionOptions)
      : null
  );
}

/**
 * Persist one activity row without publishing process-local or plugin events.
 * Callers that include the row in a larger transaction can publish the
 * returned value only after that transaction commits.
 */
export async function persistActivityLog(
  db: Db,
  input: LogActivityInput,
): Promise<PersistedActivityLogInput> {
  const currentUserRedactionOptions = {
    enabled: (await instanceSettingsService(db).getGeneral()).censorUsernameInLogs,
  };
  const sanitizedDetails = input.details ? sanitizeRecord(input.details) : null;
  const redactedDetails = sanitizedDetails
    ? redactCurrentUserValue(sanitizedDetails, currentUserRedactionOptions)
    : null;
  const persisted: PersistedActivityLogInput = {
    ...(input.id ? { id: input.id } : {}),
    companyId: input.companyId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    agentId: input.agentId ?? null,
    runId: input.runId ?? null,
    responsibleUserId: input.responsibleUserId ?? null,
    details: redactedDetails,
  };
  await db.insert(activityLog).values(persisted);
  return persisted;
}

/** Publish the non-durable notifications for an activity row that committed. */
export function publishPersistedActivityLog(input: PersistedActivityLogInput) {
  publishLiveEvent({
    companyId: input.companyId,
    type: "activity.logged",
    payload: {
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      agentId: input.agentId,
      runId: input.runId,
      responsibleUserId: input.responsibleUserId,
      details: input.details,
    },
  });

  const pluginEventType = eventTypeForActivityAction(input.action);
  if (pluginEventType) {
    const event: PluginEvent = {
      eventId: randomUUID(),
      eventType: pluginEventType,
      occurredAt: new Date().toISOString(),
      actorId: input.actorId,
      actorType: input.actorType,
      entityId: input.entityId,
      entityType: input.entityType,
      companyId: input.companyId,
      payload: {
        ...input.details,
        agentId: input.agentId,
        runId: input.runId,
        responsibleUserId: input.responsibleUserId,
      },
    };
    publishPluginDomainEvent(event);
  }
}

export async function logActivity(db: Db, input: LogActivityInput) {
  if (input.id) {
    const currentUserRedactionOptions = {
      enabled: (await instanceSettingsService(db).getGeneral()).censorUsernameInLogs,
    };
    const sanitizedDetails = input.details ? sanitizeRecord(input.details) : null;
    const persisted: PersistedActivityLogInput = {
      id: input.id,
      companyId: input.companyId,
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      agentId: input.agentId ?? null,
      runId: input.runId ?? null,
      responsibleUserId: input.responsibleUserId ?? null,
      details: sanitizedDetails
        ? redactCurrentUserValue(sanitizedDetails, currentUserRedactionOptions)
        : null,
    };
    const inserted = await db
      .insert(activityLog)
      .values(persisted)
      .onConflictDoNothing({ target: activityLog.id })
      .returning({ id: activityLog.id });
    if (inserted.length === 0) return false;
    publishPersistedActivityLog(persisted);
    return true;
  }
  const persisted = await persistActivityLog(db, input);
  publishPersistedActivityLog(persisted);
  return true;
}

export function deterministicActivityId(...parts: string[]): string {
  const hex = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}
