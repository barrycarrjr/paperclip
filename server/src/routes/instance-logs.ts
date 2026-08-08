import { Router } from "express";
import { SERVER_LOG_LEVELS, type ServerLogLevel } from "@paperclipai/shared";
import { resolveServerLogDir } from "../middleware/log-file-target.js";
import { MAX_LIMIT, readServerLogTail } from "../services/server-log-reader.js";
import { assertInstanceAdmin } from "./authz.js";

function parseLevel(raw: unknown): ServerLogLevel | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  return (SERVER_LOG_LEVELS as readonly string[]).includes(value)
    ? (value as ServerLogLevel)
    : undefined;
}

function parsePositiveInt(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function instanceLogsRoutes() {
  const router = Router();

  /**
   * GET /api/instance/logs
   *
   * The tail of the server's own rolling log.
   *
   * Instance admins only, and deliberately stricter than the settings reads
   * next door which any org member can make. A server log is not a setting: it
   * carries request paths, identifiers, and - on a 4xx or 5xx - the request
   * body that failed. The reader redacts anything shaped like a credential
   * before it leaves the process, but the gate is the first line of that
   * defence and the redaction is the second.
   *
   * Query params:
   * - `limit`: entries to return, 1 to 1000 (default 200)
   * - `level`: lowest level to include; `warn` returns warn, error and fatal
   * - `search`: case-insensitive substring over message, service and detail
   * - `afterTimeMs`: only entries strictly newer than this
   * - `deep`: search further back than the tail, at real cost. Never set by
   *   the auto-refresh: a widening scan on a repeating timer is what turns one
   *   ordinary search into tens of megabytes read every couple of seconds.
   *
   * Entries come back oldest first, so the newest line is the last one.
   */
  router.get("/instance/logs", async (req, res) => {
    assertInstanceAdmin(req);

    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const page = await readServerLogTail(resolveServerLogDir(), {
      limit: Math.min(parsePositiveInt(req.query.limit) ?? 200, MAX_LIMIT),
      minLevel: parseLevel(req.query.level),
      search,
      afterTimeMs: parsePositiveInt(req.query.afterTimeMs),
      deep: req.query.deep === "1" || req.query.deep === "true",
    });

    res.json(page);
  });

  return router;
}
