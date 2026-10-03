export const LOW_TRUST_QUARANTINED_BODY = "[Content quarantined: pending human review]";

export function isLowTrustQuarantined(metadata: unknown): boolean {
  return false;
}

export function resolveActorSourceTrustForIssue(...args: unknown[]): null {
  return null;
}

export function redactQuarantinedBodyForHigherTrust(body: string, isQuarantined: boolean): string {
  return isQuarantined ? LOW_TRUST_QUARANTINED_BODY : body;
}

export function sanitizeQuarantinedCommentForHigherTrust(comment: unknown): unknown {
  return comment;
}
