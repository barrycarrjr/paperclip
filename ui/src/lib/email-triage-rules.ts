export interface ReviewQueueEntry {
  count: number;
  sender: string;
}

const SECTION_HEADERS = {
  autoTriage: "## Auto-triage senders",
  keepAlways: "## Keep-always senders",
  reviewQueue: "## Review queue",
} as const;

const REVIEW_LINE_RE = /^(\d+)\s+messages?\s+from\s+(.+?)\s*$/i;

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
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("<!--") || line.startsWith("-->") || line.startsWith("#")) continue;
    if (line.startsWith("`<count>")) continue;
    const m = REVIEW_LINE_RE.exec(line);
    if (!m) continue;
    const count = Number.parseInt(m[1], 10);
    const sender = m[2].trim();
    if (!Number.isFinite(count) || !sender) continue;
    entries.push({ count, sender });
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
      const m = REVIEW_LINE_RE.exec(line.trim());
      if (!m) return true;
      return m[2].trim().toLowerCase() !== trimmed.toLowerCase();
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
    const senderEscaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const alreadyPresent = new RegExp(`(^|\\n)\\s*${senderEscaped}\\s*(\\n|$)`, "i").test(
      sectionBody,
    );
    if (alreadyPresent) return body;
    const trailingNl = sectionBody.endsWith("\n\n") ? "" : sectionBody.endsWith("\n") ? "\n" : "\n\n";
    return before.replace(/\n*$/, "") + "\n" + trimmed + trailingNl + after.replace(/^\n+/, "\n");
  }

  return body.replace(/\s*$/, "") + `\n\n${sectionHeader}\n\n${trimmed}\n`;
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
