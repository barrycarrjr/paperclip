import type { ActivityEvent, Agent } from "@paperclipai/shared";

export type OutcomeTone = "emerald" | "amber" | "sky" | "violet" | "red" | "muted";

export type OutcomeCategory =
  | "approval"
  | "issue"
  | "agent"
  | "project"
  | "goal"
  | "draft"
  | "system"
  | "other";

export interface Outcome {
  /** verb-led summary, e.g. "Approved", "Drafted reply", "Created issue" */
  verb: string;
  /** descriptive target appended after the verb, e.g. "the support escalation" */
  target?: string | null;
  /** short outcome chip text, e.g. "approved", "drafted", "created" */
  chip: string;
  /** color tone for the chip + icon */
  tone: OutcomeTone;
  /** filter category for the receipt feed tabs */
  category: OutcomeCategory;
}

interface SummarizeOptions {
  agentMap?: Map<string, Agent>;
}

/**
 * Lookup table mapping the operational `entity.action` vocabulary used by the
 * activity log into outcome-shaped summaries (verb-led, user-readable). Adding
 * an entry here is the way to surface a new event in the Receipt feed.
 */
const OUTCOME_TABLE: Record<
  string,
  Pick<Outcome, "verb" | "chip" | "tone" | "category">
> = {
  // Approvals — these are the heart of the trust loop. "Drafted" maps to the
  // amber awaiting-you state; "Approved/Rejected" map to terminal outcomes.
  // "Sent" / "Send failed" surface the actual side-effect of an approved
  // draft, recorded by the trust-loop hook in routes/approvals.ts.
  "approval.created": { verb: "Drafted", chip: "drafted", tone: "amber", category: "draft" },
  "approval.approved": { verb: "Approved", chip: "approved", tone: "emerald", category: "approval" },
  "approval.rejected": { verb: "Rejected", chip: "rejected", tone: "red", category: "approval" },
  "approval.executed": { verb: "Sent", chip: "sent", tone: "emerald", category: "approval" },
  "approval.execute_failed": { verb: "Send failed for", chip: "send-failed", tone: "red", category: "approval" },

  // Issues — outcome-flavored only. We deliberately skip "checked_out" /
  // "released" because they are run-machinery, not user-visible outcomes.
  "issue.created": { verb: "Created issue", chip: "created", tone: "sky", category: "issue" },
  "issue.commented": { verb: "Commented on", chip: "commented", tone: "emerald", category: "issue" },
  "issue.comment_added": { verb: "Commented on", chip: "commented", tone: "emerald", category: "issue" },
  "issue.attachment_added": { verb: "Attached file to", chip: "attached", tone: "emerald", category: "issue" },
  "issue.document_created": { verb: "Created document for", chip: "documented", tone: "emerald", category: "issue" },
  "issue.document_updated": { verb: "Updated document on", chip: "documented", tone: "emerald", category: "issue" },
  "issue.deleted": { verb: "Deleted issue", chip: "deleted", tone: "red", category: "issue" },

  // Agents — lifecycle changes that the operator cares about.
  "agent.created": { verb: "Hired agent", chip: "hired", tone: "sky", category: "agent" },
  "agent.paused": { verb: "Paused agent", chip: "paused", tone: "amber", category: "agent" },
  "agent.resumed": { verb: "Resumed agent", chip: "resumed", tone: "emerald", category: "agent" },
  "agent.terminated": { verb: "Terminated agent", chip: "terminated", tone: "red", category: "agent" },

  // Projects + Goals.
  "project.created": { verb: "Created project", chip: "created", tone: "sky", category: "project" },
  "goal.created": { verb: "Created goal", chip: "created", tone: "sky", category: "goal" },
  "goal.updated": { verb: "Updated goal", chip: "updated", tone: "emerald", category: "goal" },

  // Companies (rare in feeds, but we render them rather than dropping them).
  "company.created": { verb: "Created company", chip: "created", tone: "sky", category: "system" },
  "company.archived": { verb: "Archived company", chip: "archived", tone: "muted", category: "system" },
};

/**
 * Actions that exist in the activity log but are pure machinery (heartbeats,
 * checkouts, runtime sessions, cost ticks). The Receipt feed and Morning
 * Brief filter these out so the user sees outcomes, not noise.
 */
const NOISE_ACTIONS = new Set<string>([
  "issue.checked_out",
  "issue.released",
  "issue.updated", // generic updates produce a lot of churn — show only specific ones
  "issue.comment_cancelled",
  "issue.attachment_removed",
  "issue.document_deleted",
  "issue.feedback_vote_saved",
  "agent.updated",
  "agent.key_created",
  "agent.budget_updated",
  "agent.runtime_session_reset",
  "heartbeat.invoked",
  "heartbeat.cancelled",
  "cost.recorded",
  "cost.reported",
  "company.updated",
  "company.budget_updated",
  "project.updated",
  "project.deleted",
  "goal.deleted",
]);

export function isOutcomeAction(action: string): boolean {
  if (NOISE_ACTIONS.has(action)) return false;
  // Plugin, environment, and routine lifecycle/admin events are infrastructure
  // noise (lease acquired/released, plugin reinstalled, routine run triggered).
  if (action.startsWith("plugin.")) return false;
  if (action.startsWith("environment.")) return false;
  if (action.startsWith("routine.")) return false;
  if (action in OUTCOME_TABLE) return true;
  // Unknown actions: keep them, but mark as "other" so the feed can show them
  // rather than swallowing genuinely new event types.
  return true;
}

function detailString(event: ActivityEvent, ...keys: string[]): string | null {
  const details = event.details;
  for (const key of keys) {
    const value = details?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function entityTarget(event: ActivityEvent): string | null {
  if (event.entityType === "issue") {
    const ident = detailString(event, "identifier", "issueIdentifier");
    const title = detailString(event, "issueTitle", "title");
    if (ident && title) return `${ident} — ${title}`;
    return ident ?? title;
  }
  if (event.entityType === "approval") {
    return detailString(event, "title", "summary", "approvalLabel");
  }
  if (event.entityType === "agent") {
    return detailString(event, "agentName", "name");
  }
  if (event.entityType === "project") {
    return detailString(event, "projectName", "name", "title");
  }
  if (event.entityType === "goal") {
    return detailString(event, "goalTitle", "title", "name");
  }
  return detailString(event, "title", "name", "summary");
}

export function summarizeOutcome(event: ActivityEvent, _opts: SummarizeOptions = {}): Outcome {
  const target = entityTarget(event);
  const known = OUTCOME_TABLE[event.action];
  if (known) {
    return { ...known, target };
  }
  // Fallback: humanize the action string. e.g. "tool.email_send" → "Email send".
  const cleaned = event.action.split(".").slice(-1)[0]?.replace(/_/g, " ") ?? event.action;
  const verb = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  return {
    verb,
    target,
    chip: cleaned,
    tone: "muted",
    category: "other",
  };
}

export const OUTCOME_CATEGORY_LABELS: Record<OutcomeCategory | "all", string> = {
  all: "All",
  draft: "Drafts",
  approval: "Approvals",
  issue: "Issues",
  agent: "Agents",
  project: "Projects",
  goal: "Goals",
  system: "System",
  other: "Other",
};
