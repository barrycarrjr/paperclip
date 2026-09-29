import { useState } from "react";
import { UserPlus, Lightbulb, ShieldAlert, ShieldCheck, Pencil, ChevronRight } from "lucide-react";
import {
  APPROVAL_TYPE_LABEL,
  approvalLabel,
  approvalSubject,
  outboundToolLabel,
} from "@paperclipai/shared";
import { cn, formatCents } from "../lib/utils";

// The label logic moved to @paperclipai/shared so the attention queue on the
// server produces the exact same words. Re-exported here because this module
// is the established import site across the UI.
export { approvalLabel, approvalSubject, outboundToolLabel };
export const typeLabel = APPROVAL_TYPE_LABEL;

/** Local payload-field reader used by the renderer below. */
function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

export const typeIcon: Record<string, typeof UserPlus> = {
  hire_agent: UserPlus,
  approve_ceo_strategy: Lightbulb,
  budget_override_required: ShieldAlert,
  request_board_approval: ShieldCheck,
  outbound_tool_draft: Pencil,
};

export const defaultTypeIcon = ShieldCheck;

function PayloadField({ label, value }: { label: string; value: unknown }) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">{label}</span>
      <span className="min-w-0 wrap-anywhere">{String(value)}</span>
    </div>
  );
}

/** Who an outgoing draft goes to and what it says. */
export interface OutboundDraftPreview {
  recipient: string | null;
  cc: string | null;
  bcc: string | null;
  subject: string | null;
  message: string | null;
  /**
   * Parts of the draft the quote does not show (Slack blocks, an HTML
   * version, attachments, sending as the operator), so the approver knows
   * to open the full request.
   */
  extras: string[];
}

type DraftRecipients = Pick<OutboundDraftPreview, "recipient" | "cc" | "bcc">;

/** Email `to` is a string or a list of strings. */
function addressList(value: unknown): string | null {
  if (Array.isArray(value)) {
    const addresses = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
    return addresses.length > 0 ? addresses.join(", ") : null;
  }
  return firstNonEmptyString(value);
}

/**
 * Where each messaging tool reads its recipients, in the plugin's own order.
 * The server does not check a call's parameters against the plugin's schema,
 * so a draft can carry fields the tool ignores; one shared list of field
 * names could then show a stray field instead of where the message really
 * goes. Tools missing here fall back to the shared list below.
 */
const RECIPIENT_READERS: Record<string, (p: Record<string, unknown>) => DraftRecipients> = {
  // No userId sends to the workspace's default DM target, which is the
  // operator (see OUTBOUND_SELF_RECIPIENT_RULES).
  "slack-tools:slack_send_dm": (p) => ({
    recipient: firstNonEmptyString(p.userId) ?? "You",
    cc: null,
    bcc: null,
  }),
  // The worker posts to channelId when it has one (the name is then
  // ignored), and to the workspace's default channel when it has neither.
  "slack-tools:slack_send_channel": (p) => {
    const channelName = firstNonEmptyString(p.channelName);
    return {
      recipient:
        firstNonEmptyString(p.channelId) ??
        (channelName ? `#${channelName.replace(/^#/, "")}` : "Default channel"),
      cc: null,
      bcc: null,
    };
  },
  "email-tools:email_send": (p) => ({
    recipient: addressList(p.to),
    cc: addressList(p.cc),
    bcc: addressList(p.bcc),
  }),
  // customerId wins over customerEmail; with neither, the reply goes to the
  // conversation's own customer.
  "help-scout:helpscout_send_reply": (p) => {
    const customerId =
      typeof p.customerId === "number" ? String(p.customerId) : firstNonEmptyString(p.customerId);
    return {
      recipient: customerId
        ? `Help Scout customer ${customerId}`
        : firstNonEmptyString(p.customerEmail) ?? "The conversation's customer",
      cc: addressList(p.cc),
      bcc: addressList(p.bcc),
    };
  },
  "phone-tools:phone_call_make": (p) => ({
    recipient: firstNonEmptyString(p.to),
    cc: null,
    bcc: null,
  }),
};

function fallbackRecipients(p: Record<string, unknown>): DraftRecipients {
  const channelName = firstNonEmptyString(p.channelName);
  return {
    recipient:
      addressList(p.to) ??
      firstNonEmptyString(p.recipient, p.userId, p.user) ??
      (channelName ? `#${channelName.replace(/^#/, "")}` : null) ??
      firstNonEmptyString(p.channelId, p.channel, p.phoneNumber),
    cc: addressList(p.cc),
    bcc: addressList(p.bcc),
  };
}

/**
 * What the recipient gets beyond the quoted text. Read per plugin, like the
 * recipients: each field only means this for the plugins listed.
 */
function draftExtras(toolName: string | null, p: Record<string, unknown>): string[] {
  const plugin = toolName?.split(":")[0];
  const extras: string[] = [];
  // Slack shows the blocks and uses `text` only as the notification.
  if (plugin === "slack-tools" && Array.isArray(p.blocks) && p.blocks.length > 0) {
    extras.push("formatted Slack blocks");
  }
  if (plugin === "email-tools" && firstNonEmptyString(p.body_html)) {
    extras.push("an HTML version");
  }
  if (
    (plugin === "email-tools" || plugin === "help-scout") &&
    Array.isArray(p.attachments) &&
    p.attachments.length > 0
  ) {
    extras.push(p.attachments.length === 1 ? "1 attachment" : `${p.attachments.length} attachments`);
  }
  // The Slack worker treats any truthy asUser as "send with the user token".
  if (plugin === "slack-tools" && p.asUser) {
    extras.push("sent from your own Slack account");
  }
  return extras;
}

/**
 * Read the recipients and message out of an outbound draft's saved tool call
 * (`payload.parameters`), using the field names each tool actually reads
 * (see RECIPIENT_READERS). Returns null when the draft carries none of them.
 */
export function outboundDraftPreview(
  payload: Record<string, unknown> | null | undefined,
): OutboundDraftPreview | null {
  const params = payload?.parameters;
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const p = params as Record<string, unknown>;
  const toolName = typeof payload?.toolName === "string" ? payload.toolName : null;

  const readRecipients = (toolName && RECIPIENT_READERS[toolName]) || fallbackRecipients;
  const { recipient, cc, bcc } = readRecipients(p);
  const subject = firstNonEmptyString(p.subject);
  const message = firstNonEmptyString(p.text, p.body, p.message, p.replyText, p.caption, p.comment);

  if (!recipient && !subject && !message) return null;
  return { recipient, cc, bcc, subject, message, extras: draftExtras(toolName, p) };
}

export function OutboundDraftPayload({
  preview,
  compact = false,
}: {
  preview: OutboundDraftPreview;
  compact?: boolean;
}) {
  return (
    <div className="mt-3 min-w-0 space-y-1.5 text-sm">
      <PayloadField label="To" value={preview.recipient} />
      <PayloadField label="Cc" value={preview.cc} />
      <PayloadField label="Bcc" value={preview.bcc} />
      <PayloadField label="Subject" value={preview.subject} />
      {preview.message && (
        <blockquote
          className={cn(
            "mt-2 border-l-2 border-border pl-3 leading-6 text-foreground/90 whitespace-pre-wrap wrap-anywhere",
            compact && "line-clamp-4",
          )}
        >
          {preview.message}
        </blockquote>
      )}
      {preview.extras.length > 0 && (
        <p className="text-xs text-muted-foreground wrap-anywhere">
          {`Also: ${preview.extras.join(", ")}. Open "See full request" to check.`}
        </p>
      )}
    </div>
  );
}

/**
 * The request exactly as saved, collapsed by default. The JSON wraps and
 * scrolls inside its own box, so a long run id or session key can never make
 * the card wider than the page.
 */
export function FullRequestToggle({ payload, className }: { payload: unknown; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("min-w-0", className)}>
      <button
        type="button"
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
        See full request
      </button>
      {open && (
        <pre className="mt-2 max-h-80 max-w-full overflow-auto whitespace-pre-wrap wrap-anywhere rounded-md bg-muted/40 p-3 text-xs">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

function SkillList({ values }: { values: unknown }) {
  if (!Array.isArray(values)) return null;
  const items = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  if (items.length === 0) return null;

  return (
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Skills</span>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span
            key={item}
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

export function HireAgentPayload({ payload }: { payload: Record<string, unknown> }) {
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Name</span>
        <span className="font-medium">{String(payload.name ?? "—")}</span>
      </div>
      <PayloadField label="Role" value={payload.role} />
      <PayloadField label="Title" value={payload.title} />
      <PayloadField label="Icon" value={payload.icon} />
      {!!payload.capabilities && (
        <div className="flex items-start gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Capabilities</span>
          <span className="text-muted-foreground">{String(payload.capabilities)}</span>
        </div>
      )}
      {!!payload.adapterType && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Adapter</span>
          <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
            {String(payload.adapterType)}
          </span>
        </div>
      )}
      <SkillList values={payload.desiredSkills} />
    </div>
  );
}

export function CeoStrategyPayload({
  payload,
  hideRawFallback = false,
}: {
  payload: Record<string, unknown>;
  hideRawFallback?: boolean;
}) {
  const plan = payload.plan ?? payload.description ?? payload.strategy ?? payload.text;
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Title" value={payload.title} />
      {!!plan && (
        <div className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground whitespace-pre-wrap font-mono text-xs max-h-48 overflow-y-auto">
          {String(plan)}
        </div>
      )}
      {!plan && !hideRawFallback && (
        <pre className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground overflow-x-auto max-h-48">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function BudgetOverridePayload({ payload }: { payload: Record<string, unknown> }) {
  const budgetAmount = typeof payload.budgetAmount === "number" ? payload.budgetAmount : null;
  const observedAmount = typeof payload.observedAmount === "number" ? payload.observedAmount : null;
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Scope" value={payload.scopeName ?? payload.scopeType} />
      <PayloadField label="Window" value={payload.windowKind} />
      <PayloadField label="Metric" value={payload.metric} />
      {(budgetAmount !== null || observedAmount !== null) ? (
        <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Limit {budgetAmount !== null ? formatCents(budgetAmount) : "—"} · Observed {observedAmount !== null ? formatCents(observedAmount) : "—"}
        </div>
      ) : null}
      {!!payload.guidance && (
        <p className="text-muted-foreground">{String(payload.guidance)}</p>
      )}
    </div>
  );
}

export function BoardApprovalPayload({
  payload,
  hideTitle = false,
}: {
  payload: Record<string, unknown>;
  hideTitle?: boolean;
}) {
  const nextPayload = hideTitle ? { ...payload, title: undefined } : payload;
  return (
    <BoardApprovalPayloadContent payload={nextPayload} />
  );
}

function BoardApprovalPayloadContent({ payload }: { payload: Record<string, unknown> }) {
  const risks = Array.isArray(payload.risks)
    ? payload.risks
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  const title = firstNonEmptyString(payload.title);
  const summary = firstNonEmptyString(payload.summary);
  const recommendedAction = firstNonEmptyString(payload.recommendedAction);
  const nextActionOnApproval = firstNonEmptyString(payload.nextActionOnApproval);
  const proposedComment = firstNonEmptyString(payload.proposedComment);

  return (
    <div className="mt-4 space-y-3.5 text-sm">
      {title && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Title</p>
          <p className="font-medium leading-6 text-foreground">{title}</p>
        </div>
      )}
      {summary && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Summary</p>
          <p className="leading-6 text-foreground/90">{summary}</p>
        </div>
      )}
      {recommendedAction && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3.5 py-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-amber-700 dark:text-amber-300">
            Recommended action
          </p>
          <p className="mt-1 leading-6 text-foreground">{recommendedAction}</p>
        </div>
      )}
      {nextActionOnApproval && (
        <div className="rounded-lg border border-border/60 bg-background/60 px-3.5 py-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">On approval</p>
          <p className="mt-1 leading-6 text-foreground">{nextActionOnApproval}</p>
        </div>
      )}
      {risks.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Risks</p>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {risks.map((risk) => (
              <li key={risk} className="flex items-start gap-2">
                <span className="mt-2 h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
                <span className="leading-6">{risk}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {proposedComment && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Proposed comment
          </p>
          <pre className="max-h-48 overflow-auto rounded-lg border border-border/60 bg-muted/50 px-3.5 py-3 font-mono text-xs leading-5 text-muted-foreground whitespace-pre-wrap">
            {proposedComment}
          </pre>
        </div>
      )}
    </div>
  );
}

export function ApprovalPayloadRenderer({
  type,
  payload,
  hidePrimaryTitle = false,
  compact = false,
}: {
  type: string;
  payload: Record<string, unknown>;
  hidePrimaryTitle?: boolean;
  /**
   * Card view: clamps long message text and leaves the raw JSON to the
   * card's own "See full request" toggle instead of printing it inline.
   */
  compact?: boolean;
}) {
  if (type === "hire_agent") return <HireAgentPayload payload={payload} />;
  if (type === "budget_override_required") return <BudgetOverridePayload payload={payload} />;
  if (type === "request_board_approval") {
    return <BoardApprovalPayload payload={payload} hideTitle={hidePrimaryTitle} />;
  }
  if (type === "outbound_tool_draft") {
    const preview = outboundDraftPreview(payload);
    if (preview) return <OutboundDraftPayload preview={preview} compact={compact} />;
  }
  return <CeoStrategyPayload payload={payload} hideRawFallback={compact} />;
}
