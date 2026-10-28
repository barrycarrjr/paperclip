/**
 * Human labels for approvals. Lives in shared because BOTH the UI and the
 * attention queue on the server need the same words: an approval must read
 * identically in the queue, in the Brief, in the Inbox and on its own page.
 * (The icon map stays in the UI, since it imports React components.)
 */

export const APPROVAL_TYPE_LABEL: Record<string, string> = {
  hire_agent: "Hire Agent",
  approve_ceo_strategy: "CEO Strategy",
  budget_override_required: "Budget Override",
  request_board_approval: "Board Approval",
  outbound_tool_draft: "Draft",
  instruction_change: "Instruction Rule",
};

/**
 * Map a `<pluginKey>:<toolName>` string to a short, human-readable verb
 * phrase ("Email reply", "Slack DM", "Outbound call"). Falls back to the
 * humanized tool name.
 */
const OUTBOUND_TOOL_LABEL: Record<string, string> = {
  "email-tools:email_send": "Email",
  "email-tools:email_reply": "Email reply",
  "email-tools:email_mark_read": "Mark email read",
  "email-tools:email_mark_unread": "Mark email unread",
  "email-tools:email_move": "Move email",
  "email-tools:email_save_contact": "Save email contact",
  "email-tools:email_import_contacts": "Import email contacts",
  "help-scout:helpscout_send_reply": "HelpScout reply",
  "help-scout:helpscout_create_conversation": "HelpScout conversation",
  "slack-tools:slack_send_dm": "Slack DM",
  "slack-tools:slack_send_channel": "Slack post",
  "slack-tools:slack_create_channel": "Create Slack channel",
  "slack-tools:slack_invite_users": "Invite Slack users",
  "slack-tools:slack_update_message": "Update Slack message",
  "slack-tools:slack_delete_message": "Delete Slack message",
  "phone-tools:phone_call_make": "Outbound call",
  "phone-tools:phone_call_end": "End call",
  "phone-tools:phone_campaign_start": "Start phone campaign",
  "phone-tools:phone_campaign_pause": "Pause phone campaign",
  "phone-tools:phone_campaign_resume": "Resume phone campaign",
  "phone-tools:phone_campaign_stop": "Stop phone campaign",
  "phone-tools:phone_assistant_create": "Create phone assistant",
  "phone-tools:phone_assistant_update": "Update phone assistant",
  "phone-tools:phone_assistant_delete": "Delete phone assistant",
  "phone-tools:phone_campaign_create": "Create phone campaign",
  "phone-tools:phone_campaign_update": "Update phone campaign",
  "phone-tools:phone_dnc_add": "Add to do-not-call list",
  "phone-tools:phone_dnc_remove": "Remove from do-not-call list",
  "3cx-tools:pbx_click_to_call": "Click-to-call",
  "3cx-tools:pbx_park_call": "Park call",
  "3cx-tools:pbx_pickup_park": "Pick up call",
  "3cx-tools:pbx_transfer_call": "Transfer call",
  "3cx-tools:pbx_hangup_call": "Hang up call",
  "google-workspace:gcal_create_event": "Create calendar event",
  "google-workspace:gcal_update_event": "Update calendar event",
  "google-workspace:gcal_delete_event": "Delete calendar event",
  "google-workspace:gtasks_create_task": "Create task",
  "google-workspace:gtasks_update_task": "Update task",
  "google-workspace:gtasks_complete_task": "Complete task",
  "google-workspace:gtasks_delete_task": "Delete task",
  "todo-list:todo_add": "Add to-do",
  "todo-list:todo_complete": "Complete to-do",
  "todo-list:todo_remove": "Remove to-do",
  "github-tools:github_create_release": "Create GitHub release",
  "github-tools:github_create_issue": "Create GitHub issue",
  "github-tools:github_create_pr": "Create pull request",
  // Public posts. Duplicated in ui/src/lib/outcomes.ts on purpose (see the
  // comment there); edit both together or the receipt feed and the approval
  // card disagree.
  "gbp-reviews:gbp_reply_to_review": "Public review reply",
  "review-tools:gbp_reply_to_review": "Public review reply",
  "social-poster:post_to_facebook": "Facebook post",
  "social-poster:post_to_instagram": "Instagram post",
  "social-poster:post_to_x": "X post",
  "social-poster:post_to_tiktok": "TikTok post",
  "social-poster:post_to_threads": "Threads post",
  "instagram-tools:instagram_post_photo": "Instagram photo",
  "instagram-tools:instagram_post_carousel": "Instagram carousel",
  "instagram-tools:instagram_post_reel": "Instagram reel",
  "instagram-tools:instagram_post_story": "Instagram story",
  "youtube-tools:youtube_upload": "YouTube upload",
  "youtube-tools:youtube_post_comment": "YouTube comment",
  "kdp-tools:kdp_publish": "KDP publish",
};

/** Converts a raw or namespaced tool name (e.g. "email_mark_read") to Title case words. */
export function humanizeToolName(raw: string): string {
  const short = raw.split(":").pop() ?? raw;
  const words = short.split(/[_-]+/).filter(Boolean);
  if (words.length === 0) return raw;
  return words
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w.toLowerCase()))
    .join(" ");
}

export function outboundToolLabel(toolName: string | null | undefined): string {
  if (!toolName) return "Outbound action";
  return OUTBOUND_TOOL_LABEL[toolName] ?? humanizeToolName(toolName);
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

export function summarizeParameters(params: Record<string, unknown>): string | null {
  if (params.mailbox && params.uid) {
    return `mailbox ${String(params.mailbox)}, UID ${String(params.uid)}`;
  }
  if (params.mailbox) {
    return `mailbox ${String(params.mailbox)}`;
  }
  const titleVal = firstNonEmptyString(params.title, params.subject, params.name);
  if (titleVal) return titleVal;

  const targetVal = firstNonEmptyString(
    params.path,
    params.filePath,
    params.filename,
    params.url,
    params.query,
    params.target,
    params.channel,
    params.channelName,
  );
  if (targetVal) return targetVal;

  const entries = Object.entries(params)
    .filter(
      ([k, v]) =>
        !["companyId", "hostScope"].includes(k) &&
        (typeof v === "string" || typeof v === "number" || typeof v === "boolean"),
    )
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${v}`);
  if (entries.length > 0) {
    return entries.join(", ");
  }
  return null;
}

export function approvalSubject(payload?: Record<string, unknown> | null): string | null {
  return firstNonEmptyString(
    payload?.title,
    payload?.name,
    payload?.summary,
    payload?.recommendedAction,
  );
}

/** Contextual label for an approval, e.g. "Hire Agent: Designer" or "Mark email read: mailbox m3-barry, UID 280179". */
export function approvalLabel(type: string, payload?: Record<string, unknown> | null): string {
  if (type === "outbound_tool_draft") {
    const toolName = typeof payload?.toolName === "string" ? payload.toolName : null;
    const verb = outboundToolLabel(toolName);
    const summary = typeof payload?.summary === "string" ? payload.summary.trim() : null;

    // Never repeat the tool name (e.g. "email_mark_read: email-tools:email_mark_read")
    const isGenericSummary =
      !summary ||
      summary === toolName ||
      summary === verb ||
      (toolName !== null && summary.endsWith(toolName)) ||
      (toolName !== null && toolName.endsWith(summary));

    if (summary && !isGenericSummary) {
      return `${verb}: ${summary}`;
    }

    const params = payload?.parameters;
    if (params && typeof params === "object" && !Array.isArray(params)) {
      const paramSummary = summarizeParameters(params as Record<string, unknown>);
      if (paramSummary) {
        return `${verb}: ${paramSummary}`;
      }
    }
    return verb;
  }
  if (type === "instruction_change") {
    const rule = firstNonEmptyString(payload?.rule);
    if (!rule) return APPROVAL_TYPE_LABEL.instruction_change;
    const compactRule = rule.replace(/\s+/g, " ");
    return `Instruction Rule: ${compactRule.length > 100 ? `${compactRule.slice(0, 97)}...` : compactRule}`;
  }
  const base = APPROVAL_TYPE_LABEL[type] ?? type;
  const subject = approvalSubject(payload);
  return subject ? `${base}: ${subject}` : base;
}
