import { tooLargeMessage } from "@paperclipai/shared";

/**
 * Attachment logic shared by the mail composers and the received-attachment
 * chip lists (IMAP and Help Scout). Everything here is pure so it can be
 * tested without a DOM; the FileReader / object-URL glue lives with the
 * components in `components/attachments/`.
 */

/** Per-attachment ceiling the email-tools plugin enforces (decoded bytes). */
export const EMAIL_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/** Per-attachment ceiling the help-scout plugin enforces (decoded bytes). */
export const HELPSCOUT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export type PendingAttachmentStatus = "reading" | "ready" | "error";

/** One file the operator has picked for an outgoing message. */
export interface PendingAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  status: PendingAttachmentStatus;
  contentBase64?: string;
  error?: string;
}

let pendingAttachmentCounter = 0;

/**
 * Chip entry for a freshly picked file. Files over the limit come back as an
 * error chip straight away (the message names both sizes), so the operator
 * finds out before any reading or sending happens.
 */
export function createPendingAttachment(
  file: { name: string; type: string; size: number },
  maxBytes: number,
): PendingAttachment {
  pendingAttachmentCounter += 1;
  const base = {
    id: `${file.name}:${file.size}:${pendingAttachmentCounter}`,
    name: file.name,
    mime: file.type || "application/octet-stream",
    size: file.size,
  };
  if (file.size > maxBytes) {
    return { ...base, status: "error", error: tooLargeMessage(file.size, maxBytes) };
  }
  return { ...base, status: "reading" };
}

export function resolvePendingAttachment(
  list: PendingAttachment[],
  id: string,
  contentBase64: string,
): PendingAttachment[] {
  return list.map((item) =>
    item.id === id && item.status === "reading"
      ? { ...item, status: "ready", contentBase64 }
      : item,
  );
}

export function failPendingAttachment(
  list: PendingAttachment[],
  id: string,
  error: string,
): PendingAttachment[] {
  return list.map((item) =>
    item.id === id && item.status === "reading" ? { ...item, status: "error", error } : item,
  );
}

export function removePendingAttachment(
  list: PendingAttachment[],
  id: string,
): PendingAttachment[] {
  return list.filter((item) => item.id !== id);
}

/** False while any picked file is still being read, so send stays disabled. */
export function allAttachmentsReady(list: PendingAttachment[]): boolean {
  return list.every((item) => item.status !== "reading");
}

/** Send-shape for the email-tools actions (send-reply / send-new). */
export function toEmailSendAttachments(
  list: PendingAttachment[],
): Array<{ name: string; mime?: string; contentBase64: string }> {
  return list
    .filter((item) => item.status === "ready" && item.contentBase64 !== undefined)
    .map((item) => ({ name: item.name, mime: item.mime, contentBase64: item.contentBase64! }));
}

/** Send-shape for the help-scout actions (send-reply / create-conversation). */
export function toHelpScoutSendAttachments(
  list: PendingAttachment[],
): Array<{ fileName: string; mimeType: string; contentBase64: string }> {
  return list
    .filter((item) => item.status === "ready" && item.contentBase64 !== undefined)
    .map((item) => ({
      fileName: item.name,
      mimeType: item.mime,
      contentBase64: item.contentBase64!,
    }));
}

/**
 * Received attachments worth listing. Inline ones are images the HTML body
 * already shows (cid references); a chip for them would just duplicate the
 * body, so they are hidden. Older plugin builds don't send the flag, in which
 * case everything is listed.
 */
export function visibleEmailAttachments<T extends { inline?: boolean }>(list: T[]): T[] {
  return list.filter((item) => item.inline !== true);
}

/** The base64 payload of a data: URL, as FileReader.readAsDataURL produces. */
export function dataUrlToBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma === -1) {
    throw new Error("Not a data URL");
  }
  return dataUrl.slice(comma + 1);
}

/** Decode a base64 payload into a Blob carrying the right MIME type. */
export function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime || "application/octet-stream" });
}
