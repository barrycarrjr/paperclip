import type { CommentRedactionResponse } from "@paperclipai/shared";

const privateChatCaveat = "Cleanup of other users' private chats cannot be confirmed.";

function visibleCaveats(result: { cutoffCheckComplete?: boolean; residualMatches?: number; activeRunCount?: number | null; oversizedFields?: number; skippedFields?: number; fileCleanup?: unknown }) {
  const parts: string[] = [];
  if (result.cutoffCheckComplete === false) parts.push("The cut-off copy check did not finish; additional partial copies may remain.");
  if (result.residualMatches) parts.push(`${result.residualMatches} remaining matches or possible cut-off pieces need separate cleanup.`);
  if (result.activeRunCount) parts.push(`${result.activeRunCount} active ${result.activeRunCount === 1 ? "run may" : "runs may"} write copies again.`);
  if (result.activeRunCount === null) parts.push("Active run count could not be checked.");
  if (result.oversizedFields) parts.push(`${result.oversizedFields} oversized ${result.oversizedFields === 1 ? "field was" : "fields were"} skipped.`);
  if (result.skippedFields) parts.push(`${result.skippedFields} deeply nested ${result.skippedFields === 1 ? "field was" : "fields were"} skipped.`);
  if (result.fileCleanup === "incomplete") parts.push("Some run log files were skipped or retained matches; database changes were saved.");
  return parts;
}

export function commentRedactionResultToast(result: CommentRedactionResponse) {
  const copies = Object.entries(result.placesChanged).reduce((sum, [key, value]) => sum + (key === "comment" ? 0 : value), 0);
  const parts = [`${result.replaced} ${result.replaced === 1 ? "place" : "places"} hidden in the comment; ${copies} stored ${copies === 1 ? "copy" : "copies"} cleaned.`];
  if (result.otherCommentsWithText) parts.push(`The same text still appears in ${result.otherCommentsWithText} other ${result.otherCommentsWithText === 1 ? "comment" : "comments"} in this company.`);
  parts.push(...visibleCaveats(result), privateChatCaveat, "Unidentified cut-off copies may retain part of the selected text.");
  if (!result.auditFinalized) parts.push("Audit finalization is still pending.");
  return { title: "Comment redacted", body: parts.join(" "), tone: "warn" as const };
}

export function commentRedactionActivityStatus(details?: Record<string, unknown> | null) {
  if (details?.fileCleanup === "pending") return "audit pending";
  // Keep historical complete records readable; current actions always have
  // private-chat uncertainty and report incomplete independent of hidden data.
  if (details?.cleanupStatus === "complete") return "covered cleanup complete";
  const visible = visibleCaveats({
    cutoffCheckComplete: typeof details?.cutoffCheckComplete === "boolean" ? details.cutoffCheckComplete : undefined,
    residualMatches: typeof details?.residualMatches === "number" ? details.residualMatches : undefined,
    activeRunCount: typeof details?.activeRunCount === "number" || details?.activeRunCount === null ? details.activeRunCount : undefined,
    oversizedFields: typeof details?.oversizedFields === "number" ? details.oversizedFields : undefined,
    skippedFields: typeof details?.skippedFields === "number" ? details.skippedFields : undefined,
    fileCleanup: details?.fileCleanup,
  });
  return ["cleanup incomplete", ...visible, privateChatCaveat].join("; ");
}
