export interface RunCounts {
  itemsRead: number;
  entriesAdded: number;
  changesProposed: number;
}

/** Counts metadata is set by the server for a real issue-bound unattended run. */
export function runCountsPromptForWake(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const wake = value as Record<string, unknown>;
  const issue = wake.issue as Record<string, unknown> | null;
  if (wake.runCountsRequired !== true || !issue || typeof issue.id !== "string" || !issue.id.trim()) return "";
  return runCountsPromptInstructions(typeof wake.runCountsRetryReason === "string" ? wake.runCountsRetryReason : null);
}

export type RunCountsFooterResult =
  | { status: "reported"; counts: RunCounts; reason: null }
  | { status: "missing" | "invalid"; counts: null; reason: string };

export function readRunCounts(value: unknown): RunCounts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const fields = ["itemsRead", "entriesAdded", "changesProposed"] as const;
  if (!fields.every((field) => typeof record[field] === "number" && Number.isSafeInteger(record[field]) && (record[field] as number) >= 0)) return null;
  return { itemsRead: record.itemsRead as number, entriesAdded: record.entriesAdded as number, changesProposed: record.changesProposed as number };
}

export function formatRunCountsFooter(value: RunCounts): string {
  const counts = readRunCounts(value);
  if (!counts) throw new RangeError("Run counts must be nonnegative safe integers");
  return `Counts: items read ${counts.itemsRead}; entries added ${counts.entriesAdded}; changes proposed ${counts.changesProposed}.`;
}

/** Only a final prose footer is a report. Missing values never become zero. */
export function parseRunCountsFooter(value: unknown): RunCountsFooterResult {
  if (typeof value !== "string" || !value.trim()) return { status: "missing", counts: null, reason: "No final count footer was reported" };
  const lines = value.trimEnd().split(/\r\n?|\n/);
  const finalIndex = lines.length - 1;
  let fence: { character: string; length: number } | null = null;
  let comment = false;
  let footerLines = 0;
  const scanHtmlComments = (line: string, startsInside: boolean) => {
    let inside = startsInside;
    let cursor = 0;
    let marker = false;
    while (cursor < line.length) {
      const token = inside ? "-->" : "<!--";
      const next = line.indexOf(token, cursor);
      if (next < 0) break;
      marker = true;
      inside = !inside;
      cursor = next + token.length;
    }
    return { inside, marker };
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    let hidden = false;
    if (fence) {
      hidden = true;
      if (delimiter && delimiter[1]![0] === fence.character && delimiter[1]!.length >= fence.length && line.slice(delimiter[0].length).trim() === "") fence = null;
    } else if (comment) {
      hidden = true;
      comment = scanHtmlComments(line, true).inside;
    } else if (delimiter) {
      hidden = true;
      fence = { character: delimiter[1]![0]!, length: delimiter[1]!.length };
    } else {
      const scan = scanHtmlComments(line, false);
      hidden = scan.marker;
      comment = scan.inside;
    }
    if (!hidden && /^Counts:/i.test(line)) footerLines += 1;
    if (index === finalIndex && (hidden || fence || comment)) return { status: "invalid", counts: null, reason: "The count footer must be outside code and comments" };
  }
  if (footerLines > 1) return { status: "invalid", counts: null, reason: "Report exactly one final count footer" };
  const finalLine = lines[finalIndex]!;
  if (!/^Counts:/i.test(finalLine)) return { status: "missing", counts: null, reason: "End the final task comment with the count footer" };
  const match = /^Counts: items read (0|[1-9]\d{0,15}); entries added (0|[1-9]\d{0,15}); changes proposed (0|[1-9]\d{0,15})\.$/.exec(finalLine);
  const counts = match ? readRunCounts({ itemsRead: Number(match[1]), entriesAdded: Number(match[2]), changesProposed: Number(match[3]) }) : null;
  return counts ? { status: "reported", counts, reason: null } : { status: "invalid", counts: null, reason: "Use the exact footer with all three nonnegative safe integer counts, including zero" };
}

export function runCountsPromptInstructions(retryReason?: string | null): string {
  const reportingRetry = retryReason === "missing_run_counts" || retryReason === "invalid_run_counts" || retryReason === "missing_issue_comment";
  const correction = retryReason === "missing_run_counts" || retryReason === "invalid_run_counts"
    ? "The preceding run posted a task comment with a missing or malformed count footer. Post a corrected final task comment with the required footer. Do not redo completed work or invent its counts."
    : retryReason === "missing_issue_comment"
      ? "The preceding run did not post its required final task comment. Post that comment with the required footer."
      : "Post a final comment on this issue before ending this unattended run.";
  return [
    "Run count reporting:",
    correction,
    reportingRetry
      ? "This is a reporting correction. The footer must report the preceding run's actual work from its retained evidence, not this technical follow-up's work. Do not redo that work or invent unknown counts; explain missing evidence if a count cannot be established."
      : "Count only work actually performed in this invocation: distinct source items opened and read, new durable entries added, and distinct changes proposed for review. Do not count repeated reads twice or treat this reporting comment as a new entry. These are self-reported counts, not audited totals.",
    "End the comment with this exact single prose line, replacing each zero with your actual nonnegative integer count. State zero explicitly when nothing was read, added, or proposed:",
    formatRunCountsFooter({ itemsRead: 0, entriesAdded: 0, changesProposed: 0 }),
  ].join("\n");
}
