export interface ReviewQueueEntry {
  count: number;
  sender: string;
}

const SECTION_HEADERS = {
  autoTriage: "## Auto-triage senders",
  keepAlways: "## Keep-always senders",
  reviewQueue: "## Review queue",
} as const;

// Canonical line: "5 messages from foo@bar.com" (what the SKILL.md describes).
const COUNTED_LINE_RE = /^(\d+)\s+messages?\s+from\s+(.+?)\s*$/i;

// Extract the first sender token (full email, @domain, or `subject:` form)
// from a line. Used as a fallback when agents write entries in a richer
// "<sender> <separator> <description> [<separator> <recommendation>]"
// format that doesn't carry an explicit count. Different per-company
// COOs have drifted into slightly different formats — some use `|` as
// the separator, some use em-dash `—`, some use ` - `. The parser
// tolerates all of them so the operator UI can still render rows +
// Auto-triage / Keep / Dismiss buttons either way.
//
// Email / @domain patterns are well-bounded on their own and don't need
// a separator lookahead. `subject:` is freeform text so it stops at the
// first separator (pipe, em-dash, or end of line).
const EMAIL_OR_DOMAIN_RE = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i;
const SUBJECT_RE = /(subject:\s*[^|—]+?)(?=\s*[|—]|\s*$)/i;

function stripBullet(line: string): string {
  return line.replace(/^[-*+]\s+/, "");
}

function parseReviewLine(rawLine: string): ReviewQueueEntry | null {
  const line = rawLine.trim();
  if (!line) return null;
  if (line.startsWith("<!--") || line.startsWith("-->") || line.startsWith("#")) return null;
  if (line.startsWith("`<count>")) return null;

  const stripped = stripBullet(line);
  const counted = COUNTED_LINE_RE.exec(stripped);
  if (counted) {
    const count = Number.parseInt(counted[1], 10);
    const senderRaw = counted[2].trim();
    // Senders may still carry a trailing " | description ..." or " — description ...".
    const sender = senderRaw.split(/\s*[|—]\s*/)[0]!.trim();
    if (Number.isFinite(count) && sender) return { count, sender };
    return null;
  }

  const emailMatch = EMAIL_OR_DOMAIN_RE.exec(stripped);
  if (emailMatch) {
    return { count: 1, sender: emailMatch[1]!.trim() };
  }
  const subjectMatch = SUBJECT_RE.exec(stripped);
  if (subjectMatch) {
    return { count: 1, sender: subjectMatch[1]!.trim() };
  }
  return null;
}

function getSectionRange(body: string, header: string): { start: number; end: number } | null {
  const start = body.indexOf(header);
  if (start === -1) return null;
  const after = start + header.length;
  const nextHeaderIdx = body.indexOf("\n## ", after);
  const end = nextHeaderIdx === -1 ? body.length : nextHeaderIdx;
  return { start: after, end };
}

export function parseReviewQueue(body: string): ReviewQueueEntry[] {
  const range = getSectionRange(body, SECTION_HEADERS.reviewQueue);
  if (!range) return [];
  const section = body.slice(range.start, range.end);
  const entries: ReviewQueueEntry[] = [];
  for (const rawLine of section.split("\n")) {
    const entry = parseReviewLine(rawLine);
    if (entry) entries.push(entry);
  }
  return entries.sort((a, b) => b.count - a.count);
}

function removeFromReviewQueue(body: string, sender: string): string {
  const trimmed = sender.trim();
  if (!trimmed) return body;
  const reviewRange = getSectionRange(body, SECTION_HEADERS.reviewQueue);
  if (!reviewRange) return body;
  const before = body.slice(0, reviewRange.start);
  const tail = body.slice(reviewRange.end);
  const section = body.slice(reviewRange.start, reviewRange.end);
  const filtered = section
    .split("\n")
    .filter((line) => {
      const entry = parseReviewLine(line);
      if (!entry) return true;
      return entry.sender.toLowerCase() !== trimmed.toLowerCase();
    })
    .join("\n");
  return before + filtered + tail;
}

function addSenderToSection(body: string, sender: string, sectionHeader: string): string {
  const trimmed = sender.trim();
  if (!trimmed) return body;

  const range = getSectionRange(body, sectionHeader);
  if (range) {
    const before = body.slice(0, range.end);
    const after = body.slice(range.end);
    const sectionBody = body.slice(range.start, range.end);
    // Strip bullet prefix before comparing so "- foo@bar.com" and "foo@bar.com" are treated as the same.
    const alreadyPresent = sectionBody
      .split("\n")
      .some((line) => stripBullet(line).trim().toLowerCase() === trimmed.toLowerCase());
    if (alreadyPresent) return body;
    const trailingNl = sectionBody.endsWith("\n\n") ? "" : sectionBody.endsWith("\n") ? "\n" : "\n\n";
    return before.replace(/\n*$/, "") + "\n- " + trimmed + trailingNl + after.replace(/^\n+/, "\n");
  }

  return body.replace(/\s*$/, "") + `\n\n${sectionHeader}\n\n- ${trimmed}\n`;
}

export function graduateSender(body: string, sender: string): string {
  const next = addSenderToSection(body, sender, SECTION_HEADERS.autoTriage);
  return removeFromReviewQueue(next, sender);
}

export function keepAlwaysSender(body: string, sender: string): string {
  const next = addSenderToSection(body, sender, SECTION_HEADERS.keepAlways);
  return removeFromReviewQueue(next, sender);
}

export function dismissReviewSender(body: string, sender: string): string {
  return removeFromReviewQueue(body, sender);
}
