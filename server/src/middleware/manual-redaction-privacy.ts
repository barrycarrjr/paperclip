const manualRedactionPath = /\/issues\/[^/]+\/comments\/[^/]+\/(redact|redact-delegated|redaction-authorizations|redaction-preview)\/?$/i;

/** Redaction input can be any sensitive text, including malformed JSON. Never log it. */
export function isManualRedactionRequest(req: { originalUrl?: string; url?: string }) {
  const pathname = (req.originalUrl ?? req.url ?? "").split(/[?#]/)[0] ?? "";
  // Express keeps backslashes inside ids on its fast path, but normalizes
  // them when parsing a fragment or absolute-form request target.
  return manualRedactionPath.test(pathname) || manualRedactionPath.test(pathname.replace(/\\/g, "/"));
}
