import { createHash } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentApiKeys, agents, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import type { DeploymentMode } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "./logger.js";
import { boardAuthService } from "../services/board-auth.js";
import { getPortfolioRootCompanyId } from "../services/portfolio-root-cache.js";

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

/**
 * Populate `actor.isPortfolioRootAgent` / `actor.isPortfolioRootUserAdmin`
 * from already-loaded actor data. The HQ company id is cached in process,
 * so this is essentially free after the first call.
 */
async function annotateHqStatus(req: Request, db: Db): Promise<void> {
  const actor = req.actor;
  if ((actor.type === "agent" || actor.type === "tool_session") && actor.companyId) {
    const rootId = await getPortfolioRootCompanyId(db);
    if (rootId && actor.companyId === rootId) {
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
    if (!authHeader?.toLowerCase().startsWith("bearer ")) {
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
          const [roleRow, memberships] = await Promise.all([
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
          ]);
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

    const token = authHeader.slice("bearer ".length).trim();
    if (!token) {
      next();
      return;
    }

    const boardKey = await boardAuth.findBoardApiKeyByToken(token);
    if (boardKey) {
      const access = await boardAuth.resolveBoardAccess(boardKey.userId);
      if (access.user) {
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
        next();
        return;
      }

      // Tool-session JWTs carry a synthetic sub (e.g. `clippy-<sessionId>`)
      // rather than a real agents.id. The driving user is in `user_id` and
      // the company in `company_id`. Authenticate as a `tool_session` actor
      // scoped to that single company, attributing writes to the user.
      if (TOOL_SESSION_SUB_PATTERN.test(claims.sub)) {
        if (!UUID_PATTERN.test(claims.company_id)) {
          next();
          return;
        }
        const userId = typeof claims.user_id === "string" && claims.user_id.length > 0
          ? claims.user_id
          : undefined;
        req.actor = {
          type: "tool_session",
          userId,
          companyId: claims.company_id,
          toolSessionId: claims.sub,
          runId: runIdHeader || claims.run_id || undefined,
          source: "tool_session_jwt",
        };
        await annotateHqStatus(req, db);
        next();
        return;
      }

      // Legacy agent JWT path: sub MUST be a UUID since it indexes agents.id
      // (uuid-typed). A non-UUID sub from an unrecognized tool would crash
      // the query with `22P02 invalid input syntax for type uuid`.
      if (!UUID_PATTERN.test(claims.sub)) {
        next();
        return;
      }

      const agentRecord = await db
        .select()
        .from(agents)
        .where(eq(agents.id, claims.sub))
        .then((rows) => rows[0] ?? null);

      if (!agentRecord || agentRecord.companyId !== claims.company_id) {
        next();
        return;
      }

      if (agentRecord.status === "terminated" || agentRecord.status === "pending_approval") {
        next();
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

    if (!agentRecord || agentRecord.status === "terminated" || agentRecord.status === "pending_approval") {
      next();
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
