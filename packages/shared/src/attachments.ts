/**
 * Attachment size limits, shared by the server (which enforces them) and the
 * UI (which pre-checks so the user gets feedback without a round-trip).
 *
 * Both sides import the same default so the client can't drift into telling
 * the user a limit the server doesn't actually apply. An operator can still
 * override the server side with `PAPERCLIP_ATTACHMENT_MAX_BYTES`; the client
 * check is only a preflight, and the server stays the authority.
 */

/**
 * Default ceiling for a single uploaded file.
 *
 * 100 MB rather than the original 10 MB: a few minutes of 1080p screen
 * capture is ~20 MB, and "here is a recording of the problem" is the single
 * most useful thing a user can send. A 10 MB cap refused that by default.
 */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/**
 * Human-readable byte size for error messages — "19.6 MB", not "20551581".
 * Error text that quotes raw byte counts makes the user do arithmetic to
 * find out whether their file is close to the limit or nowhere near it.
 */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * The message shown when a file is rejected for size. States both numbers —
 * what was sent and what is allowed — because "too large" on its own doesn't
 * tell the user whether to compress a little or give up.
 */
export function tooLargeMessage(actualBytes: number, limitBytes: number): string {
  return (
    `File is ${formatByteSize(actualBytes)}, which is over the ` +
    `${formatByteSize(limitBytes)} limit. Compress it or trim it down and try again.`
  );
}
