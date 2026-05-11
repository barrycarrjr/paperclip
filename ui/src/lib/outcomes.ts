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
 * Whole action namespaces that are infrastructure/admin only — never a
 * user-facing outcome. Filtering at the namespace level keeps the Brief and
 * Receipt feeds curated as new sub-events get added to these subsystems.
 */
const NOISE_NAMESPACES = new Set<string>([
  "plugin",                 // plugin install/upgrade/enable/reinstall lifecycle
  "environment",            // workspace lease + env CRUD
  "routine",                // routine + trigger CRUD + scheduler firings
  "heartbeat",              // heartbeat invocations / cancellations
  "cost",                   // cost meter ticks
  "run",                    // raw run lifecycle
  "inbox",                  // user dismissing inbox items (UI side-effect)
  "secret",                 // secret CRUD
  "board_api_key",          // API key admin
  "agent_api_key",          // API key admin
  "external_mcp_server",    // MCP server config
  "execution_workspace",    // workspace state
  "hire_hook",              // hire hook plumbing
  "sidebar_preferences",    // UI prefs
  "test",                   // test fixtures
  "work_queue",             // queue CRUD
  "label",                  // label CRUD
  "memory",                 // memory store CRUD
  "invite",                 // invitation flow admin
  "join",                   // join request flow admin
  "budget",                 // budget policy + threshold pings
  "company_member",         // member admin
  "asset",                  // asset CRUD
  "finance_event",          // internal finance reporting
]);

/**
 * Specific noisy actions inside mixed-purpose namespaces where some siblings
 * are real outcomes (issue / agent / company / project / approval / goal).
 * Adding a sibling action to the OUTCOME_TABLE is the way to surface it.
 */
const NOISE_ACTIONS = new Set<string>([
  // issue.* — outcome-flavored ones live in OUTCOME_TABLE; everything else is
  // run-machinery (checkouts, holds, wakeups, indexing tweaks, read state).
  "issue.checked_out",
  "issue.released",
  "issue.updated",
  "issue.admin_force_release",
  "issue.approval_linked",
  "issue.approval_unlinked",
  "issue.approvers_updated",
  "issue.assignment_wakeup_requested",
  "issue.attachment_removed",
  "issue.blockers_updated",
  "issue.checkout_lock_adopted",
  "issue.child_created",
  "issue.comment_cancelled",
  "issue.document_deleted",
  "issue.document_restored",
  "issue.document_upserted",
  "issue.feedback_vote_saved",
  "issue.harness_liveness_escalation_created",
  "issue.inbox_archived",
  "issue.inbox_unarchived",
  "issue.read_marked",
  "issue.read_unmarked",
  "issue.reviewers_updated",
  "issue.thread_interaction_answered",
  "issue.thread_interaction_created",
  "issue.thread_interaction_expired",
  "issue.tree_cancel_status_updated",
  "issue.tree_control_previewed",
  "issue.tree_hold_created",
  "issue.tree_hold_released",
  "issue.tree_hold_run_interrupt_failed",
  "issue.tree_hold_run_interrupted",
  "issue.tree_hold_wakeup_deferred",
  "issue.tree_restore_status_updated",
  "issue.tree_restore_wakeup_requested",
  "issue.work_product_created",
  "issue.work_product_deleted",
  "issue.work_product_updated",

  // agent.* — admin and key-management; lifecycle (paused/resumed/terminated/
  // created) is what surfaces.
  "agent.approved",
  "agent.budget_updated",
  "agent.config_rolled_back",
  "agent.deleted",
  "agent.forbidden_write_paths_updated",
  "agent.hire_created",
  "agent.instructions_bundle_updated",
  "agent.instructions_file_deleted",
  "agent.instructions_file_updated",
  "agent.instructions_path_updated",
  "agent.key_created",
  "agent.key_revoked",
  "agent.permissions_updated",
  "agent.runtime_session_reset",
  "agent.skills_synced",
  "agent.updated",
  "agent.updated_from_join_replay",

  // approval.* — wakeup plumbing isn't part of the trust-loop surface.
  "approval.requester_wakeup_failed",
  "approval.requester_wakeup_queued",

  // company.* — outcomes are created/archived; the rest is admin.
  "company.branding_updated",
  "company.budget_updated",
  "company.feedback_data_sharing_updated",
  "company.imported",
  "company.skill_created",
  "company.skill_deleted",
  "company.skill_file_updated",
  "company.skill_update_installed",
  "company.skills_imported",
  "company.skills_scanned",
  "company.updated",

  // project.* — only project.created is the outcome.
  "project.deleted",
  "project.updated",
  "project.workspace_created",
  "project.workspace_deleted",
  "project.workspace_updated",

  // goal.* — only created/updated are outcomes.
  "goal.deleted",
]);

export function isOutcomeAction(action: string): boolean {
  const namespace = action.split(".", 1)[0];
  if (NOISE_NAMESPACES.has(namespace)) return false;
  if (NOISE_ACTIONS.has(action)) return false;
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
