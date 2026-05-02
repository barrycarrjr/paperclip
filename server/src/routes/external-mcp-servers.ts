/**
 * External MCP server CRUD + diagnostics.
 *
 * Board-only routes that let operators register, edit, and probe external
 * Model Context Protocol servers. Tools from these servers become callable
 * by Paperclip agents in the listed `allowedCompanies`.
 *
 * Companion to `routes/plugins.ts` and `routes/secrets.ts`. Mutations go
 * through the activity log.
 */

import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { externalMcpServers } from "@paperclipai/db";
import {
  createExternalMcpServerSchema,
  updateExternalMcpServerSchema,
  type CreateExternalMcpServer,
  type ExternalMcpServerRecord,
  type ExternalMcpTestConnectResult,
} from "@paperclipai/shared";
import type { ExternalMcpServerManager } from "../services/external-mcp-server-manager.js";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import { assertBoard } from "./authz.js";
import { notFound, conflict } from "../errors.js";

const auditLog = logger.child({ service: "external-mcp-servers-audit" });

interface ExternalMcpRouteDeps {
  externalMcpServerManager?: ExternalMcpServerManager;
}

function dbRowToRecord(
  row: typeof externalMcpServers.$inferSelect,
): ExternalMcpServerRecord {
  return {
    id: row.id,
    key: row.key,
    displayName: row.displayName,
    description: row.description,
    transport: row.transport,
    command: row.command,
    args: row.args,
    url: row.url,
    envBindings: row.envBindings ?? {},
    headerBindings: row.headerBindings ?? {},
    allowedCompanies: row.allowedCompanies ?? [],
    allowMutations: row.allowMutations,
    writeAllowList: row.writeAllowList ?? [],
    toolAllowList: row.toolAllowList ?? [],
    toolDenyList: row.toolDenyList ?? [],
    lastError: row.lastError,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function applyDefaultsForCreate(input: CreateExternalMcpServer): typeof externalMcpServers.$inferInsert {
  return {
    key: input.key,
    displayName: input.displayName,
    description: input.description ?? null,
    transport: input.transport,
    command: input.command ?? null,
    args: input.args ?? null,
    url: input.url ?? null,
    envBindings: input.envBindings,
    headerBindings: input.headerBindings,
    allowedCompanies: input.allowedCompanies,
    allowMutations: input.allowMutations,
    writeAllowList: input.writeAllowList,
    toolAllowList: input.toolAllowList,
    toolDenyList: input.toolDenyList,
  };
}

export function externalMcpServerRoutes(db: Db, deps: ExternalMcpRouteDeps = {}) {
  const router = Router();
  const manager = deps.externalMcpServerManager;

  router.get("/external-mcp-servers", async (req, res) => {
    assertBoard(req);
    const rows = await db.select().from(externalMcpServers);
    res.json(rows.map(dbRowToRecord));
  });

  router.get("/external-mcp-servers/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const rows = await db.select().from(externalMcpServers).where(eq(externalMcpServers.id, id));
    if (rows.length === 0) throw notFound("MCP server not found");
    res.json(dbRowToRecord(rows[0]));
  });

  router.post(
    "/external-mcp-servers",
    validate(createExternalMcpServerSchema),
    async (req, res) => {
      assertBoard(req);
      const body = req.body as CreateExternalMcpServer;

      const existing = await db
        .select()
        .from(externalMcpServers)
        .where(eq(externalMcpServers.key, body.key));
      if (existing.length > 0) {
        throw conflict(`MCP server with key "${body.key}" already exists`);
      }

      const insertValue = applyDefaultsForCreate(body);
      insertValue.createdByUserId = req.actor.userId ?? "board";

      const inserted = await db
        .insert(externalMcpServers)
        .values(insertValue)
        .returning();
      const record = dbRowToRecord(inserted[0]);

      auditLog.info(
        {
          action: "external_mcp_server.created",
          actor: req.actor.userId ?? "board",
          serverId: record.id,
          serverKey: record.key,
          transport: record.transport,
          allowedCompanies: record.allowedCompanies,
        },
        "external mcp server created",
      );

      res.status(201).json(record);
    },
  );

  router.patch(
    "/external-mcp-servers/:id",
    validate(updateExternalMcpServerSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const existingRows = await db
        .select()
        .from(externalMcpServers)
        .where(eq(externalMcpServers.id, id));
      if (existingRows.length === 0) throw notFound("MCP server not found");

      const patch = req.body as Partial<CreateExternalMcpServer>;

      if (patch.key !== undefined && patch.key !== existingRows[0].key) {
        const dup = await db
          .select()
          .from(externalMcpServers)
          .where(eq(externalMcpServers.key, patch.key));
        if (dup.length > 0) throw conflict(`MCP server with key "${patch.key}" already exists`);
      }

      const updateValue: Partial<typeof externalMcpServers.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (patch.key !== undefined) updateValue.key = patch.key;
      if (patch.displayName !== undefined) updateValue.displayName = patch.displayName;
      if (patch.description !== undefined) updateValue.description = patch.description;
      if (patch.transport !== undefined) updateValue.transport = patch.transport;
      if (patch.command !== undefined) updateValue.command = patch.command;
      if (patch.args !== undefined) updateValue.args = patch.args;
      if (patch.url !== undefined) updateValue.url = patch.url;
      if (patch.envBindings !== undefined) updateValue.envBindings = patch.envBindings;
      if (patch.headerBindings !== undefined) updateValue.headerBindings = patch.headerBindings;
      if (patch.allowedCompanies !== undefined) updateValue.allowedCompanies = patch.allowedCompanies;
      if (patch.allowMutations !== undefined) updateValue.allowMutations = patch.allowMutations;
      if (patch.writeAllowList !== undefined) updateValue.writeAllowList = patch.writeAllowList;
      if (patch.toolAllowList !== undefined) updateValue.toolAllowList = patch.toolAllowList;
      if (patch.toolDenyList !== undefined) updateValue.toolDenyList = patch.toolDenyList;

      const updated = await db
        .update(externalMcpServers)
        .set(updateValue)
        .where(eq(externalMcpServers.id, id))
        .returning();

      // Tear down any pooled clients so the next call picks up the new config.
      if (manager) await manager.evict(id);

      const record = dbRowToRecord(updated[0]);
      auditLog.info(
        {
          action: "external_mcp_server.updated",
          actor: req.actor.userId ?? "board",
          serverId: record.id,
          serverKey: record.key,
          changedFields: Object.keys(updateValue).filter((k) => k !== "updatedAt"),
        },
        "external mcp server updated",
      );

      res.json(record);
    },
  );

  router.delete("/external-mcp-servers/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existingRows = await db
      .select()
      .from(externalMcpServers)
      .where(eq(externalMcpServers.id, id));
    if (existingRows.length === 0) throw notFound("MCP server not found");

    if (manager) await manager.evict(id);

    await db.delete(externalMcpServers).where(eq(externalMcpServers.id, id));

    auditLog.info(
      {
        action: "external_mcp_server.deleted",
        actor: req.actor.userId ?? "board",
        serverId: id,
        serverKey: existingRows[0].key,
      },
      "external mcp server deleted",
    );

    res.json({ ok: true });
  });

  router.post("/external-mcp-servers/:id/test-connect", async (req, res) => {
    assertBoard(req);
    if (!manager) {
      res.status(501).json({ error: "External MCP support is not enabled" });
      return;
    }
    const id = req.params.id as string;

    const companyId = (req.body?.companyId as string | undefined) ?? null;
    if (!companyId) {
      res.status(400).json({
        error:
          "companyId is required — pick one of the server's allowedCompanies to probe with its bound secrets",
      });
      return;
    }

    let result: ExternalMcpTestConnectResult;
    try {
      const tools = await manager.listTools(id, companyId);
      result = {
        ok: true,
        toolCount: tools.length,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parametersSchema: t.parametersSchema,
        })),
        error: null,
      };
      await db
        .update(externalMcpServers)
        .set({ lastError: null, updatedAt: new Date() })
        .where(eq(externalMcpServers.id, id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = {
        ok: false,
        toolCount: 0,
        tools: [],
        error: message,
      };
      await db
        .update(externalMcpServers)
        .set({ lastError: message, updatedAt: new Date() })
        .where(eq(externalMcpServers.id, id));
    } finally {
      // Always evict so the next call rebuilds with the latest config.
      if (manager) await manager.evict(id, companyId);
    }

    res.json(result);
  });

  return router;
}
