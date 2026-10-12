import { createHash } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentApiKeys, agents, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import { forbidden, unauthorized } from "../errors.js";
import { ACCOUNT_PENDING_APPROVAL_CODE, type DeploymentMode } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "./logger.js";
import { boardAuthService } from "../services/board-auth.js";
import { getPortfolioRootCompanyId } from "../services/portfolio-root-cache.js";
import { ensurePersonalCompanyOnce } from "../services/personal-companies.js";
import {
  ACCOUNT_DECLINED_MESSAGE,
  ACCOUNT_PENDING_APPROVAL_MESSAGE,
  loadAccountApprovalStatus,
} from "../services/account-approvals.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Synthetic identity carried in tool-session JWTs. Currently only used by
 * Clippy chat sessions, which mint `sub = clippy-<sessionId>` in
 * services/chat-providers.ts. New tool integrations should reuse this
 * `<tool>-<uuid>` shape rather than inventing a parallel format.
 */
const TOOL_SESSION_SUB_PATTERN = /^clippy-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeJwtPayloadUnverified(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * True when the bearer token was *meant* to be one of our agent JWTs, even if
 * it no longer verifies. Not every bearer token on the wire is an agent
 * credential: the public routine trigger authenticates with its own opaque
 * secret in the same header, and that route verifies it itself. Those must
 * still reach their route, so only tokens carrying our claim shape are
 * treated as failed agent credentials and rejected.
 */
function looksLikeAgentToken(token: string): boolean {
  const payload = decodeJwtPayloadUnverified(token);
  if (!payload) return false;
  return typeof payload.company_id === "string"
    && typeof payload.adapter_type === "string"
    && typeof payload.run_id === "string";
}

function invalidAgentTokenMessage(token: string): string {
  const payload = decodeJwtPayloadUnverified(token);
  if (payload && typeof payload.exp === "number" && payload.exp <= Math.floor(Date.now() / 1000)) {
    return "Expired agent token; obtain fresh credentials and retry";
  }
  return "Agent token did not verify; obtain fresh credentials and retry";
}

/**
 * Populate `actor.isPortfolioRootAgent` / `actor.isPortfolioRootUserAdmin`
 * from already-loaded actor data. The HQ company id is cached in process,
 * so this is essentially free after the first call.
 */
async function annotateHqStatus(req: Request, db: Db): Promise<void> {
  const actor = req.actor;
  // Everyone gets a Personal on first sight. Costs a map lookup once the
  // index knows them, so this is not a query per request.
  if (actor.type === "board" && actor.userId && actor.source !== "local_implicit") {
    await ensurePersonalCompanyOnce(db, actor.userId, actor.userName ?? null);
  }
  await annotatePortfolioRootStatus(actor, db);
}

async function annotatePortfolioRootStatus(actor: Request["actor"], db: Db): Promise<void> {
  if ((actor.type === "agent" || actor.type === "tool_session") && actor.companyId) {
    const rootId = await getPortfolioRootCompanyId(db);
    // A tool session gets HQ's read across companies only when the person it
    // acts for has that themselves, as an HQ owner or admin. A key scoped to
    // HQ is not enough: an HQ viewer, or an instance admin outside HQ, can
    // start a chat there but cannot read the other companies themselves.
    const readsAcross = actor.type === "agent" || actor.person?.isPortfolioRootUserAdmin === true;
    if (rootId && actor.companyId === rootId && readsAcross) {
      actor.isPortfolioRootAgent = true;
    }
  } else if (
    actor.type === "board" &&
    Array.isArray(actor.memberships) &&
    actor.memberships.length > 0
  ) {
    const rootId = await getPortfolioRootCompanyId(db);
    if (rootId) {
      const isAdmin = actor.memberships.some(
        (m) =>
          m.companyId === rootId &&
          m.status === "active" &&
          (m.membershipRole === "owner" || m.membershipRole === "admin"),
      );
      if (isAdmin) actor.isPortfolioRootUserAdmin = true;
    }
  }
}

/**
 * The board actor for a user acting through something other than a browser:
 * the same memberships, admin flag and portfolio-root status a signed-in
 * request from that user gets, so every access rule treats them exactly like
 * a click in the web app. Null when the user no longer exists.
 */
async function boardActorForUser(
  db: Db,
  userId: string,
  source: Request["actor"]["source"],
): Promise<Request["actor"] | null> {
  const access = await boardAuthService(db).resolveBoardAccess(userId);
  if (!access.user) return null;
  // A chat app speaks as its user, so an account an instance admin has not
  // approved gets nothing through one, Clippy included.
  if (access.user.approvalStatus !== "approved") return null;
  const actor: Request["actor"] = {
    type: "board",
    userId,
    userName: access.user.name ?? null,
    userEmail: access.user.email ?? null,
    companyIds: access.companyIds,
    memberships: access.memberships,
    isInstanceAdmin: access.isInstanceAdmin,
    source,
  };
  await annotatePortfolioRootStatus(actor, db);
  return actor;
}

/**
 * The board actor for a user acting through a paired chat app, so a Slack
 * message is treated exactly like a click in the web app.
 */
export async function boardActorForLinkedUser(db: Db, userId: string): Promise<Request["actor"] | null> {
  return boardActorForUser(db, userId, "channel_link");
}

interface ActorMiddlewareOptions {
  deploymentMode: DeploymentMode;
  resolveSession?: (req: Request) => Promise<BetterAuthSessionResult | null>;
}

export function actorMiddleware(db: Db, opts: ActorMiddlewareOptions): RequestHandler {
  const boardAuth = boardAuthService(db);
  return async (req, _res, next) => {
    req.actor =
      opts.deploymentMode === "local_trusted"
        ? {
            type: "board",
            userId: "local-board",
            userName: "Local Board",
            userEmail: null,
            isInstanceAdmin: true,
            source: "local_implicit",
          }
        : { type: "none", source: "none" };

    const runIdHeader = req.header("x-paperclip-run-id");

    const authHeader = req.header("authorization");
    // `Bearer` with nothing after it is malformed credentials, not absent
    // ones. Node trims trailing header whitespace, so matching on "bearer "
    // would send a bare `Bearer` down the no-credentials path and quietly
    // authenticate it as the local board user.
    const hasBearerCredentials = /^bearer(?:\s|$)/i.test(authHeader ?? "");
    if (!hasBearerCredentials) {
      if (opts.deploymentMode === "authenticated" && opts.resolveSession) {
        let session: BetterAuthSessionResult | null = null;
        try {
          session = await opts.resolveSession(req);
        } catch (err) {
          logger.warn(
            { err, method: req.method, url: req.originalUrl },
            "Failed to resolve auth session from request headers",
          );
        }
        if (session?.user?.id) {
          const userId = session.user.id;
          const [roleRow, memberships, approvalStatus] = await Promise.all([
            db
              .select({ id: instanceUserRoles.id })
              .from(instanceUserRoles)
              .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
              .then((rows) => rows[0] ?? null),
            db
              .select({
                companyId: companyMemberships.companyId,
                membershipRole: companyMemberships.membershipRole,
                status: companyMemberships.status,
              })
              .from(companyMemberships)
              .where(
                and(
                  eq(companyMemberships.principalType, "user"),
                  eq(companyMemberships.principalId, userId),
                  eq(companyMemberships.status, "active"),
                ),
              ),
            loadAccountApprovalStatus(db, userId),
          ]);
          if (approvalStatus !== "approved") {
            // Still waiting for an instance admin: signed in, and nothing
            // more. No memberships, no admin role, and no Personal company
            // until approval (services/account-approvals.ts), and the guard
            // after this middleware refuses it almost everywhere. A declined
            // account, or one that no longer exists, stays as nobody, as if
            // it had no session.
            if (approvalStatus === "pending") {
              req.actor = {
                type: "board",
                userId,
                userName: session.user.name ?? null,
                userEmail: session.user.email ?? null,
                companyIds: [],
                memberships: [],
                isInstanceAdmin: false,
                awaitingApproval: true,
                runId: runIdHeader ?? undefined,
                source: "session",
              };
            } else if (runIdHeader) {
              req.actor.runId = runIdHeader;
            }
            next();
            return;
          }
          req.actor = {
            type: "board",
            userId,
            userName: session.user.name ?? null,
            userEmail: session.user.email ?? null,
            companyIds: memberships.map((row) => row.companyId),
            memberships,
            isInstanceAdmin: Boolean(roleRow),
            runId: runIdHeader ?? undefined,
            source: "session",
          };
          await annotateHqStatus(req, db);
          next();
          return;
        }
      }
      if (runIdHeader) req.actor.runId = runIdHeader;
      next();
      return;
    }

    const token = authHeader!.slice("bearer".length).trim();
    if (!token) {
      next(unauthorized("Empty bearer token; provide valid credentials and retry"));
      return;
    }

    const boardKey = await boardAuth.findBoardApiKeyByToken(token);
    if (boardKey) {
      const access = await boardAuth.resolveBoardAccess(boardKey.userId);
      if (access.user) {
        // A key is only as good as its account. One waiting for approval, or
        // declined, is refused outright rather than treated as nobody, so the
        // program holding the key is told why.
        if (access.user.approvalStatus === "pending") {
          next(forbidden(ACCOUNT_PENDING_APPROVAL_MESSAGE, { code: ACCOUNT_PENDING_APPROVAL_CODE }));
          return;
        }
        if (access.user.approvalStatus !== "approved") {
          next(unauthorized(ACCOUNT_DECLINED_MESSAGE));
          return;
        }
        await boardAuth.touchBoardApiKey(boardKey.id);
        req.actor = {
          type: "board",
          userId: boardKey.userId,
          userName: access.user?.name ?? null,
          userEmail: access.user?.email ?? null,
          companyIds: access.companyIds,
          memberships: access.memberships,
          isInstanceAdmin: access.isInstanceAdmin,
          keyId: boardKey.id,
          runId: runIdHeader || undefined,
          source: "board_key",
        };
        await annotateHqStatus(req, db);
        next();
        return;
      }
    }

    const tokenHash = hashToken(token);
    const key = await db
      .select()
      .from(agentApiKeys)
      .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
      .then((rows) => rows[0] ?? null);

    if (!key) {
      const claims = verifyLocalAgentJwt(token);
      if (!claims) {
        // An agent-shaped token that fails verification must fail loudly. Left
        // to fall through it would land on the trusted local-board actor and
        // the agent's writes would be stored under the human's identity.
        if (looksLikeAgentToken(token)) {
          next(unauthorized(invalidAgentTokenMessage(token)));
          return;
        }
        next();
        return;
      }

      // Tool-session JWTs carry a synthetic sub (e.g. `clippy-<sessionId>`)
      // rather than a real agents.id. The driving user is in `user_id` and
      // the company in `company_id`. Authenticate as a `tool_session` actor
      // scoped to that single company, attributing writes to the user.
      if (TOOL_SESSION_SUB_PATTERN.test(claims.sub)) {
        if (!UUID_PATTERN.test(claims.company_id)) {
          next(unauthorized("Tool-session token carries an unusable company; obtain fresh credentials and retry"));
          return;
        }
        const userId = typeof claims.user_id === "string" && claims.user_id.length > 0
          ? claims.user_id
          : undefined;
        // The key acts as the person chatting and may never do more than they
        // can. Their access is read here on every request rather than frozen
        // into the key, so a removed membership or a move to viewer applies to
        // the very next call instead of when the key expires, up to two days on.
        const person = userId ? await boardActorForUser(db, userId, "tool_session_jwt") : null;
        if (!person) {
          next(unauthorized("Tool-session token is not for an existing user; obtain fresh credentials and retry"));
          return;
        }
        req.actor = {
          type: "tool_session",
          userId,
          companyId: claims.company_id,
          toolSessionId: claims.sub,
          runId: runIdHeader || claims.run_id || undefined,
          source: "tool_session_jwt",
          person,
        };
        await annotateHqStatus(req, db);
        next();
        return;
      }

      // Legacy agent JWT path: sub MUST be a UUID since it indexes agents.id
      // (uuid-typed). A non-UUID sub from an unrecognized tool would crash
      // the query with `22P02 invalid input syntax for type uuid`.
      if (!UUID_PATTERN.test(claims.sub)) {
        next(unauthorized("Agent token carries an unusable subject; obtain fresh credentials and retry"));
        return;
      }

      const agentRecord = await db
        .select()
        .from(agents)
        .where(eq(agents.id, claims.sub))
        .then((rows) => rows[0] ?? null);

      if (!agentRecord || agentRecord.companyId !== claims.company_id) {
        next(unauthorized("Agent record is missing or belongs to another company; obtain fresh credentials and retry"));
        return;
      }

      if (agentRecord.status === "terminated") {
        next(unauthorized("Agent is terminated and cannot authenticate"));
        return;
      }

      if (agentRecord.status === "pending_approval") {
        next(unauthorized("Agent is pending approval and cannot authenticate"));
        return;
      }

      req.actor = {
        type: "agent",
        agentId: claims.sub,
        companyId: claims.company_id,
        keyId: undefined,
        runId: runIdHeader || claims.run_id || undefined,
        source: "agent_jwt",
      };
      await annotateHqStatus(req, db);
      next();
      return;
    }

    await db
      .update(agentApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(agentApiKeys.id, key.id));

    const agentRecord = await db
      .select()
      .from(agents)
      .where(eq(agents.id, key.agentId))
      .then((rows) => rows[0] ?? null);

    if (!agentRecord || agentRecord.companyId !== key.companyId) {
      next(unauthorized("Agent record is missing or belongs to another company; obtain fresh credentials and retry"));
      return;
    }

    if (agentRecord.status === "terminated") {
      next(unauthorized("Agent is terminated and cannot authenticate"));
      return;
    }

    if (agentRecord.status === "pending_approval") {
      next(unauthorized("Agent is pending approval and cannot authenticate"));
      return;
    }

    req.actor = {
      type: "agent",
      agentId: key.agentId,
      companyId: key.companyId,
      keyId: key.id,
      runId: runIdHeader || undefined,
      source: "agent_key",
    };

    await annotateHqStatus(req, db);
    next();
  };
}

export function requireBoard(req: Express.Request) {
  return req.actor.type === "board";
}
