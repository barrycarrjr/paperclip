/**
 * Tool Draft Gate — the trust loop.
 *
 * When an agent calls a mutating outbound tool (send email, post to Slack,
 * place a phone call), the gate intercepts the call, persists the parameters
 * as a pending approval, and returns a synthesized "drafted, awaiting your
 * tap" result to the agent. The user reviews the draft in their inbox /
 * morning brief and approves to actually execute the tool, or rejects to
 * drop it.
 *
 * This is the wiring change that turns the existing action surface (which
 * could already send emails / DMs / make calls) into a draft queue: the
 * agent does the same work, but the side effect waits on a one-tap human
 * review.
 *
 * Scope:
 *   - Hardcoded gate list (see OUTBOUND_TOOL_DRAFT_GATE in @paperclipai/shared).
 *   - Single instance setting (`outboundToolDraftMode`) to enable/disable.
 *   - Self-notification bypass: a gated call whose every recipient is the
 *     operator themselves (per `general.selfNotify`) is a notification, not
 *     an outward message, and executes immediately (see
 *     OUTBOUND_SELF_RECIPIENT_RULES in @paperclipai/shared).
 *   - Re-execution of approved drafts goes through the same dispatcher path
 *     the agent would have taken, so manifest validation, capability checks,
 *     and worker routing are all unchanged.
 */

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issueApprovals, issues } from "@paperclipai/db";
import { isAgentStatusInvokable } from "@paperclipai/shared/agent-eligibility";
import {
  DEFAULT_SELF_NOTIFY_SETTINGS,
  isUuidLike,
  isLikelyMutationToolName,
  OUTBOUND_SELF_RECIPIENT_RULES,
  OUTBOUND_TOOL_DRAFT_GATE,
  type AgentActionMode,
  type AgentActionType,
  type SelfNotifySettings,
  type SelfRecipientKind,
  type SelfRecipientRule,
} from "@paperclipai/shared";
import type { ToolRunContext, ToolResult } from "@paperclipai/plugin-sdk";
import { approvalService } from "./approvals.js";
import { issueApprovalService } from "./issue-approvals.js";
import { instanceSettingsService } from "./instance-settings.js";
import { deterministicActivityId, logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";
import { HttpError } from "../errors.js";

const log = logger.child({ service: "tool-draft-gate" });

export function isAgentActionRefusalReason(reason: unknown): boolean {
  if (typeof reason !== "string") return false;
  return reason.startsWith("[EDISABLED]") ||
    reason.startsWith("[ETOOL_BLOCKED]") ||
    reason.startsWith("[ECOMPANY_NOT_ALLOWED]");
}

/**
 * The set of tool names the gate intercepts, materialized as a Set for O(1)
 * lookup. Names are in `<pluginKey>:<toolName>` form, matching the namespaced
 * names that flow through `dispatcher.executeTool`.
 */
const GATED_TOOLS = new Set<string>(OUTBOUND_TOOL_DRAFT_GATE);

const LEGACY_ACTION_TYPES = new Map<string, AgentActionType>([
  ["github-tools:github_create_release", "post_publicly"],
  ["email-tools:email_send", "send_message"],
  ["email-tools:email_reply", "send_message"],
  ["email-tools:email_mark_read", "change_knowledge_base"],
  ["email-tools:email_mark_unread", "change_knowledge_base"],
  ["email-tools:email_move", "change_knowledge_base"],
  // Not an action: see AGENT_BOOKKEEPING_TOOLS.
  // ["email-tools:email_set_triage_cursor", "change_knowledge_base"],
  // ["email-tools:email_add_to_review_queue", "change_knowledge_base"],
  ["email-tools:email_save_contact", "change_knowledge_base"],
  ["email-tools:email_import_contacts", "change_knowledge_base"],
  ["help-scout:helpscout_send_reply", "send_message"],
  ["help-scout:helpscout_create_conversation", "send_message"],
  ["slack-tools:slack_send_dm", "send_message"],
  ["slack-tools:slack_send_channel", "send_message"],
  ["slack-tools:slack_update_message", "send_message"],
  ["slack-tools:slack_delete_message", "send_message"],
  ["phone-tools:phone_call_make", "send_message"],
  ["phone-tools:phone_call_end", "send_message"],
  ["phone-tools:phone_campaign_start", "send_message"],
  ["phone-tools:phone_campaign_pause", "send_message"],
  ["phone-tools:phone_campaign_resume", "send_message"],
  ["phone-tools:phone_campaign_stop", "send_message"],
  ["phone-tools:phone_assistant_create", "change_knowledge_base"],
  ["phone-tools:phone_assistant_update", "change_knowledge_base"],
  ["phone-tools:phone_assistant_delete", "change_knowledge_base"],
  ["phone-tools:phone_campaign_create", "change_knowledge_base"],
  ["phone-tools:phone_campaign_update", "change_knowledge_base"],
  ["phone-tools:phone_dnc_add", "change_knowledge_base"],
  ["phone-tools:phone_dnc_remove", "change_knowledge_base"],
  ["3cx-tools:pbx_click_to_call", "send_message"],
  ["3cx-tools:pbx_park_call", "send_message"],
  ["3cx-tools:pbx_pickup_park", "send_message"],
  ["3cx-tools:pbx_transfer_call", "send_message"],
  ["3cx-tools:pbx_hangup_call", "send_message"],
  ["gbp-reviews:gbp_reply_to_review", "post_publicly"],
  ["review-tools:gbp_reply_to_review", "post_publicly"],
  ["social-poster:post_to_facebook", "post_publicly"],
  ["social-poster:post_to_instagram", "post_publicly"],
  ["social-poster:post_to_x", "post_publicly"],
  ["social-poster:post_to_tiktok", "post_publicly"],
  ["social-poster:post_to_threads", "post_publicly"],
  ["instagram-tools:instagram_post_photo", "post_publicly"],
  ["instagram-tools:instagram_post_carousel", "post_publicly"],
  ["instagram-tools:instagram_post_reel", "post_publicly"],
  ["instagram-tools:instagram_post_story", "post_publicly"],
  ["youtube-tools:youtube_upload", "post_publicly"],
  ["youtube-tools:youtube_post_comment", "post_publicly"],
  ["youtube-tools:youtube_mark_posted", "change_files"],
  ["kdp-tools:kdp_publish", "post_publicly"],
  ["rollbar-tools:rollbar_mute_item", "change_knowledge_base"],
  ["business-records:business_link_issue", "change_knowledge_base"],
  ["review-tools:gbp_sync_location", "change_knowledge_base"],
  ["google-workspace:gsheet_append", "change_files"],
  ["google-workspace:gsheet_update", "change_files"],
  ["google-workspace:gsheet_create", "change_files"],
  ["google-workspace:gcal_create_event", "change_knowledge_base"],
  ["google-workspace:gcal_update_event", "change_knowledge_base"],
  ["google-workspace:gcal_delete_event", "change_knowledge_base"],
  ["google-workspace:gtasks_create_task", "change_knowledge_base"],
  ["google-workspace:gtasks_update_task", "change_knowledge_base"],
  ["google-workspace:gtasks_complete_task", "change_knowledge_base"],
  ["google-workspace:gtasks_delete_task", "change_knowledge_base"],
  ["acx-tools:acx_move_project", "change_files"],
  ["revenuecat-tools:revenuecat_set_subscriber_attribute", "change_knowledge_base"],
  ["revenuecat-tools:revenuecat_delete_subscriber", "change_knowledge_base"],
  ["slack-tools:slack_create_channel", "change_knowledge_base"],
  ["slack-tools:slack_invite_users", "change_knowledge_base"],
  ["slack-tools:slack_add_reaction", "send_message"],
  ["slack-tools:slack_remove_reaction", "send_message"],
  ["slack-tools:slack_upload_file", "send_message"],
  ["stripe-tools:stripe_create_promotion_code", "move_money"],
  ["todo-list:todo_add", "change_knowledge_base"],
  ["todo-list:todo_complete", "change_knowledge_base"],
  ["todo-list:todo_remove", "change_knowledge_base"],
  ["s3-tools:s3_download", "change_files"],
  ["stripe-tools:stripe_export_charges_csv", "change_files"],
  ["print-tools:print_text", "change_files"],
  ["customer-support:support_save_directory", "change_knowledge_base"],
  ["customer-support:support_report_ticket", "send_message"],
  ["insurance-portals:insurance_fetch_documents", "change_files"],
  ["insurance-portals:insurance_start_fetch", "change_files"],
  ["phone-tools:phone_lead_list_append", "change_knowledge_base"],
  ["phone-tools:phone_lead_list_import_csv", "change_knowledge_base"],
  ["phone-tools:phone_dnc_federal_refresh", "change_knowledge_base"],
  ["backup-tools:backup_run_now", "change_files"],
  ["deal-desk:deal_scenario_run", "change_knowledge_base"],
  ["image-tools:image_generate", "change_files"],
  ["image-tools:image_edit", "change_files"],
  ["image-tools:image_resize", "change_files"],
  ["image-tools:image_upscale", "change_files"],
  ["image-tools:image_compose", "change_files"],
]);

export function legacyAgentActionTypeForTool(namespacedName: string): AgentActionType | null {
  return LEGACY_ACTION_TYPES.get(namespacedName) ?? null;
}

function bareToolName(namespacedName: string): string {
  return namespacedName.split(":").at(-1)?.toLowerCase() ?? namespacedName.toLowerCase();
}

const LEGACY_BARE_ACTION_TYPES = new Map<string, AgentActionType>();
const AMBIGUOUS_LEGACY_BARE_ACTION_TYPES = new Set<string>();
for (const [namespacedName, actionType] of LEGACY_ACTION_TYPES) {
  const bareName = bareToolName(namespacedName);
  const previous = LEGACY_BARE_ACTION_TYPES.get(bareName);
  if (previous && previous !== actionType) {
    LEGACY_BARE_ACTION_TYPES.delete(bareName);
    AMBIGUOUS_LEGACY_BARE_ACTION_TYPES.add(bareName);
  } else if (!AMBIGUOUS_LEGACY_BARE_ACTION_TYPES.has(bareName)) {
    LEGACY_BARE_ACTION_TYPES.set(bareName, actionType);
  }
}

function toolNameTokens(namespacedName: string): Set<string> {
  const bareName = namespacedName.split(":").at(-1) ?? namespacedName;
  const normalized = bareName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return new Set(normalized.split(/[^a-z0-9]+/).filter(Boolean));
}

const MUTATION_TOKENS = new Set([
  "accept", "acknowledge", "activate", "add", "append", "approve", "apply", "archive", "assign", "attach", "ban", "cancel",
  "capture", "change", "charge", "clear", "close", "commit", "complete", "confirm", "connect", "copy", "create",
  "delete", "demote", "deploy", "deposit", "destroy", "detach", "disable", "disconnect", "dismiss", "download", "edit",
  "enable", "execute", "expire", "export", "finalize", "fork", "grant", "hangup", "import", "install", "invite", "launch", "link", "lock", "mark",
  "merge", "modify", "move", "park", "patch", "pause", "pickup", "post",
  "pay", "payout", "print", "promote", "provision", "publish", "purchase", "push", "put", "redeem", "refund", "reject", "remove", "rename", "renew", "reply",
  "reboot", "replace", "reset", "resize", "resolve", "restart", "restore", "resume", "revoke", "rotate", "save", "scale", "schedule", "send", "set", "share", "sign", "start",
  "stop", "submit", "subscribe", "suspend", "sync", "terminate", "transfer", "trigger", "unarchive", "unban", "uninstall", "unlock", "unsubscribe", "update",
  "overwrite", "upload", "upsert", "withdraw", "write",
]);

const READ_SHAPED_TOKENS = new Set([
  "calculate", "check", "compare", "describe", "estimate", "find", "get",
  "history", "inspect", "list", "lookup", "predict", "preview", "query",
  "read", "report", "scan", "search", "status", "summary", "transcript",
  "validate",
]);

const MUTATION_AFTER_READ_TOKENS = new Set([
  "add", "apply", "complete", "create", "delete", "edit", "execute", "modify", "move",
  "post", "publish", "remove", "send", "set", "submit", "trigger", "update",
  "upload", "upsert", "write",
]);

const LEGACY_READ_TOOLS = new Set([
  "backup-tools:backup_archive_describe",
  "code-scanner:code_dead_export_scan",
  "customer-support:support_check_skill_sync",
  "customer-support:support_resolve_owner",
  "phone-tools:phone_audit_export",
  "unifi-tools:unifi_restart_status",
]);

/**
 * Writes an agent makes to its own working state, not to anything the
 * operator would want to review. They never ask first, whatever the company
 * policy says, unless the tool itself declares an action or an operator marks
 * the operation as needing approval.
 *
 * The triage cursor is a bookmark of how far the mail triage run has read.
 * Asking about it raised a card after every triage run, and approving the
 * card woke the agent, which ended its run by asking for the bookmark again.
 * Adding sender suggestions to the review queue is also working state: it
 * records a proposed decision without changing mail or applying a sender rule.
 * Asking before recording the suggestion adds an approval before the decision.
 */
const AGENT_BOOKKEEPING_TOOLS = new Set([
  "email-tools:email_set_triage_cursor",
  "email-tools:email_add_to_review_queue",
]);

export function isLikelyBrokeredMutationToolName(namespacedName: string): boolean {
  if (legacyAgentActionTypeForTool(namespacedName)) return true;
  if (LEGACY_READ_TOOLS.has(namespacedName)) return false;
  if (AGENT_BOOKKEEPING_TOOLS.has(namespacedName)) return false;
  const tokenList = [...toolNameTokens(namespacedName)];
  const readTokenIndex = tokenList.findIndex((token) => READ_SHAPED_TOKENS.has(token));
  const compoundRunIndex = tokenList.findIndex((token) => token === "run");
  const hasCommandShape = tokenList.some(
    (token) => token === "command" || token === "script" || token === "shell",
  );
  if (
    compoundRunIndex >= 0 &&
    hasCommandShape &&
    (readTokenIndex < 0 || compoundRunIndex < readTokenIndex)
  ) {
    return true;
  }
  const mutationTokenIndex = tokenList.findIndex((token) => MUTATION_TOKENS.has(token));
  const hasMutationToken = tokenList.some((token) => MUTATION_TOKENS.has(token));
  const connectorIndex = tokenList.findIndex((token) => token === "and" || token === "or" || token === "then");
  const hasMutationAfterConnector =
    connectorIndex >= 0 &&
    tokenList.slice(connectorIndex + 1).some((token) => MUTATION_TOKENS.has(token));
  const hasCommandRunAfterConnector =
    connectorIndex >= 0 &&
    tokenList.slice(connectorIndex + 1).includes("run") &&
    hasCommandShape;
  if (mutationTokenIndex >= 0 && (readTokenIndex < 0 || mutationTokenIndex < readTokenIndex)) {
    return true;
  }
  if (
    readTokenIndex >= 0 &&
    !hasMutationAfterConnector &&
    !hasCommandRunAfterConnector &&
    !tokenList.slice(readTokenIndex + 1).some((token) => MUTATION_AFTER_READ_TOKENS.has(token))
  ) return false;
  const bareName = bareToolName(namespacedName);
  if (isLikelyMutationToolName(bareName)) return true;
  return hasMutationToken;
}

export function inferAgentActionTypeForTool(namespacedName: string): AgentActionType | null {
  const legacy = legacyAgentActionTypeForTool(namespacedName);
  if (legacy) return legacy;
  const knownBareActionType = LEGACY_BARE_ACTION_TYPES.get(bareToolName(namespacedName));
  if (knownBareActionType) return knownBareActionType;
  const namespaceTokens = new Set(
    namespacedName
      .split(":")
      .slice(0, -1)
      .join(":")
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  const namespaceHasAny = (...values: string[]) => values.some((value) => namespaceTokens.has(value));
  const bareTokens = toolNameTokens(namespacedName);
  const bareHasAny = (...values: string[]) => values.some((value) => bareTokens.has(value));
  if (
    namespaceHasAny("slack") &&
    (
      bareHasAny("post") ||
      bareHasAny("reaction", "upload") ||
      (bareHasAny("message") && bareHasAny("delete", "post", "send", "update")) ||
      (bareHasAny("channel") && bareHasAny("post", "publish", "send"))
    )
  ) {
    return "send_message";
  }
  if (
    namespaceHasAny("teams") &&
    (
      bareHasAny("post") ||
      (bareHasAny("message", "channel") && bareHasAny("publish", "send"))
    )
  ) {
    return "send_message";
  }
  if (namespaceHasAny("jira") && bareHasAny("comment")) {
    return "change_knowledge_base";
  }
  const isPublicCodeHost =
    namespaceHasAny("github", "gitlab", "bitbucket", "gitea", "forgejo", "codeberg") ||
    (namespaceTokens.has("azure") && namespaceTokens.has("devops"));
  if (
    isPublicCodeHost &&
    (
      bareTokens.has("comment") ||
      (namespaceHasAny("gitlab") && bareTokens.has("note")) ||
      bareHasAny("review", "reviewer", "reviewers")
    )
  ) {
    return "post_publicly";
  }
  if (
    namespaceHasAny("gmail") &&
    bareHasAny("message") &&
    bareHasAny("archive", "delete", "label", "mark", "move", "read", "save", "set", "status", "unread", "update")
  ) {
    return "change_knowledge_base";
  }
  if (
    bareHasAny("payment", "payments", "pay", "charge", "refund", "invoice", "coupon", "discount", "credit", "debit", "subscription", "payout", "price", "checkout", "purchase", "funds", "money", "bank", "transaction")
  ) {
    return "move_money";
  }
  if (
    bareHasAny("hangup", "pickup", "park", "call") ||
    (bareHasAny("phone", "pbx") && bareHasAny("transfer"))
  ) {
    return "send_message";
  }
  if (bareHasAny("public")) {
    return "post_publicly";
  }
  if (
    bareHasAny("email", "mail") &&
    bareHasAny("archive", "delete", "label", "mark", "move", "read", "save", "set", "status", "unread", "update")
  ) {
    return "change_knowledge_base";
  }
  if (
    bareHasAny("message") &&
    bareHasAny("archive", "label", "mark", "move", "read", "save", "set", "status", "unread")
  ) {
    return "change_knowledge_base";
  }
  if (
    bareHasAny("dm") ||
    (bareHasAny("direct") && bareHasAny("message")) ||
    (bareHasAny("message") && bareHasAny("delete", "post", "reply", "send", "update")) ||
    (
      bareHasAny("send", "reply", "notify") &&
      bareHasAny("email", "mail", "message", "sms", "notification")
    )
  ) {
    return "send_message";
  }
  if (bareTokens.has("issue") && bareTokens.has("comment")) {
    if (
      namespaceHasAny("jira", "linear", "helpscout") ||
      (namespaceTokens.has("help") && namespaceTokens.has("scout"))
    ) {
      return "change_knowledge_base";
    }
    return null;
  }
  if (
    bareHasAny("issue", "ticket", "conversation", "customer", "linear", "jira", "knowledge", "kb", "business", "deal", "fact", "memory", "wiki", "page", "document", "docs") &&
    bareHasAny("add", "archive", "assign", "change", "close", "complete", "create", "delete", "edit", "link", "mark", "move", "remove", "save", "set", "status", "update", "write")
  ) {
    return "change_knowledge_base";
  }
  if (
    bareHasAny("file", "files", "folder", "directory", "blob", "object", "storage", "image", "images", "screenshot") &&
    bareHasAny("add", "capture", "change", "copy", "create", "delete", "download", "edit", "move", "remove", "rename", "replace", "resize", "save", "transfer", "upload", "write")
  ) {
    return "change_files";
  }
  if (
    bareHasAny("facebook", "instagram", "youtube", "tiktok", "threads", "gbp", "tweet") ||
    (bareHasAny("github") && bareHasAny("comment", "release"))
  ) {
    return "post_publicly";
  }
  if (bareHasAny("deposit", "withdraw")) {
    return "move_money";
  }
  const normalizedName = namespacedName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  const tokens = new Set(normalizedName.split(/[^a-z0-9]+/).filter(Boolean));
  const hasAny = (...values: string[]) => values.some((value) => tokens.has(value));
  if (
    hasAny("slack") &&
    (
      hasAny("upload", "reaction") ||
      (hasAny("message") && hasAny("post", "send", "update", "delete"))
    )
  ) {
    return "send_message";
  }
  if (hasAny("slack") && hasAny("channel", "invite", "member", "user", "users")) {
    return "change_knowledge_base";
  }
  if (hasAny("helpscout") && hasAny("create") && hasAny("conversation")) {
    return "send_message";
  }
  if (hasAny("public")) {
    return "post_publicly";
  }
  if (
    hasAny("dm") ||
    (hasAny("direct") && hasAny("message")) ||
    (hasAny("message") && hasAny("send"))
  ) {
    return "send_message";
  }
  if (hasAny("social", "tweet", "facebook", "instagram", "youtube", "tiktok", "threads", "gbp", "x")) {
    return "post_publicly";
  }
  if (
    hasAny("hangup", "pickup", "park", "call") ||
    (hasAny("phone", "pbx") && hasAny("transfer"))
  ) {
    return "send_message";
  }
  if (
    hasAny("payment", "payments", "pay", "charge", "refund", "invoice", "coupon", "discount", "credit", "debit", "subscription", "payout", "price", "checkout", "purchase", "funds", "money", "bank", "transaction")
  ) {
    return "move_money";
  }
  if (
    hasAny("email", "mail", "message") &&
    hasAny("archive", "delete", "label", "mark", "move", "read", "save", "set", "status", "unread", "update")
  ) {
    return "change_knowledge_base";
  }
  if (hasAny("s3", "file", "files", "folder", "directory", "blob", "object", "storage", "upload", "image", "images", "screenshot", "video")) {
    return "change_files";
  }
  if (hasAny("deposit", "withdraw")) {
    return "move_money";
  }
  if (hasAny("message", "email", "mail", "sms", "notify", "notification", "reply", "send")) {
    return "send_message";
  }
  if (hasAny("github") && hasAny("comment")) {
    return "post_publicly";
  }
  if (hasAny("issue", "ticket", "helpscout", "rollbar", "conversation", "customer", "linear", "jira")) {
    return "change_knowledge_base";
  }
  if (hasAny("github") && hasAny("release")) {
    return "post_publicly";
  }
  if (hasAny("github", "git", "repository", "repo", "pull", "branch", "commit", "command", "script", "shell")) {
    return "change_files";
  }
  if (hasAny("knowledge", "kb", "business", "deal", "fact", "memory", "wiki", "page", "document", "docs", "helpscout", "rollbar", "issue", "ticket", "conversation", "customer", "label", "status", "assignee")) {
    return "change_knowledge_base";
  }
  return null;
}

export function classifyBrokeredAgentAction(
  namespacedName: string,
  declaration: {
    actionType?: AgentActionType | null;
    writes?: boolean;
    requiresApproval?: boolean;
    externalDeclaredWrite?: boolean;
  } = {},
): { actionType: AgentActionType | null } | null {
  if (
    declaration.writes === false &&
    declaration.actionType == null &&
    declaration.requiresApproval !== true &&
    declaration.externalDeclaredWrite !== true
  ) {
    return null;
  }
  const isWrite =
    declaration.actionType != null ||
    declaration.writes === true ||
    declaration.requiresApproval === true ||
    declaration.externalDeclaredWrite === true ||
    isLikelyBrokeredMutationToolName(namespacedName);
  if (!isWrite) return null;
  return {
    actionType: declaration.actionType ?? inferAgentActionTypeForTool(namespacedName),
  };
}

/**
 * Header marker placed in the agent-facing tool result when a call is
 * drafted. Adapters / agent prompts can detect this prefix to recognize
 * "do not retry; draft is queued."
 */
export const DRAFT_RESULT_HEADER = "[paperclip:tool-draft] queued for human approval";

interface DraftGateOptions {
  db: Db;
  /**
   * Default override for the instance-wide enable flag — used in tests.
   * In production the flag is read from instance settings on each call so
   * operators can toggle without restart.
   */
  defaultEnabled?: boolean;
  /**
   * Extra tool names to treat as gated, on top of the built-in outbound list.
   *
   * This is how an operator's "require approval" setting on a plugin operation
   * reaches the gate. The built-in list is fixed at module load and knows
   * nothing about which plugins are installed, so the answer has to be asked
   * for at call time. Wired to the plugin tool registry, which is created
   * after the gate, hence a callback rather than a set.
   *
   * Replaying an approved draft is already generic — it re-dispatches the tool
   * name with its stored parameters — so nothing else has to know about the
   * plugin to make this work.
   *
   * @see PLUGIN_SPEC.md §11.8 — Operator control over operations
   */
  isAdditionallyGated?: (namespacedName: string) => boolean;
  /** Resolve the operator's action policy for this caller and tool. */
  resolveActionPolicy?: (
    namespacedName: string,
    runContext: ToolRunContext,
  ) => Promise<ResolvedDraftActionPolicy | null>;
}

export interface ResolvedDraftActionPolicy {
  actionType: AgentActionType | null;
  mode: AgentActionMode;
  source: "agent" | "company" | "legacy" | "default" | "operation" | "unclassified";
}

export interface DraftGateInterceptResult {
  intercepted: boolean;
  result?: ToolResult;
  actionPolicy?: ResolvedDraftActionPolicy | null;
}

export interface DraftGateInterceptOptions {
  /**
   * Draft this call even if the instance-wide hold is off, and even if every
   * recipient looks like the operator.
   *
   * For a caller whose own policy is stricter than the instance default. The
   * self-notification bypass is overridden too, because a caller that has
   * said "always ask me about these" has already answered the question that
   * bypass exists to answer.
   *
   * The tool must still be one the gate knows how to draft: forcing does not
   * make an arbitrary tool draftable, since nothing would know how to replay
   * it after approval.
   */
  force?: boolean;
  /**
   * A call-specific legacy setting. Agent and company action policies still
   * take precedence when either one is configured.
   */
  legacyActionMode?: AgentActionMode;
  /** Policy already resolved by the dispatcher so early refusals share the same audit context. */
  resolvedActionPolicy?: ResolvedDraftActionPolicy | null;
}

export interface DraftGate {
  /**
   * Check whether a given tool call should be drafted instead of executed.
   * If yes, persists an approval and returns the synthesized tool result
   * (so the agent receives a non-error response that says "drafted").
   *
   * If no, returns `{ intercepted: false }` and the dispatcher proceeds
   * with normal execution.
   */
  intercept(
    namespacedName: string,
    parameters: unknown,
    runContext: ToolRunContext,
    options?: DraftGateInterceptOptions,
  ): Promise<DraftGateInterceptResult>;

  /**
   * Whether the gate currently considers the given tool name draftable.
   * Cheap; safe to call on every dispatch. Does not consult the DB.
   */
  isGated(namespacedName: string): boolean;

  resolveActionPolicy(
    namespacedName: string,
    runContext: ToolRunContext,
  ): Promise<ResolvedDraftActionPolicy | null>;
}

/**
 * Synthetic agentId prefix used by chat-Agent (Clippy) and the plugin MCP
 * bridge when a real agent run isn't available. Format: `clippy:<userId>`.
 * The suffix is the auth user id (text, not a UUID), so the synthetic id
 * fails to cast into the `uuid` columns on `approvals.requested_by_agent_id`
 * and `activity_log.agent_id`. Detect it here and route the attribution to
 * the user-id columns instead.
 */
/**
 * The issue a run was working on, read back from the run itself.
 *
 * `ToolRunContext` carries the agent, the run and the company, but not the
 * issue — plugin tools have never needed it. The draft gate does: an outbound
 * message drafted while working on an issue belongs to that issue, and
 * without the link nothing about the draft or the eventual send appears on
 * the issue at all. That is how an operator ends up approving a Slack DM and
 * then finding no trace of it anywhere near the work it came from.
 *
 * Read from the run's own context snapshot rather than threaded through the
 * call, so no plugin, adapter or SDK type has to change to get it right.
 * Returns null for chat turns and for runs with no issue, which is correct:
 * there is nothing to link to.
 *
 * The second lookup is what stops a loop rather than merely recording one. A
 * run woken by `approval_approved` carries the issue of the approval it is
 * about — but only when that approval was itself linked. An unlinked approval
 * therefore wakes the agent with no issue at all, the agent finds no work to
 * return to, drafts another message to say so, and that draft is unlinked for
 * the same reason. Four identical Slack DMs in three minutes came out of
 * exactly that. Following the wake's `approvalId` back to its issue lets the
 * link survive the hop, so the chain re-attaches instead of restarting empty.
 */
async function issueIdForRun(db: Db, runId: string | null): Promise<string | null> {
  if (!runId) return null;
  try {
    const row = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    const snapshot = (row?.contextSnapshot ?? null) as Record<string, unknown> | null;
    const candidate = snapshot?.issueId ?? snapshot?.taskId;
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();

    const wakingApprovalId = snapshot?.approvalId;
    if (typeof wakingApprovalId !== "string" || !wakingApprovalId.trim()) return null;
    const linked = await db
      .select({ issueId: issueApprovals.issueId })
      .from(issueApprovals)
      .where(eq(issueApprovals.approvalId, wakingApprovalId.trim()))
      .then((rows) => rows[0] ?? null);
    return linked?.issueId ?? null;
  } catch (err) {
    log.warn({ err, runId }, "could not read the run's issue for draft linking");
    return null;
  }
}

/**
 * A stable identity for "this exact outbound call", used to recognise a repeat.
 *
 * Object key order is not meaningful in a tool call but is not guaranteed
 * stable either, so keys are sorted before stringifying. Anything that is not
 * a plain object falls back to its JSON form, which is enough: two calls are
 * only ever treated as the same draft when their parameters serialise
 * identically.
 */
function draftIdentity(namespacedName: string, parameters: unknown): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, normalize(entry)]),
      );
    }
    return value;
  };
  return `${namespacedName}::${JSON.stringify(normalize(parameters ?? null))}`;
}

const CLIPPY_AGENT_PREFIX = "clippy:";

interface ResolvedRunActor {
  /** Real agent UUID, or null when the caller is Clippy / unknown. */
  agentUuid: string | null;
  /** Real heartbeat run UUID, or null when the caller is Clippy / unknown. */
  runUuid: string | null;
  /** Auth user id, when the caller is Clippy. */
  userId: string | null;
  /** Activity-log actor classification. */
  actorType: "agent" | "user" | "system";
  actorId: string;
}

function resolveRunActor(runContext: ToolRunContext): ResolvedRunActor {
  const rawAgentId = runContext.agentId ?? "";
  if (rawAgentId.startsWith(CLIPPY_AGENT_PREFIX)) {
    const userId = rawAgentId.slice(CLIPPY_AGENT_PREFIX.length) || null;
    return {
      agentUuid: null,
      // The synthetic runId from chat-tools is a randomUUID() that doesn't
      // exist in heartbeat_runs, so the FK would reject it the same way the
      // agent_id cast rejects the prefixed string. Drop it.
      runUuid: null,
      userId,
      actorType: userId ? "user" : "system",
      actorId: userId ?? "system",
    };
  }
  if (rawAgentId) {
    return {
      agentUuid: isUuidLike(rawAgentId) ? rawAgentId : null,
      runUuid: runContext.runId && isUuidLike(runContext.runId) ? runContext.runId : null,
      userId: null,
      actorType: "agent",
      actorId: rawAgentId,
    };
  }
  return {
    agentUuid: null,
    runUuid: null,
    userId: null,
    actorType: "system",
    actorId: "system",
  };
}

// ---------------------------------------------------------------------------
// Self-notification detection
// ---------------------------------------------------------------------------

/** Slack user IDs are compared case-insensitively after trimming. */
function normalizeSlackId(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * Emails are compared lowercased, with RFC 5322 display-name forms reduced to
 * the address inside the angle brackets ("Alex Owner <a@b.com>" -> "a@b.com").
 */
function normalizeEmail(value: string): string {
  const angled = /<([^<>]+)>/.exec(value);
  return (angled?.[1] ?? value).trim().toLowerCase();
}

/** Phone numbers are compared digits-only, so formatting never matters. */
function normalizePhone(value: string): string {
  return value.replace(/\D/g, "");
}

const RECIPIENT_NORMALIZERS: Record<SelfRecipientKind, (value: string) => string> = {
  slack: normalizeSlackId,
  email: normalizeEmail,
  phone: normalizePhone,
};

function selfAddressList(selfNotify: SelfNotifySettings, kind: SelfRecipientKind): string[] {
  switch (kind) {
    case "slack":
      return selfNotify.slackUserIds;
    case "email":
      return selfNotify.emails;
    case "phone":
      return selfNotify.phoneNumbers;
  }
}

/**
 * All recipient addresses present on the call, or `null` when a recipient
 * field exists but cannot be read as address strings — unverifiable calls
 * must stay gated.
 */
function collectRecipients(
  params: Record<string, unknown>,
  rule: SelfRecipientRule,
): string[] | null {
  const recipients: string[] = [];
  for (const key of rule.recipientParams) {
    const value = params[key];
    if (value == null) continue;
    const entries: unknown[] = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      if (typeof entry !== "string") return null;
      // Email fields accept comma-separated lists in a single string.
      const parts = rule.kind === "email" ? entry.split(",") : [entry];
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed) recipients.push(trimmed);
      }
    }
  }
  return recipients;
}

/**
 * True when every recipient of the call is positively the operator. A call
 * with no recipient parameters counts only for tools whose omitted recipient
 * is the operator by plugin contract (slack_send_dm's defaultDmTarget).
 * Anything ambiguous returns false and the call stays in the approval queue.
 */
function isSelfAddressed(
  namespacedName: string,
  parameters: unknown,
  selfNotify: SelfNotifySettings,
): boolean {
  if (!selfNotify.skipApproval) return false;
  const rule = (OUTBOUND_SELF_RECIPIENT_RULES as Record<string, SelfRecipientRule | undefined>)[
    namespacedName
  ];
  if (!rule) return false;

  const params =
    parameters && typeof parameters === "object" ? (parameters as Record<string, unknown>) : {};
  const recipients = collectRecipients(params, rule);
  if (recipients == null) return false;
  if (recipients.length === 0) return rule.omittedRecipientIsSelf;

  const normalize = RECIPIENT_NORMALIZERS[rule.kind];
  const selfSet = new Set(
    selfAddressList(selfNotify, rule.kind)
      .map(normalize)
      .filter((value) => value.length > 0),
  );
  if (selfSet.size === 0) return false;
  return recipients.every((recipient) => {
    const normalized = normalize(recipient);
    return normalized.length > 0 && selfSet.has(normalized);
  });
}

/** A string field's trimmed value, or null when it is missing or blank. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** An id given as a string or as a number (Help Scout's ids are numeric). */
function idString(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : nonEmptyString(value);
}

/** Whether a call left a field out, the only time a plugin uses its default. */
function isMissing(value: unknown): boolean {
  return value === undefined || value === null;
}

/** A nested object's fields, or none when the value is not an object. */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Names from a field that takes one string or id, or a list of them.
 * Anything else (an object, null, true) names no one. Email fields also split
 * a string on commas, since one string can carry several addresses.
 */
function readNames(value: unknown, splitCommas = false): string[] {
  const names: string[] = [];
  for (const entry of Array.isArray(value) ? value : [value]) {
    const text = idString(entry);
    if (!text) continue;
    for (const part of splitCommas ? text.split(",") : [text]) {
      const name = part.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

/**
 * Addresses from an email to, cc or bcc field. A lone { name, address }
 * object counts, because the mail library sends to one. Inside a list the
 * email plugin turns an object into text that is not an address, so there it
 * does not.
 */
function emailAddresses(value: unknown): string[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entry = value as Record<string, unknown>;
    const address = nonEmptyString(entry.address);
    if (!address) return [];
    const name = nonEmptyString(entry.name);
    return [name ? `${name} <${address}>` : address];
  }
  return readNames(value, true);
}

interface SummaryRecipients {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  /**
   * Said instead of a list of names when the call is not simply sent to
   * them: a reply-all, or a call that sends nothing to anyone.
   */
  description?: string;
}

/** A public post, which names where it appears in a single field. */
function postedTo(field: string): (p: Record<string, unknown>) => SummaryRecipients {
  return (p) => ({ to: readNames(p[field]) });
}

/**
 * Who each held tool sends to, read from the fields that tool itself reads,
 * including where it sends when they are left out.
 *
 * One list of field names cannot be right for every tool, because the same
 * name means different things in different plugins: `userId` is who a Slack
 * DM goes to but who a Help Scout note is attributed to, and `account` is
 * where a social post appears but only which account a call or a Help Scout
 * message goes out from. The server does not check a call against the
 * plugin's schema either, so a draft can carry a field its tool ignores.
 * Naming the wrong person to someone deciding whether to send is worse than
 * naming no one, so every tool in OUTBOUND_TOOL_DRAFT_GATE has its own entry
 * here, and fallbackRecipients is left for operations an operator has asked
 * to approve.
 *
 * The web approval card does not use these. It reads recipients itself
 * (RECIPIENT_READERS in ui/src/components/ApprovalPayload.tsx), for fewer
 * tools, so a change here does not change what that card shows.
 */
const SUMMARY_RECIPIENT_READERS: Record<string, (p: Record<string, unknown>) => SummaryRecipients> = {
  // The plugin uses the workspace's default DM target only when userId is
  // left out, and sends to whatever else it holds. The call carries only the
  // Slack user id; a name would need a Slack lookup.
  "slack-tools:slack_send_dm": (p) =>
    isMissing(p.userId) ? { to: ["the default DM target"] } : { to: readNames(p.userId) },
  // channelId wins over channelName, and with neither the plugin posts to the
  // workspace's default channel.
  "slack-tools:slack_send_channel": (p) => {
    const channelId = readNames(p.channelId);
    if (channelId.length > 0) return { to: channelId };
    const channelName = nonEmptyString(p.channelName);
    if (channelName) return { to: [`#${channelName.replace(/^#/, "")}`] };
    return isMissing(p.channelId) && !p.channelName ? { to: ["the default channel"] } : {};
  },
  "email-tools:email_send": (p) => ({
    to: emailAddresses(p.to),
    cc: emailAddresses(p.cc),
    bcc: emailAddresses(p.bcc),
  }),
  // The plugin sends a reply to the original message's sender and ignores any
  // `to` it is given. With replyAll (any truthy value, as the plugin reads it)
  // it also copies everyone else who was on that message.
  "email-tools:email_reply": (p) =>
    p.replyAll
      ? { description: "reply-all to the sender and everyone on the original message" }
      : { to: ["the sender of the original message"] },
  // An imported reply is only recorded in Help Scout and reaches no one.
  // Otherwise customerId wins over customerEmail, and with neither the reply
  // goes to the conversation's own customer.
  "help-scout:helpscout_send_reply": (p) => {
    if (p.imported) return { description: "recorded in Help Scout only, nothing is sent" };
    const copies = { cc: emailAddresses(p.cc), bcc: emailAddresses(p.bcc) };
    const customerId = idString(p.customerId);
    if (customerId) return { to: [`Help Scout customer ${customerId}`], ...copies };
    const conversationId = idString(p.conversationId);
    const conversationCustomer = conversationId
      ? `the customer on conversation ${conversationId}`
      : "the conversation's customer";
    return { to: [nonEmptyString(p.customerEmail) ?? conversationCustomer], ...copies };
  },
  // Each thread that is not an internal note goes to the conversation's
  // customer, or to the thread's own customerEmail when it names one. A
  // conversation of notes alone reaches no one.
  "help-scout:helpscout_create_conversation": (p) => {
    const customerEmail = nonEmptyString(asRecord(p.customer).email);
    const threads = Array.isArray(p.threads) ? p.threads.map(asRecord) : [];
    const sent = threads.filter((thread) => thread.type !== "note");
    if (threads.length > 0 && sent.length === 0) {
      return { description: "internal notes only, nothing is sent" };
    }
    const to =
      sent.length > 0
        ? sent.map((thread) => nonEmptyString(thread.customerEmail) ?? customerEmail)
        : [customerEmail];
    return { to: to.filter((name): name is string => name !== null) };
  },
  "phone-tools:phone_call_make": (p) => ({ to: readNames(p.to) }),
  // The from* fields pick the extension that rings first, not who is called.
  "3cx-tools:pbx_click_to_call": (p) => ({ to: readNames(p.toNumber) }),
  // The public posts name where the post appears.
  "gbp-reviews:gbp_reply_to_review": postedTo("locationKey"),
  "review-tools:gbp_reply_to_review": postedTo("locationKey"),
  "social-poster:post_to_facebook": postedTo("page"),
  "social-poster:post_to_instagram": postedTo("account"),
  "social-poster:post_to_x": postedTo("account"),
  "social-poster:post_to_tiktok": postedTo("account"),
  "social-poster:post_to_threads": postedTo("account"),
  "instagram-tools:instagram_post_photo": postedTo("account"),
  "instagram-tools:instagram_post_carousel": postedTo("account"),
  "instagram-tools:instagram_post_reel": postedTo("account"),
  "instagram-tools:instagram_post_story": postedTo("account"),
  "youtube-tools:youtube_upload": postedTo("account"),
  // A comment appears on the video; the account only says who posts it.
  "youtube-tools:youtube_post_comment": (p) => ({
    to: readNames(p.videoId).map((videoId) => `video ${videoId}`),
  }),
  // Publishing a book addresses no one.
  "kdp-tools:kdp_publish": () => ({}),
};

/**
 * Recipients for an operation with no reader of its own, which leaves the
 * ones an operator has asked to approve. Only names that are the recipient in
 * the tools that send with them (`to` is also the end of a date range in two
 * report tools, where the date speaks for itself). `account`, `page`,
 * `locationKey` and `conversationId` are left to the readers above: each is
 * where one held tool sends but something else in its plugin's other tools,
 * such as the account a call is placed from, a page number, the key a review
 * sync signs in with, or the conversation being closed or tagged.
 */
function fallbackRecipients(p: Record<string, unknown>): SummaryRecipients {
  const to = readNames(p.to);
  if (to.length > 0) return { to };
  const named =
    nonEmptyString(p.recipient) ??
    nonEmptyString(p.channel) ??
    nonEmptyString(p.user) ??
    nonEmptyString(p.phoneNumber);
  return { to: named ? [named] : [] };
}

/** At most this many names are shown in each of to, cc and bcc; the rest are counted. */
const MAX_NAMES_SHOWN = 3;
const MAX_NAME_LENGTH = 60;
const MAX_SUBJECT_LENGTH = 100;
const MAX_BODY_LENGTH = 140;
/**
 * The whole summary. Slack refuses an approval card past 3000 characters, and
 * a refused card loses the reply and any later approvals in that turn.
 */
const MAX_SUMMARY_LENGTH = 500;

/**
 * Text cut to at most `max` characters, ending in an ellipsis. Counts whole
 * characters: half of an emoji left at the cut is something Postgres will not
 * store as JSON, which would fail the draft and the agent's tool call with it.
 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const characters: string[] = [];
  for (const character of text) {
    characters.push(character);
    if (characters.length > max) return `${characters.slice(0, max - 1).join("")}…`;
  }
  return text;
}

/** One name, shortened; a long "Name <address>" keeps just the address. */
function shortName(name: string): string {
  if (name.length <= MAX_NAME_LENGTH) return name;
  const address = /<([^<>]+)>/.exec(name)?.[1]?.trim();
  return clip(address || name, MAX_NAME_LENGTH);
}

/** "a, b, c and 4 more". */
function formatNames(names: string[]): string {
  const unique = [...new Set(names)];
  const shown = unique.slice(0, MAX_NAMES_SHOWN).map(shortName).join(", ");
  const more = unique.length - MAX_NAMES_SHOWN;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

/**
 * Generate a short human-readable summary from the call parameters, used as
 * the approval payload `summary` so it renders without requiring the user
 * to expand the full args. It is all the approver sees on the Approve and
 * Reject card in Slack, so it says who the call goes to (see
 * SUMMARY_RECIPIENT_READERS) and is kept short.
 */
function buildSummary(toolName: string, params: unknown): string {
  if (!params || typeof params !== "object") return toolName;
  const p = params as Record<string, unknown>;
  const candidate = (k: string): string | null => nonEmptyString(p[k]);
  const readRecipients = Object.hasOwn(SUMMARY_RECIPIENT_READERS, toolName)
    ? SUMMARY_RECIPIENT_READERS[toolName]
    : fallbackRecipients;
  const recipients = readRecipients(p);

  // The public-posting tools (social posts, Instagram, YouTube, KDP, Google
  // review replies) name their content differently from the messaging tools
  // this was written for; where they appear is read with the recipients
  // above. Without their field names here, every one of them summarised to
  // the bare tool name, and the operator was asked to approve a public post
  // without being shown a word of it.
  const subject = candidate("subject") ?? candidate("title");
  const body =
    candidate("body") ??
    candidate("text") ??
    candidate("message") ??
    candidate("html") ??
    candidate("caption") ??
    candidate("replyText") ??
    candidate("comment") ??
    candidate("description") ??
    candidate("link") ??
    candidate("filePath");

  const parts: string[] = [];
  if (recipients.description) parts.push(recipients.description);
  const lists: Array<[label: string, names: string[] | undefined]> = [
    ["to", recipients.to],
    ["cc", recipients.cc],
    ["bcc", recipients.bcc],
  ];
  for (const [label, names] of lists) {
    if (names && names.length > 0) parts.push(`${label} ${formatNames(names)}`);
  }
  if (subject) parts.push(`re: ${clip(subject, MAX_SUBJECT_LENGTH)}`);
  if (body) {
    const trimmed = clip(body, MAX_BODY_LENGTH);
    parts.push(`— "${trimmed}"`);
  }

  if (parts.length === 0) {
    if (p.mailbox && p.uid) {
      parts.push(`mailbox ${String(p.mailbox)}, UID ${String(p.uid)}`);
    } else if (p.mailbox) {
      parts.push(`mailbox ${String(p.mailbox)}`);
    }
    const name = candidate("name") ?? candidate("channel") ?? candidate("channelName");
    if (name) parts.push(name);
    const target =
      candidate("path") ??
      candidate("filePath") ??
      candidate("filename") ??
      candidate("url") ??
      candidate("query") ??
      candidate("target");
    if (target) parts.push(target);

    if (parts.length === 0) {
      const entries = Object.entries(p)
        .filter(
          ([k, v]) =>
            !["companyId", "hostScope"].includes(k) &&
            (typeof v === "string" || typeof v === "number" || typeof v === "boolean"),
        )
        .slice(0, 3)
        .map(([k, v]) => `${k}: ${v}`);
      if (entries.length > 0) {
        parts.push(entries.join(", "));
      }
    }
  }

  return parts.length > 0 ? clip(parts.join(" "), MAX_SUMMARY_LENGTH) : "";
}

export function createDraftGate(opts: DraftGateOptions): DraftGate {
  const { db } = opts;
  const settings = instanceSettingsService(db);
  const approvals = approvalService(db);

  /**
   * Whether the operator has separately asked for approval on this tool.
   *
   * Wrapped so a throwing callback (the registry not built yet, a plugin
   * mid-reload) cannot turn every tool call into an error. Failing closed here
   * would be worse than failing open in one direction and better in the other,
   * and neither is obviously right, so it does what the gate did before the
   * callback existed: nothing.
   */
  function extraGated(namespacedName: string): boolean {
    try {
      return opts.isAdditionallyGated?.(namespacedName) === true;
    } catch {
      return false;
    }
  }

  function isGatedName(namespacedName: string): boolean {
    return GATED_TOOLS.has(namespacedName) || extraGated(namespacedName);
  }

  async function resolveActionPolicy(
    namespacedName: string,
    runContext: ToolRunContext,
  ): Promise<ResolvedDraftActionPolicy | null> {
    if (!opts.resolveActionPolicy) return null;
    try {
      return await opts.resolveActionPolicy(namespacedName, runContext);
    } catch (err) {
      log.error(
        { err, tool: namespacedName, agentId: runContext.agentId, companyId: runContext.companyId },
        "agent action policy lookup failed",
      );
      throw err;
    }
  }

  async function readGateSettings(): Promise<{
    enabled: boolean;
    selfNotify: SelfNotifySettings;
  }> {
    try {
      const general = await settings.getGeneral();
      // Defensive reads: a mocked or legacy settings source may not carry the
      // typed fields, in which case fall through to the defaults.
      return {
        enabled:
          typeof general.outboundToolDraftMode === "boolean"
            ? general.outboundToolDraftMode
            : opts.defaultEnabled ?? true,
        selfNotify: general.selfNotify ?? DEFAULT_SELF_NOTIFY_SETTINGS,
      };
    } catch (err) {
      log.warn({ err }, "failed to read outbound draft settings; assuming defaults");
      return {
        enabled: opts.defaultEnabled ?? true,
        selfNotify: DEFAULT_SELF_NOTIFY_SETTINGS,
      };
    }
  }

  return {
    isGated(namespacedName: string) {
      return isGatedName(namespacedName);
    },

    resolveActionPolicy,

    async intercept(
      namespacedName: string,
      parameters: unknown,
      runContext: ToolRunContext,
      options?: DraftGateInterceptOptions,
    ): Promise<DraftGateInterceptResult> {
      const operatorRequired = extraGated(namespacedName);
      const resolvedActionPolicy = options && "resolvedActionPolicy" in options
        ? options.resolvedActionPolicy ?? null
        : await resolveActionPolicy(namespacedName, runContext);
      const actionPolicy = options?.legacyActionMode && (
        !resolvedActionPolicy ||
        resolvedActionPolicy.source === "legacy" ||
        resolvedActionPolicy.source === "default"
      )
        ? {
            actionType: resolvedActionPolicy?.actionType ?? legacyAgentActionTypeForTool(namespacedName),
            mode: options.legacyActionMode,
            source: "legacy" as const,
          }
        : resolvedActionPolicy;
      if (!GATED_TOOLS.has(namespacedName) && !operatorRequired && !actionPolicy) {
        return { intercepted: false, actionPolicy: null };
      }
      if (!runContext.companyId) {
        log.warn(
          { tool: namespacedName, agentId: runContext.agentId },
          "draft gate skipped because runContext has no companyId",
        );
        return { intercepted: false, actionPolicy };
      }
      const actor = resolveRunActor(runContext);
      const identity = draftIdentity(namespacedName, parameters);
      const dedupeKey = createHash("sha256")
        .update([
          runContext.companyId,
          runContext.agentId ?? "",
          runContext.userId ?? actor.userId ?? "",
          identity,
        ].join("\u0000"))
        .digest("hex");
      let duplicate: Awaited<ReturnType<typeof approvals.list>>[number] | undefined;
      let duplicateLookupFailed = false;
      try {
        const pending = await approvals.list(runContext.companyId, "pending");
        duplicate = pending.find((row) => {
          if (row.type !== "outbound_tool_draft") return false;
          if (row.dedupeKey) return row.dedupeKey === dedupeKey;
          const rowPayload = (row.payload ?? {}) as Record<string, unknown>;
          if (rowPayload.toolName !== namespacedName) return false;
          if ((rowPayload.agentId ?? null) !== (runContext.agentId ?? null)) return false;
          if ((rowPayload.userId ?? null) !== (runContext.userId ?? actor.userId ?? null)) return false;
          return draftIdentity(namespacedName, rowPayload.parameters) === identity;
        });
      } catch (err) {
        duplicateLookupFailed = true;
        log.warn({ err, tool: namespacedName }, "could not check for a duplicate pending draft");
      }
      // A caller can hold a call the instance would have let through, but not
      // the other way around: `bypassDraftGate` on the dispatcher is what
      // lets something past, and it never reaches here.
      //
      // An operator asking for approval on a specific operation is its own
      // reason to hold the call: they said so about this operation, so the
      // instance-wide outbound toggle does not get to overrule them.
      const explicitlyRequiresApproval =
        actionPolicy?.mode === "ask_first" &&
        (actionPolicy.source === "agent" || actionPolicy.source === "company");
      const force = options?.force === true || operatorRequired || explicitlyRequiresApproval;
      const { enabled, selfNotify } = await readGateSettings();
      const shouldAsk = actionPolicy
        ? actionPolicy.mode === "ask_first"
        : enabled;
      if (!shouldAsk && !force && !duplicate) {
        if (duplicateLookupFailed) {
          throw new Error(`Could not verify whether "${namespacedName}" already has a pending approval`);
        }
        return { intercepted: false, actionPolicy };
      }
      // Self-notifications (every recipient is the operator) are the agent
      // talking TO its user, not acting outward on their behalf — approving
      // your own incoming message defeats the purpose of the notification.
      if (!force && !duplicate && isSelfAddressed(namespacedName, parameters, selfNotify)) {
        if (duplicateLookupFailed) {
          throw new Error(`Could not verify whether "${namespacedName}" already has a pending approval`);
        }
        log.info(
          {
            tool: namespacedName,
            agentId: runContext.agentId,
            companyId: runContext.companyId,
          },
          "outbound call addressed to the operator; sending without approval",
        );
        return { intercepted: false, actionPolicy };
      }
      // The summary only describes the call. If reading the parameters for it
      // goes wrong, the call is still drafted under its tool name: a throw
      // here would fail the agent's tool call with nothing sent and nothing
      // left to approve.
      let summary: string;
      try {
        summary = buildSummary(namespacedName, parameters);
      } catch (err) {
        log.warn({ err, tool: namespacedName }, "could not summarise the draft; using the tool name");
        summary = namespacedName;
      }
      // An identical call that is already waiting is the same request, not a
      // new one.
      //
      // Approving a draft wakes the agent that asked for it. An agent that
      // wakes with no new work sometimes decides the useful thing to do is
      // send another status message — which is drafted, approved, wakes it
      // again, and so on. That produced four identical Slack DMs in three
      // minutes, each needing its own tap. Handing back the pending draft
      // instead of queueing a second one makes the loop terminate: the agent
      // is told the message is already waiting, and the operator has one
      // decision to make rather than a growing pile of the same one.
      const duplicateResult = async (
        duplicateApproval: NonNullable<typeof duplicate>,
      ): Promise<DraftGateInterceptResult> => {
        if (actor.actorType === "agent" && actionPolicy) {
          await logActivity(db, {
            id: deterministicActivityId("agent-action-approval-requested", duplicateApproval.id),
            companyId: runContext.companyId,
            actorType: "agent",
            actorId: actor.actorId,
            action: "agent_action.approval_requested",
            entityType: "approval",
            entityId: duplicateApproval.id,
            agentId: actor.agentUuid,
            runId: actor.runUuid,
            details: {
              actionType: actionPolicy.actionType,
              tool: namespacedName,
              policySource: actionPolicy.source,
              summary,
              recoveredOnRetry: true,
            },
          });
        }
        log.info(
          { approvalId: duplicateApproval.id, tool: namespacedName, companyId: runContext.companyId },
          "identical outbound draft already awaiting approval; not queueing another",
        );
        return {
          intercepted: true,
          actionPolicy,
          result: {
            content: [
              DRAFT_RESULT_HEADER,
              `Tool: ${namespacedName}`,
              `Approval ID: ${duplicateApproval.id}`,
              "",
              "This exact message is ALREADY waiting for approval from an earlier attempt. " +
                "Nothing has been sent and nothing new has been queued. Do not draft it again " +
                "and do not rephrase it to get around this; say it is waiting and stop.",
            ].join("\n"),
            data: {
              drafted: true,
              duplicateOf: duplicateApproval.id,
              approvalId: duplicateApproval.id,
              status: "pending",
              tool: namespacedName,
              summary,
            },
          },
        };
      };
      if (duplicate) return duplicateResult(duplicate);
      const draftIssueId = await issueIdForRun(db, actor.runUuid);
      let issueContext: { id: string; identifier: string | null; title: string } | null = null;
      if (draftIssueId) {
        try {
          const issueRow = await db
            .select({ id: issues.id, identifier: issues.identifier, title: issues.title })
            .from(issues)
            .where(eq(issues.id, draftIssueId))
            .then((rows) => rows[0] ?? null);
          if (issueRow) {
            issueContext = issueRow;
          }
        } catch {
          // non-fatal
        }
      }
      const payload = {
        toolName: namespacedName,
        parameters: parameters ?? null,
        summary,
        agentId: runContext.agentId ?? null,
        runId: actor.runUuid,
        projectId: runContext.projectId || null,
        idempotencyKey: runContext.idempotencyKey ?? null,
        // Set when the gate is invoked from a chat-Agent (Clippy) turn — see
        // chat-tools.ts and plugin-mcp-bridge.ts. Used by the approve route to
        // append a follow-up tool-result message into the chat transcript so
        // Clippy can pick up where it left off after the user resolves the
        // draft. Null/absent for ordinary agent runs (those wake via heartbeat).
        chatSessionId: runContext.chatSessionId ?? null,
        // The person who set this call in motion, captured at draft time so the
        // replay after approval acts as them and not as whoever clicked
        // approve. `actor.userId` is the fallback for the older convention
        // where the Clippy user id was only encoded in the agentId prefix.
        userId: runContext.userId ?? actor.userId ?? null,
        draftedAt: new Date().toISOString(),
        actionType: actionPolicy?.actionType ?? null,
        actionPolicySource: actionPolicy?.source ?? null,
        issueId: draftIssueId ?? null,
        issueIdentifier: issueContext?.identifier ?? null,
        issueTitle: issueContext?.title ?? null,
      } satisfies Record<string, unknown>;

      const createdDraft = await approvals.createPendingDraft(runContext.companyId, {
        type: "outbound_tool_draft",
        status: "pending",
        dedupeKey,
        requestedByAgentId: actor.agentUuid,
        requestedByUserId: actor.userId,
        payload,
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
      });
      if (!createdDraft.created) return duplicateResult(createdDraft.approval);
      const approval = createdDraft.approval;

      // Tie the draft to the issue it came out of, so the issue shows the
      // message was drafted and (after approval) sent. This is also what puts
      // an issue id on the post-approval wake, so the agent is woken about the
      // work rather than about a bare approval id.
      if (draftIssueId) {
        try {
          await issueApprovalService(db).link(draftIssueId, approval.id, {
            agentId: actor.agentUuid,
            userId: actor.userId,
          });
        } catch (err) {
          // A draft that is not linked is still a valid draft. Say so and
          // carry on rather than failing the agent's tool call over it.
          log.warn(
            { err, approvalId: approval.id, issueId: draftIssueId },
            "could not link the draft to its issue (non-fatal)",
          );
        }
      }

      // Drop a receipt-style activity entry so the draft surfaces in the
      // Receipt feed and Morning Brief as a "drafted" outcome immediately,
      // not only after the user resolves it.
      try {
        await logActivity(db, {
          companyId: runContext.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          action: "approval.created",
          entityType: "approval",
          entityId: approval.id,
          agentId: actor.agentUuid,
          runId: actor.runUuid,
          details: {
            type: "outbound_tool_draft",
            tool: namespacedName,
            summary,
            actionType: actionPolicy?.actionType ?? null,
            policySource: actionPolicy?.source ?? null,
          },
        });
      } catch (err) {
        log.warn({ err, approvalId: approval.id }, "failed to log draft activity (non-fatal)");
      }
      if (actor.actorType === "agent" && actionPolicy) {
        await logActivity(db, {
          id: deterministicActivityId("agent-action-approval-requested", approval.id),
          companyId: runContext.companyId,
          actorType: "agent",
          actorId: actor.actorId,
          action: "agent_action.approval_requested",
          entityType: "approval",
          entityId: approval.id,
          agentId: actor.agentUuid,
          runId: actor.runUuid,
          details: {
            actionType: actionPolicy.actionType,
            tool: namespacedName,
            policySource: actionPolicy.source,
            summary,
          },
        });
      }

      log.info(
        {
          approvalId: approval.id,
          tool: namespacedName,
          companyId: runContext.companyId,
          agentId: runContext.agentId,
        },
        "outbound tool drafted as approval",
      );

      // Real agent runs get an `approval_approved` heartbeat wake when the
      // user resolves the draft (see approvals.ts approve route). Chat-Agent
      // (Clippy) callers don't — there's no chat-session wake hook — so tell
      // them to end the turn cleanly instead of "wait for the wake".
      const guidance = actor.actorType === "agent"
        ? "The user must approve this draft before it executes. Do not retry the tool — wait for the approval.resolved wake."
        : "The user must approve this draft before it executes. Do not retry the tool. Tell the user it is queued and end your turn — you will not be woken when they approve.";

      // Spelled out because the previous wording did not say it, and an agent
      // read "queued for approval" as close enough to done: it commented
      // "Reached out to Brandon Carr via Slack DM" on the issue at a moment
      // when nothing had been sent and the operator had not yet been asked.
      // The operator then read that sentence as a record of something that
      // happened. Nothing about a draft is worth more than not being lied to
      // about it.
      const nothingSentYet =
        "NOTHING HAS BEEN SENT. No message, email or call has gone out and none will " +
        "until the draft is approved. Do not write, comment or report anywhere that " +
        "you contacted, messaged, emailed or called anyone — say it is waiting for " +
        "approval, and name the person it is waiting on if you know it.";

      const content = [
        DRAFT_RESULT_HEADER,
        `Tool: ${namespacedName}`,
        `Approval ID: ${approval.id}`,
        summary ? `Summary: ${summary}` : null,
        "",
        nothingSentYet,
        "",
        guidance,
      ]
        .filter((line): line is string => line !== null)
        .join("\n");

      return {
        intercepted: true,
        actionPolicy,
        result: {
          content,
          data: {
            drafted: true,
            approvalId: approval.id,
            status: "pending",
            tool: namespacedName,
            summary,
          },
        },
      };
    },
  };
}

/**
 * Look up the approval by ID and re-dispatch its saved tool call as if the
 * agent had executed it directly. Caller is responsible for guarding that
 * the approval was newly transitioned to `approved` (so we don't double-run).
 *
 * Returns the underlying tool result, or `null` if the approval doesn't
 * carry a draftable payload (e.g. type mismatch, malformed payload).
 */
export interface ExecuteDraftedApprovalArgs {
  approvalId: string;
  decidedByUserId: string;
  executeTool: (
    namespacedName: string,
    parameters: unknown,
    runContext: ToolRunContext,
  ) => Promise<{ result: ToolResult }>;
  db: Db;
}

export async function executeDraftedApproval(
  args: ExecuteDraftedApprovalArgs,
): Promise<{
  ok: boolean;
  toolResult?: ToolResult;
  reason?: string;
  outcome?: "refused" | "failed";
}> {
  const approvals = approvalService(args.db);
  const approval = await approvals.getById(args.approvalId);
  if (!approval) return { ok: false, reason: "approval_not_found" };
  if (approval.type !== "outbound_tool_draft")
    return { ok: false, reason: "wrong_type" };

  const payload = approval.payload as Record<string, unknown> | null;
  const toolName = typeof payload?.toolName === "string" ? payload.toolName : null;
  if (!toolName) return { ok: false, reason: "missing_tool_name" };
  const parameters = payload?.parameters ?? {};
  const originalAgentId =
    typeof payload?.agentId === "string" ? payload.agentId : approval.requestedByAgentId;
  if (
    originalAgentId &&
    isUuidLike(originalAgentId) &&
    approval.requestedByAgentId !== originalAgentId
  ) {
    return {
      ok: false,
      reason: "The agent that requested this action no longer exists.",
      outcome: "refused",
    };
  }
  if (originalAgentId && isUuidLike(originalAgentId)) {
    const [requestingAgent] = await args.db
      .select({ companyId: agents.companyId, status: agents.status })
      .from(agents)
      .where(eq(agents.id, originalAgentId))
      .limit(1);
    if (
      !requestingAgent ||
      requestingAgent.companyId !== approval.companyId ||
      !isAgentStatusInvokable(requestingAgent.status)
    ) {
      return {
        ok: false,
        reason: "The agent that requested this action is no longer allowed to run it.",
        outcome: "refused",
      };
    }
  }

  // Re-dispatch via the same dispatcher path. The agentId is the same one
  // that drafted, so company-scope checks and audit attribution stay correct.
  //
  // userId comes from the draft payload rather than from whoever approved, so a
  // per-user tool writes to the list of the person who asked for it. Left
  // undefined when the draft predates that field, which makes a per-user tool
  // refuse instead of acting as the wrong person.
  const runContext: ToolRunContext = {
    companyId: approval.companyId,
    agentId: originalAgentId ?? "draft-approval",
    runId: typeof payload?.runId === "string" && isUuidLike(payload.runId) ? payload.runId : "",
    projectId: typeof payload?.projectId === "string" ? payload.projectId : "",
    idempotencyKey:
      typeof payload?.idempotencyKey === "string" ? payload.idempotencyKey : undefined,
    userId: typeof payload?.userId === "string" ? payload.userId : null,
  };

  try {
    const exec = await args.executeTool(toolName, parameters, runContext);
    log.info(
      {
        approvalId: args.approvalId,
        tool: toolName,
        companyId: approval.companyId,
        hasError: !!exec.result.error,
      },
      "drafted tool executed after approval",
    );
    if (exec.result.error) {
      const reason = exec.result.error;
      return {
        ok: false,
        toolResult: exec.result,
        reason,
        outcome: isAgentActionRefusalReason(reason) ? "refused" : "failed",
      };
    }
    return { ok: true, toolResult: exec.result };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "execution_failed";
    const outcome = (err instanceof HttpError && err.status === 403) ||
      isAgentActionRefusalReason(reason)
      ? "refused"
      : "failed";
    log.error(
      { err, approvalId: args.approvalId, tool: toolName },
      "drafted tool execution failed",
    );
    return { ok: false, reason, outcome };
  }
}
