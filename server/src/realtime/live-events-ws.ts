import { createHash } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import { and, eq, isNull } from "drizzle-orm";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { agentApiKeys, agents, companies, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import type { DeploymentMode, LiveEvent } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "../middleware/logger.js";
import { hasActorCompanyAccess } from "../routes/authz.js";
import { isPersonalCompany } from "../services/personal-companies.js";
import { getPortfolioRootCompanyId } from "../services/portfolio-root-cache.js";
import {
  getAllBufferedEventsSince,
  getBufferedEventsSince,
  getLatestLiveEventId,
  LIVE_EVENTS_BOOT_ID,
  subscribeAllCompanyLiveEvents,
  subscribeCompanyLiveEvents,
} from "../services/live-events.js";

interface WsSocket {
  readyState: number;
  ping(): void;
  send(data: string): void;
  terminate(): void;
  close(code?: number, reason?: string): void;
  on(event: "pong", listener: () => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

interface WsServer {
  clients: Set<WsSocket>;
  on(event: "connection", listener: (socket: WsSocket, req: IncomingMessage) => void): void;
  on(event: "close", listener: () => void): void;
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (ws: WsSocket) => void,
  ): void;
  emit(event: "connection", ws: WsSocket, req: IncomingMessage): boolean;
}

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require("ws") as {
  WebSocket: { OPEN: number };
  WebSocketServer: new (opts: { noServer: boolean }) => WsServer;
};

interface UpgradeContext {
  companyId: string;
  /** "company" = one company's events; "portfolio" = every company (HQ only). */
  scope: "company" | "portfolio";
  actorType: "board" | "agent";
  actorId: string;
  /**
   * Who is connected, in the shape the company access check takes. Only the
   * identity is filled in (the user, or the agent and its company): that is
   * all the Personal company rule reads, and it is the one rule each event is
   * checked against once the feed is open.
   */
  actor: Request["actor"];
  /** Replay cursor from the client, valid only when replayBootId matches. */
  replaySinceId: number | null;
  replayBootId: string | null;
}

interface IncomingMessageWithContext extends IncomingMessage {
  paperclipUpgradeContext?: UpgradeContext;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function rejectUpgrade(socket: Duplex, statusLine: string, message: string) {
  const safe = message.replace(/[\r\n]+/g, " ").trim();
  socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${safe}`);
  socket.destroy();
}

function parseLiveEventsPath(
  pathname: string,
): { companyId: string; scope: "company" | "portfolio" } | null {
  const match = pathname.match(/^\/api\/companies\/([^/]+)\/(events|portfolio-events)\/ws$/);
  if (!match) return null;

  try {
    const companyId = decodeURIComponent(match[1] ?? "");
    return { companyId, scope: match[2] === "portfolio-events" ? "portfolio" : "company" };
  } catch {
    return null;
  }
}

function parseBearerToken(rawAuth: string | string[] | undefined) {
  const auth = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
  if (!auth) return null;
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const token = auth.slice("bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function headersFromIncomingMessage(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(req.headers)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
      continue;
    }
    headers.set(key, raw);
  }
  return headers;
}

function parseReplayParams(url: URL): { replaySinceId: number | null; replayBootId: string | null } {
  const sinceRaw = url.searchParams.get("since");
  const since = sinceRaw != null ? Number(sinceRaw) : NaN;
  return {
    replaySinceId: Number.isFinite(since) && since >= 0 ? since : null,
    replayBootId: url.searchParams.get("boot")?.trim() || null,
  };
}

/**
 * Whether `actor` may receive `companyId`'s events.
 *
 * Someone's Personal company is theirs alone: not an HQ agent's, not an HQ
 * admin's, not an instance administrator's. The company access check is where
 * that rule is written, and for a Personal company it decides on that rule
 * alone, so it is asked here rather than the rule being copied. Any other
 * company was settled when the feed was opened.
 */
function mayReceiveCompanyEvents(actor: Request["actor"], companyId: string): boolean {
  return !isPersonalCompany(companyId) || hasActorCompanyAccess(actor, companyId, "read");
}

async function authorizeUpgrade(
  db: Db,
  req: IncomingMessage,
  target: { companyId: string; scope: "company" | "portfolio" },
  url: URL,
  opts: {
    deploymentMode: DeploymentMode;
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  },
): Promise<UpgradeContext | null> {
  const { companyId, scope } = target;
  const replay = parseReplayParams(url);
  const queryToken = url.searchParams.get("token")?.trim() ?? "";
  const authToken = parseBearerToken(req.headers.authorization);
  const token = authToken ?? (queryToken.length > 0 ? queryToken : null);

  // The portfolio feed only hangs off the portfolio-root company, mirroring
  // the REST portfolio endpoints' guard.
  if (scope === "portfolio") {
    const company = await db
      .select({ isPortfolioRoot: companies.isPortfolioRoot })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company?.isPortfolioRoot) return null;
  }

  // Browser board context has no bearer token in local_trusted and authenticated modes.
  if (!token) {
    if (opts.deploymentMode === "local_trusted") {
      return {
        companyId,
        scope,
        actorType: "board",
        actorId: "board",
        // The actor the REST middleware uses for a local_trusted install.
        actor: { type: "board", userId: "local-board", source: "local_implicit" },
        ...replay,
      };
    }

    if (opts.deploymentMode !== "authenticated" || !opts.resolveSessionFromHeaders) {
      return null;
    }

    const session = await opts.resolveSessionFromHeaders(headersFromIncomingMessage(req));
    const userId = session?.user?.id;
    if (!userId) return null;

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

    const actor: Request["actor"] = { type: "board", userId, source: "session" };

    const hqCompanyId = await getPortfolioRootCompanyId(db);
    const isHqAdmin =
      hqCompanyId != null &&
      memberships.some(
        (row) =>
          row.companyId === hqCompanyId &&
          (row.membershipRole === "owner" || row.membershipRole === "admin"),
      );

    // Either feed opens only to someone who could read that company over
    // REST, so the company access check decides, given this user's seats: a
    // seat in the company, or HQ owner or admin, and someone's Personal only
    // for its owner. Being an instance admin is not a seat.
    const reader: Request["actor"] = {
      ...actor,
      companyIds: memberships.map((row) => row.companyId),
      isPortfolioRootUserAdmin: isHqAdmin,
    };
    if (!hasActorCompanyAccess(reader, companyId, "read")) return null;

    // The portfolio feed also needs what the REST portfolio routes ask on top
    // of reading HQ: an instance admin, or HQ owner or admin.
    if (scope === "portfolio" && !roleRow && !isHqAdmin) return null;

    return {
      companyId,
      scope,
      actorType: "board",
      actorId: userId,
      actor,
      ...replay,
    };
  }

  const tokenHash = hashToken(token);
  const key = await db
    .select()
    .from(agentApiKeys)
    .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
    .then((rows) => rows[0] ?? null);

  // Agent keys must belong to the target company; for the portfolio feed
  // that means an HQ agent key (companyId is the portfolio root here).
  if (!key || key.companyId !== companyId) {
    return null;
  }

  // An unrevoked key for a terminated agent must not keep a live feed;
  // mirrors the REST actor middleware's status rejection.
  const agentRecord = await db
    .select({ status: agents.status })
    .from(agents)
    .where(eq(agents.id, key.agentId))
    .then((rows) => rows[0] ?? null);
  if (
    !agentRecord ||
    agentRecord.status === "terminated" ||
    agentRecord.status === "pending_approval"
  ) {
    return null;
  }

  await db
    .update(agentApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(agentApiKeys.id, key.id));

  return {
    companyId,
    scope,
    actorType: "agent",
    actorId: key.agentId,
    actor: { type: "agent", agentId: key.agentId, companyId: key.companyId, source: "agent_key" },
    ...replay,
  };
}

export function setupLiveEventsWebSocketServer(
  server: HttpServer,
  db: Db,
  opts: {
    deploymentMode: DeploymentMode;
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  },
) {
  const wss = new WebSocketServer({ noServer: true });
  const cleanupByClient = new Map<WsSocket, () => void>();
  const aliveByClient = new Map<WsSocket, boolean>();

  const pingInterval = setInterval(() => {
    for (const socket of wss.clients) {
      if (!aliveByClient.get(socket)) {
        socket.terminate();
        continue;
      }
      aliveByClient.set(socket, false);
      socket.ping();
    }
  }, 30000);

  wss.on("connection", (socket: WsSocket, req: IncomingMessage) => {
    const context = (req as IncomingMessageWithContext).paperclipUpgradeContext;
    if (!context) {
      socket.close(1008, "missing context");
      return;
    }

    const deliver = (event: unknown) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(event));
    };

    // Every company event goes out through here, live or replayed, on either
    // feed. The portfolio feed hears every company, Personal ones included,
    // so this is what keeps someone's Personal away from everyone else.
    const mayReceive = (companyId: string) => mayReceiveCompanyEvents(context.actor, companyId);
    const deliverEvent = (event: LiveEvent) => {
      if (mayReceive(event.companyId)) deliver(event);
    };

    // Hello first: carries the boot id so the client can tell whether its
    // replay cursor is still meaningful (event ids reset every boot).
    deliver({
      kind: "hello",
      bootId: LIVE_EVENTS_BOOT_ID,
      latestEventId: getLatestLiveEventId(),
      scope: context.scope,
    });

    // Replay what the client missed, but only when the cursor is from THIS
    // boot. A cursor the buffer can't bridge gets an honest resync signal
    // (the client invalidates everything) instead of silent loss.
    if (context.replaySinceId != null && context.replayBootId === LIVE_EVENTS_BOOT_ID) {
      const replay =
        context.scope === "portfolio"
          ? getAllBufferedEventsSince(context.replaySinceId, mayReceive)
          : getBufferedEventsSince(context.companyId, context.replaySinceId);
      if (!replay.bridged) {
        deliver({ kind: "resync" });
      } else {
        for (const event of replay.events) deliverEvent(event);
      }
    }

    const unsubscribe =
      context.scope === "portfolio"
        ? subscribeAllCompanyLiveEvents(deliverEvent)
        : subscribeCompanyLiveEvents(context.companyId, deliverEvent);

    cleanupByClient.set(socket, unsubscribe);
    aliveByClient.set(socket, true);

    socket.on("pong", () => {
      aliveByClient.set(socket, true);
    });

    socket.on("close", () => {
      const cleanup = cleanupByClient.get(socket);
      if (cleanup) cleanup();
      cleanupByClient.delete(socket);
      aliveByClient.delete(socket);
    });

    socket.on("error", (err: Error) => {
      logger.warn({ err, companyId: context.companyId }, "live websocket client error");
    });
  });

  wss.on("close", () => {
    clearInterval(pingInterval);
  });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url) {
      rejectUpgrade(socket, "400 Bad Request", "missing url");
      return;
    }

    const url = new URL(req.url, "http://localhost");
    const target = parseLiveEventsPath(url.pathname);
    if (!target) {
      socket.destroy();
      return;
    }

    void authorizeUpgrade(db, req, target, url, {
      deploymentMode: opts.deploymentMode,
      resolveSessionFromHeaders: opts.resolveSessionFromHeaders,
    })
      .then((context) => {
        if (!context) {
          rejectUpgrade(socket, "403 Forbidden", "forbidden");
          return;
        }

        const reqWithContext = req as IncomingMessageWithContext;
        reqWithContext.paperclipUpgradeContext = context;

        wss.handleUpgrade(req, socket, head, (ws: WsSocket) => {
          wss.emit("connection", ws, reqWithContext);
        });
      })
      .catch((err) => {
        logger.error({ err, path: req.url }, "failed websocket upgrade authorization");
        rejectUpgrade(socket, "500 Internal Server Error", "upgrade failed");
      });
  });

  return wss;
}
