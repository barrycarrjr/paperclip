import type { HSConversationFull, HSThread } from "../api/helpScoutBridge";

// Picks the message an AI reply draft should be based on, out of a Help Scout
// conversation's thread list. Help Scout bodies are HTML, and the draft
// endpoint wants plain text, so the body is flattened here.

export interface HelpScoutDraftSource {
  subject?: string;
  from?: string;
  bodyText: string;
}

// Thread types that represent something the customer actually said.
const CUSTOMER_THREAD_TYPES = new Set(["customer", "chat", "phone"]);
// Internal bookkeeping threads — never the thing we're replying to.
const SKIP_THREAD_TYPES = new Set(["note", "lineitem"]);

export function htmlToPlainText(html: string): string {
  if (!html) return "";
  return (
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;|&apos;/gi, "'")
      // `&amp;` last so an escaped entity like `&amp;lt;` decodes to the
      // literal text `&lt;` rather than being decoded twice into `<`.
      .replace(/&amp;/gi, "&")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function threadTimestamp(thread: HSThread): number {
  const ms = thread.createdAt ? Date.parse(thread.createdAt) : Number.NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

function threadKind(thread: HSThread): string {
  return (thread.type ?? "").toLowerCase();
}

/** The newest customer-authored message in the conversation, falling back to
 *  the newest non-internal thread when the customer side is empty (e.g. a
 *  conversation the operator started). Returns null when there's nothing to
 *  draft against. */
export function pickDraftSource(
  full: HSConversationFull | null | undefined,
): HelpScoutDraftSource | null {
  const threads = (full?._embedded?.threads ?? []) as HSThread[];
  const usable = threads.filter(
    (t) =>
      !SKIP_THREAD_TYPES.has(threadKind(t)) &&
      htmlToPlainText(t.body ?? t.text ?? "").length > 0,
  );
  if (usable.length === 0) return null;

  const byNewest = [...usable].sort((a, b) => threadTimestamp(b) - threadTimestamp(a));
  const chosen = byNewest.find((t) => CUSTOMER_THREAD_TYPES.has(threadKind(t))) ?? byNewest[0]!;

  const from =
    chosen.customer?.email ||
    chosen.createdBy?.email ||
    full?.primaryCustomer?.email ||
    full?.customer?.email ||
    undefined;

  return {
    subject: (full?.subject as string | undefined) || undefined,
    from,
    bodyText: htmlToPlainText(chosen.body ?? chosen.text ?? ""),
  };
}
