/**
 * Shared attachment content-type configuration.
 *
 * By default a curated set of image/document/text types are allowed. Set the
 * `PAPERCLIP_ALLOWED_ATTACHMENT_TYPES` environment variable to a
 * comma-separated list of MIME types or wildcard patterns to expand the
 * allowed set for routes that use this allowlist.
 *
 * Examples:
 *   PAPERCLIP_ALLOWED_ATTACHMENT_TYPES=image/*,application/pdf
 *   PAPERCLIP_ALLOWED_ATTACHMENT_TYPES=image/*,application/pdf,text/*
 *
 * Supported pattern syntax:
 *   - Exact types:   "application/pdf"
 *   - Wildcards:     "image/*"  or  "application/vnd.openxmlformats-officedocument.*"
 */

import {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  formatByteSize,
  tooLargeMessage,
} from "@paperclipai/shared";

export const DEFAULT_ALLOWED_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/markdown",
  "text/plain",
  "application/json",
  "text/csv",
  "text/html",
];

export const DEFAULT_ATTACHMENT_CONTENT_TYPE = "application/octet-stream";
export const SVG_CONTENT_TYPE = "image/svg+xml";
export const INLINE_ATTACHMENT_TYPES: readonly string[] = [
  "image/*",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/json",
  "text/csv",
];

/**
 * Parse a comma-separated list of MIME type patterns into a normalised array.
 * Returns the default image-only list when the input is empty or undefined.
 */
export function parseAllowedTypes(raw: string | undefined): string[] {
  if (!raw) return [...DEFAULT_ALLOWED_TYPES];
  const parsed = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return parsed.length > 0 ? parsed : [...DEFAULT_ALLOWED_TYPES];
}

/**
 * Check whether `contentType` matches any entry in `allowedPatterns`.
 *
 * Supports exact matches ("application/pdf") and wildcard / prefix
 * patterns ("image/*", "application/vnd.openxmlformats-officedocument.*").
 */
export function matchesContentType(contentType: string, allowedPatterns: string[]): boolean {
  const ct = contentType.toLowerCase();
  return allowedPatterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.endsWith("/*") || pattern.endsWith(".*")) {
      return ct.startsWith(pattern.slice(0, -1));
    }
    return ct === pattern;
  });
}

export function normalizeContentType(contentType: string | null | undefined): string {
  const normalized = (contentType ?? "").trim().toLowerCase();
  return normalized || DEFAULT_ATTACHMENT_CONTENT_TYPE;
}

export function isInlineAttachmentContentType(contentType: string): boolean {
  return matchesContentType(contentType, [...INLINE_ATTACHMENT_TYPES]);
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * A Content-Disposition value any file name survives. Node refuses a header
 * holding a character above U+00FF (ERR_INVALID_CHAR), and macOS puts a
 * narrow no-break space in every screenshot's name, so `filename` carries an
 * ASCII stand-in and `filename*` the real name in UTF-8 (RFC 6266 and RFC
 * 5987), which browsers prefer when both are present.
 */
export function contentDispositionHeader(disposition: "inline" | "attachment", name: string): string {
  // encodeURIComponent throws on half a surrogate pair.
  const wellFormed = name.replace(LONE_SURROGATE, "\uFFFD");
  // NFKD turns the narrow no-break space into a plain one and splits accents
  // off their letters, so "Résumé" falls back to "Resume", not "R_sum_".
  const fallback =
    wellFormed
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\]/g, "")
      .trim() || "file";
  const encoded = encodeURIComponent(wellFormed).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// ---------- Module-level singletons read once at startup ----------

const allowedPatterns: string[] = parseAllowedTypes(
  process.env.PAPERCLIP_ALLOWED_ATTACHMENT_TYPES,
);

/** Convenience wrapper using the process-level allowed list. */
export function isAllowedContentType(contentType: string): boolean {
  return matchesContentType(contentType, allowedPatterns);
}

export const MAX_ATTACHMENT_BYTES =
  Number(process.env.PAPERCLIP_ATTACHMENT_MAX_BYTES) || DEFAULT_MAX_ATTACHMENT_BYTES;

/**
 * Rejection text for an oversized upload. Callers pass the size that was
 * actually received so the user sees both numbers rather than a bare
 * "too large" that leaves them guessing how far over they were.
 *
 * `actualBytes` is unknown on the multer `LIMIT_FILE_SIZE` path — multer
 * aborts the stream at the ceiling and never counts the rest — so that
 * caller omits it and gets the limit-only wording.
 */
export function attachmentTooLargeMessage(actualBytes?: number): string {
  if (typeof actualBytes === "number") {
    return tooLargeMessage(actualBytes, MAX_ATTACHMENT_BYTES);
  }
  return (
    `File is over the ${formatByteSize(MAX_ATTACHMENT_BYTES)} limit. ` +
    `Compress it or trim it down and try again.`
  );
}

export const formatAttachmentSize = formatByteSize;
