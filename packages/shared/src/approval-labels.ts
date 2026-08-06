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
};

/**
 * Map a `<pluginKey>:<toolName>` string to a short, human-readable verb
 * phrase ("Email reply", "Slack DM", "Outbound call"). Falls back to the
 * raw tool name.
 */
const OUTBOUND_TOOL_LABEL: Record<string, string> = {
  "email-tools:email_send": "Email",
  "email-tools:email_reply": "Email reply",
  "help-scout:helpscout_send_reply": "HelpScout reply",
  "help-scout:helpscout_create_conversation": "HelpScout conversation",
  "slack-tools:slack_send_dm": "Slack DM",
  "slack-tools:slack_send_channel": "Slack post",
  "phone-tools:phone_call_make": "Outbound call",
  "3cx-tools:pbx_click_to_call": "Click-to-call",
};

export function outboundToolLabel(toolName: string | null | undefined): string {
  if (!toolName) return "Outbound action";
  return OUTBOUND_TOOL_LABEL[toolName] ?? toolName.split(":").pop() ?? toolName;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
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

/** Contextual label for an approval, e.g. "Hire Agent: Designer". */
export function approvalLabel(type: string, payload?: Record<string, unknown> | null): string {
  if (type === "outbound_tool_draft") {
    const toolName = typeof payload?.toolName === "string" ? payload.toolName : null;
    const verb = outboundToolLabel(toolName);
    const summary = typeof payload?.summary === "string" ? payload.summary : null;
    if (summary) return `${verb}: ${summary}`;
    return verb;
  }
  const base = APPROVAL_TYPE_LABEL[type] ?? type;
  const subject = approvalSubject(payload);
  return subject ? `${base}: ${subject}` : base;
}
