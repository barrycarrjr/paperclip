import { Router } from "express";
import { createReadStream, statSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertInstanceAdmin } from "./authz.js";
import { badRequest, conflict } from "../errors.js";

/**
 * Manifest envelope for an instance snapshot. Returned as the response body
 * on GET /manifest-only, and also serialized into the X-Paperclip-Snapshot-Manifest
 * response header (base64-encoded JSON) on the snapshot streaming endpoint so
 * a client can validate the body against the manifest without re-parsing the dump.
 */
export type SystemSnapshotManifest = {
  /** Snapshot envelope schema version. */
  version: 1;
  /** Stable instance identifier this snapshot was produced from. */
  instanceId: string;
  /** ISO 8601 timestamp at snapshot start. */
  createdAt: string;
  /** UUID minted for this specific snapshot (also embedded in the encrypted body wrapper by callers). */
  snapshotUuid: string;
  /** Approximate row counts per public table at snapshot time. */
  publicTableCounts: Record<string, number>;
  /** Plugin namespaces included in the snapshot (already filtered by includeInBackup flag). */
  pluginNamespaces: {
    pluginKey: string;
    pluginVersion: string;
    namespaceName: string;
    tableCounts: Record<string, number>;
  }[];
  /** Plugin namespaces deliberately EXCLUDED from the snapshot (manifest opt-out). */
  excludedPluginNamespaces: {
    pluginKey: string;
    pluginVersion: string;
    namespaceName: string;
    reason: "manifest-opt-out";
  }[];
  /** Total uncompressed estimate (sum of per-table counts × 1KiB) — best-effort hint. */
  estimatedUncompressedBytes: number;
};

export type ProduceSnapshotResult = {
  manifest: SystemSnapshotManifest;
  /** Filesystem path of the freshly produced gzipped SQL dump. Caller is responsible for streaming + cleanup. */
  bodyFilePath: string;
  bodySizeBytes: number;
};

export type RestoreSnapshotMode = "preview" | "apply";
export type RestoreSnapshotConflictMode = "overwrite" | "skip" | "fail-on-conflict";

export type RestoreSnapshotInput = {
  mode: RestoreSnapshotMode;
  conflictMode: RestoreSnapshotConflictMode;
  /** Filesystem path of the gzipped SQL dump to restore. Caller wrote it to disk first. */
  bodyFilePath: string;
};

export type RestoreSnapshotResult = {
  applied: boolean;
  /** True for mode=preview (no changes made). */
  dryRun: boolean;
  /** Tables touched (best-effort parse from SQL header comments). */
  touchedTables: string[];
  warnings: string[];
};

export type SystemSnapshotService = {
  getManifest(): Promise<SystemSnapshotManifest>;
  produceSnapshot(): Promise<ProduceSnapshotResult>;
  restoreSnapshot(input: RestoreSnapshotInput): Promise<RestoreSnapshotResult>;
  cleanupSnapshotFile(filePath: string): void;
};

const VALID_CONFLICT_MODES = new Set<RestoreSnapshotConflictMode>([
  "overwrite",
  "skip",
  "fail-on-conflict",
]);

function parseConflictMode(raw: unknown): RestoreSnapshotConflictMode {
  if (typeof raw !== "string") return "overwrite";
  const candidate = raw as RestoreSnapshotConflictMode;
  return VALID_CONFLICT_MODES.has(candidate) ? candidate : "overwrite";
}

function parseMode(raw: unknown): RestoreSnapshotMode {
  return raw === "apply" ? "apply" : "preview";
}

/**
 * Express routes for instance-wide snapshot/restore.
 *
 * All routes are gated by `assertInstanceAdmin`. The plugin
 * `backup-tools` is the primary client; operators can also `curl` these
 * directly for ad-hoc dumps.
 */
export function systemSnapshotRoutes(service: SystemSnapshotService) {
  const router = Router();

  // Just the envelope — cheap, no SQL dump.
  router.get("/system/snapshot/manifest-only", async (req, res, next) => {
    try {
      assertInstanceAdmin(req);
      const manifest = await service.getManifest();
      res.json({ manifest });
    } catch (err) {
      next(err);
    }
  });

  // Produce a fresh snapshot and stream it to the response. Manifest goes in
  // the X-Paperclip-Snapshot-Manifest header (base64-encoded JSON) so the
  // body can be straight gzipped SQL — the plugin can then encrypt-and-pipe
  // without parsing.
  router.post("/system/snapshot", async (req, res, next) => {
    let producedFilePath: string | null = null;
    try {
      assertInstanceAdmin(req);
      const result = await service.produceSnapshot();
      producedFilePath = result.bodyFilePath;
      const manifestB64 = Buffer.from(JSON.stringify(result.manifest), "utf8").toString("base64");
      res.setHeader("Content-Type", "application/gzip");
      res.setHeader("X-Paperclip-Snapshot-Manifest", manifestB64);
      res.setHeader("X-Paperclip-Instance-Id", result.manifest.instanceId);
      res.setHeader("X-Paperclip-Snapshot-Created-At", result.manifest.createdAt);
      res.setHeader("X-Paperclip-Snapshot-Uuid", result.manifest.snapshotUuid);
      res.setHeader("Content-Length", String(result.bodySizeBytes));
      const stream = createReadStream(result.bodyFilePath);
      stream.on("error", (err) => {
        if (!res.headersSent) {
          next(err);
        } else {
          res.destroy(err);
        }
      });
      stream.on("close", () => {
        if (producedFilePath) {
          service.cleanupSnapshotFile(producedFilePath);
          producedFilePath = null;
        }
      });
      stream.pipe(res);
    } catch (err) {
      if (producedFilePath) {
        service.cleanupSnapshotFile(producedFilePath);
      }
      next(err);
    }
  });

  // Apply (or preview-validate) a snapshot. Body is the raw gzipped SQL dump.
  // Query: ?mode=preview|apply&conflict=overwrite|skip|fail-on-conflict
  // We spool the request to a tmp file first because runDatabaseRestore
  // expects a file path (psql/javascript engines both stream from disk).
  router.post("/system/snapshot/restore", async (req, res, next) => {
    let stagedFilePath: string | null = null;
    try {
      assertInstanceAdmin(req);
      const mode = parseMode(req.query.mode);
      const conflictMode = parseConflictMode(req.query.conflict);

      // v0.1: only the overwrite conflict mode is wired through. Reject others
      // explicitly so callers don't think their request was honored.
      if (mode === "apply" && conflictMode !== "overwrite") {
        throw badRequest(
          `[ESNAPSHOT_CONFLICT_MODE_UNSUPPORTED] conflict=${conflictMode} not yet supported (v0.1 ships overwrite only)`,
        );
      }

      // Stage the request body to a temp file. Express body-parser is JSON-only;
      // for octet-stream we read req as a stream and write to disk.
      const tmpRoot = join(tmpdir(), "paperclip-snapshot-restore");
      if (!existsSync(tmpRoot)) mkdirSync(tmpRoot, { recursive: true });
      stagedFilePath = join(tmpRoot, `${randomUUID()}.sql.gz`);

      await new Promise<void>((resolve, reject) => {
        const { createWriteStream } = require("node:fs") as typeof import("node:fs");
        const ws = createWriteStream(stagedFilePath!);
        req.on("error", reject);
        ws.on("error", reject);
        ws.on("finish", () => resolve());
        req.pipe(ws);
      });

      const stagedSize = statSync(stagedFilePath).size;
      if (stagedSize === 0) {
        throw badRequest("[ESNAPSHOT_EMPTY_BODY] request body was empty; expected gzipped SQL dump");
      }

      const result = await service.restoreSnapshot({
        mode,
        conflictMode,
        bodyFilePath: stagedFilePath,
      });

      res.json({
        applied: result.applied,
        dryRun: result.dryRun,
        touchedTables: result.touchedTables,
        warnings: result.warnings,
        stagedSizeBytes: stagedSize,
      });
    } catch (err) {
      next(err);
    } finally {
      if (stagedFilePath && existsSync(stagedFilePath)) {
        try {
          unlinkSync(stagedFilePath);
        } catch {
          // best-effort
        }
      }
    }
  });

  return router;
}

/**
 * Build a SystemSnapshotService backed by `runDatabaseBackup` /
 * `runDatabaseRestore` from `@paperclipai/db`, plus a query against the
 * `plugin_database_namespaces` + `plugins` tables to enumerate plugin schemas.
 *
 * `produceConcurrencyLock` is shared with the existing instance-database-backup
 * service so we don't have two backups racing each other on the same Postgres
 * connection pool.
 */
export type SystemSnapshotServiceDeps = {
  connectionString: string;
  /** Where snapshot temp files land. Cleaned up after each request. */
  snapshotTempDir: string;
  instanceId: string;
  /** Returns "true" if a snapshot or backup is already running; the service
   * returns `[ESNAPSHOT_IN_FLIGHT]` rather than racing.  */
  acquireConcurrencyLock(): Promise<() => void>;
  /** Returns the list of plugin namespaces with their includeInBackup flag.
   * The host derives this from the `plugins` + `plugin_database_namespaces`
   * tables and the most recent persisted manifestJson.includeInBackup.
   */
  listPluginNamespaces(): Promise<{
    pluginKey: string;
    pluginVersion: string;
    namespaceName: string;
    includeInBackup: boolean;
  }[]>;
  /** SQL function used to count rows for tables; falls back to 0 on error. */
  countTableRows(schema: string, table: string): Promise<number>;
  /** Lists base tables in a schema. */
  listSchemaTables(schema: string): Promise<string[]>;
};

/**
 * Common error helpers re-exported so the index.ts wiring layer doesn't have
 * to duplicate the [E...] codes.
 */
export const SnapshotErrorCodes = {
  IN_FLIGHT: "ESNAPSHOT_IN_FLIGHT",
  EMPTY_BODY: "ESNAPSHOT_EMPTY_BODY",
  CONFLICT_MODE_UNSUPPORTED: "ESNAPSHOT_CONFLICT_MODE_UNSUPPORTED",
  PRODUCE_FAILED: "ESNAPSHOT_PRODUCE_FAILED",
  RESTORE_FAILED: "ESNAPSHOT_RESTORE_FAILED",
} as const;

// Re-export error helpers for the wiring layer's convenience.
export { conflict };
