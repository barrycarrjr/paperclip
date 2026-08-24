export interface ComposeDraft {
  to: string;
  subject: string;
  body: string;
  /** False while picked files are still being read into base64. Blocks send
   *  so a half-read attachment can't be silently dropped from the message.
   *  Omitted means there are no attachments in play. */
  attachmentsReady?: boolean;
}

/**
 * Deliberately loose address check — enough to catch a typo or an empty field
 * before we hand it to Help Scout, without trying to out-clever RFC 5322. Help
 * Scout is the real authority; this exists so the Send button can be disabled
 * rather than firing a request that comes back as a bare 400.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True when the compose dialog has everything a new conversation needs. */
export function isComposeReady(draft: ComposeDraft): boolean {
  return (
    EMAIL.test(draft.to.trim()) &&
    draft.subject.trim().length > 0 &&
    draft.body.trim().length > 0 &&
    (draft.attachmentsReady ?? true)
  );
}
