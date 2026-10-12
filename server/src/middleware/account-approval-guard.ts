import type { RequestHandler } from "express";
import { ACCOUNT_PENDING_APPROVAL_CODE } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { ACCOUNT_PENDING_APPROVAL_MESSAGE } from "../services/account-approvals.js";

/**
 * The calls an account still waiting for approval may make: what the waiting
 * screen, the invite page and the board-claim page need, and nothing more.
 *
 * Accepting an invite is how a waiting account asks to join a company, and an
 * instance admin's invite approves it too. Claiming the board is how the
 * first account on an instance becomes its admin. Signing in and signing up
 * are open to anyone, so they stay open here.
 */
const OPEN_TO_WAITING_ACCOUNTS: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "GET", path: /^\/api\/auth\/get-session$/ },
  { method: "POST", path: /^\/api\/auth\/sign-out$/ },
  { method: "POST", path: /^\/api\/auth\/sign-in\/[^/]+$/ },
  { method: "POST", path: /^\/api\/auth\/sign-up\/[^/]+$/ },
  { method: "GET", path: /^\/api\/health$/ },
  { method: "GET", path: /^\/api\/invites\/[^/]+$/ },
  { method: "GET", path: /^\/api\/invites\/[^/]+\/logo$/ },
  { method: "POST", path: /^\/api\/invites\/[^/]+\/accept$/ },
  { method: "GET", path: /^\/api\/board-claim\/[^/]+$/ },
  { method: "POST", path: /^\/api\/board-claim\/[^/]+\/claim$/ },
];

export function isOpenToWaitingAccount(method: string, path: string): boolean {
  const normalizedMethod = method.toUpperCase();
  return OPEN_TO_WAITING_ACCOUNTS.some(
    (entry) => entry.method === normalizedMethod && entry.path.test(path),
  );
}

/** The server's API: everything under /api, and the agent reference pages under /llms. */
function isApiPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower === "/api" || lower.startsWith("/api/") || lower === "/llms" || lower.startsWith("/llms/");
}

/**
 * Refuses an account an instance admin has not approved yet, everywhere but
 * the calls above. Mounted straight after the actor middleware, so it runs
 * before every route, the sign-in library's own included.
 *
 * Built as a list of what is open rather than of what is closed, so a route
 * added later is closed to a waiting account without anyone remembering to
 * close it. Outside the API, which is the app's own pages and files, the
 * account goes on as nobody at all: those do not depend on who asks, and a
 * route there that did check would see someone signed out, never a member.
 *
 * Three ways in do not come through here and are checked where they start: a
 * board API key and a chat app paired to the account (Clippy over Slack) in
 * middleware/auth.ts, and the live feeds in realtime/live-events-ws.ts.
 */
export function accountApprovalGuard(): RequestHandler {
  return (req, _res, next) => {
    if (!req.actor.awaitingApproval) {
      next();
      return;
    }
    if (isOpenToWaitingAccount(req.method, req.path)) {
      next();
      return;
    }
    if (isApiPath(req.path)) {
      next(forbidden(ACCOUNT_PENDING_APPROVAL_MESSAGE, { code: ACCOUNT_PENDING_APPROVAL_CODE }));
      return;
    }
    req.actor = { type: "none", source: "none" };
    next();
  };
}
