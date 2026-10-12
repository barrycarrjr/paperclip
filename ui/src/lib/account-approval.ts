import { ACCOUNT_PENDING_APPROVAL_CODE } from "@paperclipai/shared";
import { ApiError } from "../api/client";

/**
 * Whether a request was refused because the signed-in account is still
 * waiting for an instance admin to approve it, rather than for anything about
 * what it asked. A waiting account is refused nearly every call, so a page
 * that a new account passes through on its way in (the invite page) has to
 * tell this apart from a real failure.
 */
export function isAccountWaitingError(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 403) return false;
  const body = error.body as { code?: unknown } | null | undefined;
  return body?.code === ACCOUNT_PENDING_APPROVAL_CODE;
}

/** The count said as a sentence, for a badge's label and the account menu. */
export function describeWaitingAccounts(count: number): string {
  return count === 1
    ? "1 new account is waiting for approval."
    : `${count} new accounts are waiting for approval.`;
}
