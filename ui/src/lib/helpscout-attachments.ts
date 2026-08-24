import type { HSThread } from "../api/helpScoutBridge";

/** A thread attachment normalized for rendering: every field present. */
export interface ThreadAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

/**
 * Attachments embedded on one Help Scout thread. The raw `_embedded`
 * payload is whatever Help Scout sent, so every field is defended: rows
 * without an id can't be downloaded and are dropped, missing names and
 * types get honest placeholders.
 */
export function threadAttachments(thread: Pick<HSThread, "_embedded">): ThreadAttachment[] {
  const raw = thread._embedded?.attachments ?? [];
  const out: ThreadAttachment[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    if (item.id === undefined || item.id === null || item.id === "") continue;
    out.push({
      id: String(item.id),
      filename:
        typeof item.filename === "string" && item.filename.length > 0
          ? item.filename
          : "attachment",
      mimeType:
        typeof item.mimeType === "string" && item.mimeType.length > 0
          ? item.mimeType
          : "application/octet-stream",
      size: typeof item.size === "number" && Number.isFinite(item.size) ? item.size : 0,
    });
  }
  return out;
}
