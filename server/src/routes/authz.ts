import type { Request } from "express";
import { forbidden, unauthorized } from "../errors.js";

export type AccessMode = "read" | "write";

export function assertAuthenticated(req: Request) {
  if (req.actor.type === "none") {
    throw unauthorized();
  }
}

/**
 * True for actors that represent a human user driving the system —
 * either signed-in via the board UI (`board`) or via a tool session
 * (`tool_session`, e.g. Clippy) acting on the user's behalf. Use at
 * authorization sites that previously gated on `actor.type === "board"`
 * so tool sessions inherit the same affordances within their JWT's
 * company.
 */
export function isUserDrivenActor(req: Request): boolean {
  return req.actor.type === "board" || req.actor.type === "tool_session";
}

export function assertBoard(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
}

export function hasBoardOrgAccess(req: Request) {
  if (req.actor.type !== "board") {
    return false;
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return true;
  }
  return Array.isArray(req.actor.companyIds) && req.actor.companyIds.length > 0;
}

export function assertBoardOrgAccess(req: Request) {
  assertBoard(req);
  if (hasBoardOrgAccess(req)) {
    return;
  }
  throw forbidden("Company membership or instance admin access required");
}

export function assertInstanceAdmin(req: Request) {
  assertBoard(req);
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

export function assertCompanyAccess(
  req: Request,
  companyId: string,
  mode: AccessMode = "write",
) {
  assertAuthenticated(req);
  if (req.actor.type === "agent" && req.actor.companyId !== companyId) {
    if (mode === "read" && req.actor.isPortfolioRootAgent) {
      return;
    }
    throw forbidden("Agent key cannot access another company");
  }
  if (req.actor.type === "tool_session" && req.actor.companyId !== companyId) {
    if (mode === "read" && req.actor.isPortfolioRootAgent) {
      return;
    }
    throw forbidden("Tool session cannot access another company");
  }
  if (req.actor.type === "board" && req.actor.source !== "local_implicit") {
    const allowedCompanies = req.actor.companyIds ?? [];
    if (!allowedCompanies.includes(companyId)) {
      if (mode === "read" && req.actor.isPortfolioRootUserAdmin) {
        return;
      }
      throw forbidden("User does not have access to this company");
    }
    const method = typeof req.method === "string" ? req.method.toUpperCase() : "GET";
    const isSafeMethod = ["GET", "HEAD", "OPTIONS"].includes(method);
    if (!isSafeMethod && !req.actor.isInstanceAdmin && Array.isArray(req.actor.memberships)) {
      const membership = req.actor.memberships.find((item) => item.companyId === companyId);
      if (!membership || membership.status !== "active") {
        throw forbidden("User does not have active company access");
      }
      if (membership.membershipRole === "viewer") {
        throw forbidden("Viewer access is read-only");
      }
    }
  }
}

export function getActorInfo(req: Request) {
  assertAuthenticated(req);
  if (req.actor.type === "agent") {
    return {
      actorType: "agent" as const,
      actorId: req.actor.agentId ?? "unknown-agent",
      agentId: req.actor.agentId ?? null,
      runId: req.actor.runId ?? null,
    };
  }

  // Tool sessions act on behalf of the driving user. Audit as the user so
  // writes are attributable to a real `users.id` foreign key — there is no
  // agents row to point at, and the synthetic toolSessionId is not a key
  // into any audit-eligible table.
  //
  // runId is intentionally null: the JWT's run_id is the chat session's
  // ephemeral run id, not a `heartbeat_runs.id`, and `activity_log.run_id`
  // has an FK to that table. Pretending the chat run is a heartbeat run
  // would 23503 every audited write.
  if (req.actor.type === "tool_session") {
    return {
      actorType: "user" as const,
      actorId: req.actor.userId ?? "tool_session",
      agentId: null,
      runId: null,
    };
  }

  return {
    actorType: "user" as const,
    actorId: req.actor.userId ?? "board",
    agentId: null,
    runId: req.actor.runId ?? null,
  };
}
