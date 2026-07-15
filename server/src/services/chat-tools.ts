import { randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { z, type ZodTypeAny } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  companyMemberships,
  issueComments,
  issues,
} from "@paperclipai/db";
import type { CreateCalendarEvent } from "@paperclipai/shared";
import { badRequest, forbidden, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { calendarService } from "./calendar.js";
import { civilToUtc, utcToCivilParts } from "./cron.js";
import type { PluginToolDispatcher } from "./plugin-tool-dispatcher.js";
import { portfolioDirectiveService } from "./portfolio-directive.js";

export type ToolActor = {
  userId: string;
  isInstanceAdmin: boolean;
  companyIds: string[];
};

export interface ToolContext {
  db: Db;
  actor: ToolActor;
  defaultCompanyId: string | null;
  /**
   * Chat session id, when this ToolContext is built from a chat-Agent
   * (Clippy) turn. Plugin tool calls thread this into `runContext.chatSessionId`
   * so the draft gate can record which session a queued tool call came from.
   */
  chatSessionId?: string;
}

export interface AnthropicToolSpec {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ChatToolDefinition<TInput = unknown> {
  name: string;
  description: string;
  mutating: boolean;
  inputSchema: ZodTypeAny;
  spec: AnthropicToolSpec;
  handler: (input: TInput, ctx: ToolContext) => Promise<unknown>;
}

async function assertCompanyAccess(ctx: ToolContext, companyId: string) {
  if (ctx.actor.isInstanceAdmin) return;
  if (!ctx.actor.companyIds.includes(companyId)) {
    throw forbidden(`No access to company ${companyId}`);
  }
}

async function resolveAccessibleCompanyIds(ctx: ToolContext): Promise<string[]> {
  if (ctx.actor.isInstanceAdmin) {
    const rows = await ctx.db.select({ id: companies.id }).from(companies);
    return rows.map((r) => r.id);
  }
  return ctx.actor.companyIds;
}

function summarizeIssue(row: typeof issues.$inferSelect) {
  return {
    id: row.id,
    identifier: row.identifier,
    companyId: row.companyId,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assigneeAgentId: row.assigneeAgentId,
    assigneeUserId: row.assigneeUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const listCompaniesTool: ChatToolDefinition<Record<string, never>> = {
  name: "list_companies",
  description:
    "List all companies the current board user has access to. Returns id, name, issuePrefix, status. Always allowed (read-only).",
  mutating: false,
  inputSchema: z.object({}),
  spec: {
    name: "list_companies",
    description: "List all companies the current board user has access to.",
    input_schema: { type: "object", properties: {} },
  },
  async handler(_input, ctx) {
    const ids = await resolveAccessibleCompanyIds(ctx);
    if (ids.length === 0) return { companies: [] };
    const rows = await ctx.db
      .select({
        id: companies.id,
        name: companies.name,
        issuePrefix: companies.issuePrefix,
        status: companies.status,
        description: companies.description,
      })
      .from(companies)
      .where(inArray(companies.id, ids));
    return { companies: rows };
  },
};

const getCompanyTool: ChatToolDefinition<{ companyId: string }> = {
  name: "get_company",
  description: "Get details for one company by id (or issue prefix).",
  mutating: false,
  inputSchema: z.object({ companyId: z.string().min(1) }),
  spec: {
    name: "get_company",
    description: "Get details for one company by id.",
    input_schema: {
      type: "object",
      properties: { companyId: { type: "string", description: "Company UUID" } },
      required: ["companyId"],
    },
  },
  async handler({ companyId }, ctx) {
    await assertCompanyAccess(ctx, companyId);
    const row = await ctx.db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((r) => r[0] ?? null);
    if (!row) throw notFound(`Company ${companyId} not found`);
    return {
      id: row.id,
      name: row.name,
      issuePrefix: row.issuePrefix,
      status: row.status,
      description: row.description,
      brandColor: row.brandColor,
      requireBoardApprovalForNewAgents: row.requireBoardApprovalForNewAgents,
    };
  },
};

const listAgentsTool: ChatToolDefinition<{ companyId?: string }> = {
  name: "list_agents",
  description: "List agents in a company. Defaults to the current selected company.",
  mutating: false,
  inputSchema: z.object({ companyId: z.string().optional() }),
  spec: {
    name: "list_agents",
    description: "List agents in a company. Pass companyId to scope, or omit to use current company.",
    input_schema: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "Company UUID. Optional; defaults to current." },
      },
    },
  },
  async handler({ companyId }, ctx) {
    const target = companyId ?? ctx.defaultCompanyId;
    if (!target) {
      throw forbidden("No company context: pass companyId or select a company first");
    }
    await assertCompanyAccess(ctx, target);
    const rows = await ctx.db
      .select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
        title: agents.title,
        status: agents.status,
        adapterType: agents.adapterType,
      })
      .from(agents)
      .where(eq(agents.companyId, target));
    return { companyId: target, agents: rows };
  },
};

const getAgentTool: ChatToolDefinition<{ agentId: string }> = {
  name: "get_agent",
  description: "Get details for one agent by id.",
  mutating: false,
  inputSchema: z.object({ agentId: z.string().min(1) }),
  spec: {
    name: "get_agent",
    description: "Get details for one agent by id.",
    input_schema: {
      type: "object",
      properties: { agentId: { type: "string" } },
      required: ["agentId"],
    },
  },
  async handler({ agentId }, ctx) {
    const row = await ctx.db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((r) => r[0] ?? null);
    if (!row) throw notFound(`Agent ${agentId} not found`);
    await assertCompanyAccess(ctx, row.companyId);
    return {
      id: row.id,
      name: row.name,
      role: row.role,
      title: row.title,
      status: row.status,
      companyId: row.companyId,
      adapterType: row.adapterType,
      reportsTo: row.reportsTo,
      capabilities: row.capabilities,
    };
  },
};

const listIssuesTool: ChatToolDefinition<{
  companyId?: string;
  status?: string;
  limit?: number;
}> = {
  name: "list_issues",
  description: "List issues in a company. Optional status filter (e.g. backlog, in_progress, done).",
  mutating: false,
  inputSchema: z.object({
    companyId: z.string().optional(),
    status: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  spec: {
    name: "list_issues",
    description:
      "List issues in a company. Optional status filter. Returns up to 50 most recent by default.",
    input_schema: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "Optional. Defaults to current company." },
        status: { type: "string", description: "Optional status filter." },
        limit: { type: "integer", description: "Max issues to return (1-100). Default 50." },
      },
    },
  },
  async handler({ companyId, status, limit = 50 }, ctx) {
    const target = companyId ?? ctx.defaultCompanyId;
    if (!target) {
      throw forbidden("No company context: pass companyId or select a company first");
    }
    await assertCompanyAccess(ctx, target);
    const conditions = status
      ? and(eq(issues.companyId, target), eq(issues.status, status))
      : eq(issues.companyId, target);
    const rows = await ctx.db
      .select()
      .from(issues)
      .where(conditions)
      .orderBy(desc(issues.updatedAt))
      .limit(limit);
    return { companyId: target, issues: rows.map(summarizeIssue) };
  },
};

const getIssueTool: ChatToolDefinition<{ issueId: string }> = {
  name: "get_issue",
  description: "Get a single issue with its comments.",
  mutating: false,
  inputSchema: z.object({ issueId: z.string().min(1) }),
  spec: {
    name: "get_issue",
    description: "Get a single issue with its comments.",
    input_schema: {
      type: "object",
      properties: { issueId: { type: "string" } },
      required: ["issueId"],
    },
  },
  async handler({ issueId }, ctx) {
    const row = await ctx.db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((r) => r[0] ?? null);
    if (!row) throw notFound(`Issue ${issueId} not found`);
    await assertCompanyAccess(ctx, row.companyId);
    const comments = await ctx.db
      .select({
        id: issueComments.id,
        body: issueComments.body,
        authorAgentId: issueComments.authorAgentId,
        authorUserId: issueComments.authorUserId,
        createdAt: issueComments.createdAt,
      })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .orderBy(issueComments.createdAt);
    return {
      issue: { ...summarizeIssue(row), description: row.description },
      comments: comments.map((c) => ({
        id: c.id,
        body: c.body,
        authorAgentId: c.authorAgentId,
        authorUserId: c.authorUserId,
        createdAt: c.createdAt.toISOString(),
      })),
    };
  },
};

const createIssueTool: ChatToolDefinition<{
  companyId?: string;
  title: string;
  description?: string;
}> = {
  name: "create_issue",
  description: "Create a new issue in a company. Mutating — requires permission.",
  mutating: true,
  inputSchema: z.object({
    companyId: z.string().optional(),
    title: z.string().min(1).max(500),
    description: z.string().max(10_000).optional(),
  }),
  spec: {
    name: "create_issue",
    description: "Create a new issue. Pass companyId or it uses the current company.",
    input_schema: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "Optional. Defaults to current company." },
        title: { type: "string" },
        description: { type: "string" },
      },
      required: ["title"],
    },
  },
  async handler({ companyId, title, description }, ctx) {
    const target = companyId ?? ctx.defaultCompanyId;
    if (!target) {
      throw forbidden("No company context: pass companyId or select a company first");
    }
    await assertCompanyAccess(ctx, target);
    const created = await ctx.db
      .insert(issues)
      .values({
        companyId: target,
        title,
        description: description ?? null,
        createdByUserId: ctx.actor.userId,
        originKind: "chat",
      })
      .returning()
      .then((rows) => rows[0]);
    return { issue: summarizeIssue(created) };
  },
};

const addCommentTool: ChatToolDefinition<{ issueId: string; body: string }> = {
  name: "add_comment",
  description: "Add a comment to an issue. Mutating — requires permission.",
  mutating: true,
  inputSchema: z.object({
    issueId: z.string().min(1),
    body: z.string().min(1).max(20_000),
  }),
  spec: {
    name: "add_comment",
    description: "Add a comment to an issue.",
    input_schema: {
      type: "object",
      properties: {
        issueId: { type: "string" },
        body: { type: "string" },
      },
      required: ["issueId", "body"],
    },
  },
  async handler({ issueId, body }, ctx) {
    const issueRow = await ctx.db
      .select({ id: issues.id, companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((r) => r[0] ?? null);
    if (!issueRow) throw notFound(`Issue ${issueId} not found`);
    await assertCompanyAccess(ctx, issueRow.companyId);
    const created = await ctx.db
      .insert(issueComments)
      .values({
        companyId: issueRow.companyId,
        issueId,
        body,
        authorUserId: ctx.actor.userId,
      })
      .returning()
      .then((rows) => rows[0]);
    return {
      comment: {
        id: created.id,
        issueId: created.issueId,
        body: created.body,
        authorUserId: created.authorUserId,
        createdAt: created.createdAt.toISOString(),
      },
    };
  },
};

const broadcastDirectiveTool: ChatToolDefinition<{
  intent: string;
  title?: string;
  companyIds?: string[];
  includePortfolioRoot?: boolean;
}> = {
  name: "broadcast_directive",
  description:
    "Fan out ONE high-level, cross-company intent to each company's CEO agent. For every targeted company this creates a task assigned to that company's CEO (who then decomposes it and delegates to the right sub-agent) and wakes them to start. Use this — not repeated create_issue calls — when the board expresses something they want done across all or several companies (e.g. 'get every company's Google reviews replied to', 'chase all overdue invoices'). Mutating — requires permission. Returns which CEOs it reached and which companies were skipped (and why).",
  mutating: true,
  inputSchema: z.object({
    intent: z.string().min(1).max(4000),
    title: z.string().max(200).optional(),
    companyIds: z.array(z.string()).max(500).optional(),
    includePortfolioRoot: z.boolean().optional(),
  }),
  spec: {
    name: "broadcast_directive",
    description:
      "Fan out one high-level intent to each company's CEO as an assigned, woken task; each CEO decomposes and delegates. Prefer this over creating issues one-by-one for portfolio-wide intents.",
    input_schema: {
      type: "object",
      properties: {
        intent: {
          type: "string",
          description:
            "The high-level directive, in plain language, as the operator expressed it (e.g. 'Acknowledge and reply to every company's Google reviews').",
        },
        title: {
          type: "string",
          description: "Optional short task title. Derived from intent when omitted.",
        },
        companyIds: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional. Restrict the fan-out to these company ids. Omit to target every active operating company the board can write to.",
        },
        includePortfolioRoot: {
          type: "boolean",
          description:
            "Optional. Include the HQ (portfolio-root) company as a target. Defaults to false — HQ is the cockpit, not an operating company.",
        },
      },
      required: ["intent"],
    },
  },
  async handler({ intent, title, companyIds, includePortfolioRoot }, ctx) {
    const svc = portfolioDirectiveService(ctx.db);
    return svc.broadcast({
      actor: ctx.actor,
      intent,
      title,
      companyIds,
      includePortfolioRoot,
    });
  },
};

const BLOCKED_HOST_PATTERNS = [/^localhost$/i, /\.local$/i, /\.internal$/i, /\.lan$/i];

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("fe80")) return true;
    return false;
  }
  return false;
}

// Best-effort SSRF guard: blocks obvious internal hostnames and rejects when
// DNS resolves to a private/loopback range. Note: a determined DNS-rebind
// attack could still pass the check and then resolve to a private IP at
// fetch time — accepted tradeoff for v1; pin-the-IP would harden it.
async function assertPublicHost(hostname: string): Promise<void> {
  for (const pat of BLOCKED_HOST_PATTERNS) {
    if (pat.test(hostname)) throw badRequest(`Blocked host ${hostname}`);
  }
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw badRequest(`Blocked private IP ${hostname}`);
    return;
  }
  let addrs: { address: string; family: number }[];
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch {
    throw badRequest(`DNS lookup failed for ${hostname}`);
  }
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw badRequest(`Host ${hostname} resolves to private IP ${a.address}`);
    }
  }
}

const webFetchTool: ChatToolDefinition<{ url: string; maxBytes?: number }> = {
  name: "web_fetch",
  description:
    "Fetch a public http(s) URL and return the response body as text. Read-only. Blocks loopback and private network addresses. Default cap 1 MB.",
  mutating: false,
  inputSchema: z.object({
    url: z.string().url(),
    maxBytes: z.number().int().min(1024).max(2_000_000).optional(),
  }),
  spec: {
    name: "web_fetch",
    description:
      "Fetch a public http(s) URL. Returns { status, finalUrl, contentType, body, truncated, byteLength }. Blocks private/loopback addresses.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http:// or https:// URL." },
        maxBytes: {
          type: "integer",
          description: "Optional cap on response bytes (default 1048576, max 2000000).",
        },
      },
      required: ["url"],
    },
  },
  async handler({ url, maxBytes = 1_048_576 }) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw badRequest(`Invalid URL: ${url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw badRequest(`Unsupported URL scheme ${parsed.protocol}`);
    }
    await assertPublicHost(parsed.hostname);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const resp = await fetch(parsed.toString(), {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: { "user-agent": "Paperclip-Clippy/1.0 (+web_fetch)" },
      });
      const contentType = resp.headers.get("content-type") ?? "";
      const reader = resp.body?.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      let truncated = false;
      if (reader) {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (received + value.length > maxBytes) {
            const remaining = Math.max(0, maxBytes - received);
            if (remaining > 0) chunks.push(value.subarray(0, remaining));
            truncated = true;
            try {
              await reader.cancel();
            } catch {
              // already closed
            }
            break;
          }
          chunks.push(value);
          received += value.length;
        }
      }
      const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      return {
        status: resp.status,
        finalUrl: resp.url,
        contentType,
        body: buf.toString("utf8"),
        truncated,
        byteLength: buf.byteLength,
      };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw badRequest(`Request to ${parsed.hostname} timed out after 15s`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  },
};

// ─── Reminder tools (Clippy natural-language reminders) ───────────────────
//
// Let a chat user create/list/cancel notifying calendar events
// (kind="reminder") in natural language ("remind me to run payroll every 2
// weeks"). Each tool projects a simplified `cadence` object onto the shared
// `createEventSchema` payload and delegates to `calendarService`, which owns
// scheduling (`computeNextRun`) and delivery.

const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * ISO string for TODAY (civil date in `timezone`) at `timeOfDay` local
 * wall-clock time. Used as the interval anchor so an "every 2 weeks at 09:00"
 * reminder is pinned to a real 09:00-local instant that stays 09:00 local
 * across daylight-saving shifts. Falls back to `now` if the timezone-aware
 * computation throws (e.g. an unknown IANA zone); the service's
 * `computeNextRun` still derives the correct cadence from any anchor.
 */
function todayAnchorIso(timeOfDay: string, timezone: string): string {
  try {
    const [hour, minute] = timeOfDay.split(":").map((n) => Number.parseInt(n, 10));
    const today = utcToCivilParts(new Date(), timezone);
    return civilToUtc(today.year, today.month, today.day, hour!, minute!, timezone).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/** Plain-language one-liner describing a reminder's cadence. */
function humanizeReminderCadence(event: {
  scheduleKind: string;
  intervalUnit: string | null;
  intervalCount: number | null;
  timeOfDay: string | null;
  cronExpression: string | null;
  anchorAt: Date | string | null;
}): string {
  if (event.scheduleKind === "interval") {
    const count = event.intervalCount ?? 1;
    const unit = event.intervalUnit ?? "day";
    const plural = count === 1 ? unit : `${unit}s`;
    const at = event.timeOfDay ? ` at ${event.timeOfDay}` : "";
    return `every ${count} ${plural}${at}`;
  }
  if (event.scheduleKind === "once") {
    const at = event.anchorAt
      ? event.anchorAt instanceof Date
        ? event.anchorAt.toISOString()
        : String(event.anchorAt)
      : "an unspecified time";
    return `once at ${at}`;
  }
  if (event.scheduleKind === "cron") {
    return event.cronExpression
      ? `on cron schedule "${event.cronExpression}"`
      : "on a cron schedule";
  }
  return event.scheduleKind;
}

interface CreateReminderInput {
  title: string;
  body?: string;
  cadence: {
    kind: "once" | "interval" | "cron";
    every?: number;
    unit?: "day" | "week" | "month";
    at?: string;
    expression?: string;
  };
  time?: string;
  timezone?: string;
  channels?: ("desktop" | "slack")[];
  slackTarget?: string;
  leadMinutes?: number;
}

const createReminderTool: ChatToolDefinition<CreateReminderInput> = {
  name: "create_reminder",
  description:
    "Create a notifying reminder (a calendar event that fires a notification) for the current company. Use for natural-language requests like 'remind me to run payroll every 2 weeks' or 'remind me to call the accountant tomorrow at 3pm'. Mutating — requires permission.",
  mutating: true,
  inputSchema: z.object({
    title: z.string().min(1).max(200),
    body: z.string().max(10_000).optional(),
    cadence: z.object({
      kind: z.enum(["once", "interval", "cron"]),
      every: z.number().int().min(1).optional(),
      unit: z.enum(["day", "week", "month"]).optional(),
      at: z.string().optional(),
      expression: z.string().optional(),
    }),
    time: z.string().optional(),
    timezone: z.string().optional(),
    channels: z.array(z.enum(["desktop", "slack"])).optional(),
    slackTarget: z.string().optional(),
    leadMinutes: z.number().int().min(0).optional(),
  }),
  spec: {
    name: "create_reminder",
    description:
      "Create a notifying reminder for the current company. Map the user's phrasing onto `cadence`: interval ('every 2 weeks' -> {kind:'interval', every:2, unit:'week'}), one-time ('tomorrow at 3pm' -> {kind:'once', at:'<ISO datetime>'}), or cron ({kind:'cron', expression:'0 9 * * 1'}). Returns the created reminder with its next run time.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short reminder title, e.g. 'Run payroll'." },
        body: { type: "string", description: "Optional longer note shown with the notification." },
        cadence: {
          type: "object",
          description: "How often the reminder fires.",
          properties: {
            kind: { type: "string", enum: ["once", "interval", "cron"] },
            every: {
              type: "integer",
              description: "Interval count (>=1). Required for kind=interval, e.g. 2 for 'every 2 weeks'.",
            },
            unit: {
              type: "string",
              enum: ["day", "week", "month"],
              description: "Interval unit. Required for kind=interval.",
            },
            at: {
              type: "string",
              description: "ISO 8601 datetime for the single fire. Required for kind=once.",
            },
            expression: {
              type: "string",
              description: "5-field cron expression. Required for kind=cron.",
            },
          },
          required: ["kind"],
        },
        time: {
          type: "string",
          description: "Local clock time 'HH:MM' (24-hour) for interval reminders. Defaults to 09:00.",
        },
        timezone: {
          type: "string",
          description: "IANA timezone (e.g. 'America/New_York'). Defaults to UTC.",
        },
        channels: {
          type: "array",
          items: { type: "string", enum: ["desktop", "slack"] },
          description: "Notification channels. Defaults to ['desktop'].",
        },
        slackTarget: {
          type: "string",
          description: "Slack DM target. Required when channels includes 'slack'.",
        },
        leadMinutes: {
          type: "integer",
          description: "Notify this many minutes before the occurrence. Defaults to 0.",
        },
      },
      required: ["title", "cadence"],
    },
  },
  async handler(input, ctx) {
    const target = ctx.defaultCompanyId;
    if (!target) {
      throw forbidden("No company context: select a company first");
    }
    await assertCompanyAccess(ctx, target);

    const timezone = input.timezone?.trim() || "UTC";
    const channels: ("desktop" | "slack")[] =
      input.channels && input.channels.length > 0 ? input.channels : ["desktop"];
    if (channels.includes("slack") && !input.slackTarget) {
      throw badRequest("A Slack target is required when the slack channel is selected");
    }

    const base = {
      title: input.title,
      body: input.body ?? null,
      kind: "reminder" as const,
      timezone,
      allDay: false,
      durationMinutes: null,
      notify: true,
      channels,
      leadTimeMinutes: input.leadMinutes ?? 0,
      slackTarget: input.slackTarget ?? null,
      endAt: null,
      maxOccurrences: null,
    };

    const { cadence } = input;
    let payload: CreateCalendarEvent;

    if (cadence.kind === "interval") {
      if (!cadence.unit) {
        throw badRequest("Interval reminders require a unit (day, week, or month)");
      }
      if (cadence.every == null || cadence.every < 1) {
        throw badRequest("Interval reminders require 'every' to be at least 1");
      }
      const timeOfDay = input.time?.trim() || "09:00";
      if (!TIME_OF_DAY_RE.test(timeOfDay)) {
        throw badRequest(`Invalid time '${timeOfDay}' — expected HH:MM (24-hour)`);
      }
      payload = {
        ...base,
        scheduleKind: "interval",
        anchorAt: todayAnchorIso(timeOfDay, timezone),
        intervalUnit: cadence.unit,
        intervalCount: cadence.every,
        timeOfDay,
        cronExpression: null,
      };
    } else if (cadence.kind === "once") {
      if (!cadence.at) {
        throw badRequest("One-time reminders require 'at' (an ISO datetime)");
      }
      payload = {
        ...base,
        scheduleKind: "once",
        anchorAt: cadence.at,
        intervalUnit: null,
        intervalCount: null,
        timeOfDay: null,
        cronExpression: null,
      };
    } else {
      if (!cadence.expression) {
        throw badRequest("Cron reminders require a cron 'expression'");
      }
      payload = {
        ...base,
        scheduleKind: "cron",
        anchorAt: null,
        intervalUnit: null,
        intervalCount: null,
        timeOfDay: null,
        cronExpression: cadence.expression,
      };
    }

    const created = await calendarService(ctx.db).create(target, payload, {
      userId: ctx.actor.userId ?? "board",
      agentId: null,
    });

    const cadenceSummary = humanizeReminderCadence(created);
    const nextRunAt = created.nextRunAt ? created.nextRunAt.toISOString() : null;
    return {
      reminder: {
        id: created.id,
        title: created.title,
        cadence: cadenceSummary,
        nextRunAt,
        channels: created.channels,
        timezone: created.timezone,
      },
      message: `Reminder "${created.title}" created (${cadenceSummary}). ${
        nextRunAt ? `Next run: ${nextRunAt}.` : "No upcoming run scheduled."
      }`,
    };
  },
};

const listRemindersTool: ChatToolDefinition<Record<string, never>> = {
  name: "list_reminders",
  description:
    "List active reminders (notifying calendar events) for the current company. Read-only.",
  mutating: false,
  inputSchema: z.object({}),
  spec: {
    name: "list_reminders",
    description:
      "List active reminders for the current company. Returns id, title, status, a human cadence summary, next run time, and channels.",
    input_schema: { type: "object", properties: {} },
  },
  async handler(_input, ctx) {
    const target = ctx.defaultCompanyId;
    if (!target) {
      throw forbidden("No company context: select a company first");
    }
    await assertCompanyAccess(ctx, target);
    const events = await calendarService(ctx.db).list(target);
    const reminders = events
      .filter((e) => e.kind === "reminder" && e.status !== "cancelled")
      .map((e) => ({
        id: e.id,
        title: e.title,
        status: e.status,
        cadence: humanizeReminderCadence(e),
        nextRunAt: e.nextRunAt ? e.nextRunAt.toISOString() : null,
        channels: e.channels,
      }));
    return { reminders };
  },
};

const cancelReminderTool: ChatToolDefinition<{ reminderId: string }> = {
  name: "cancel_reminder",
  description: "Cancel a reminder by id so it stops firing. Mutating — requires permission.",
  mutating: true,
  inputSchema: z.object({ reminderId: z.string().min(1) }),
  spec: {
    name: "cancel_reminder",
    description: "Cancel a reminder by id so it stops firing.",
    input_schema: {
      type: "object",
      properties: {
        reminderId: {
          type: "string",
          description: "The reminder (calendar event) id to cancel.",
        },
      },
      required: ["reminderId"],
    },
  },
  async handler({ reminderId }, ctx) {
    const svc = calendarService(ctx.db);
    const existing = await svc.getById(reminderId);
    if (!existing || existing.companyId !== ctx.defaultCompanyId) {
      throw badRequest(`Reminder ${reminderId} not found in the current company`);
    }
    await assertCompanyAccess(ctx, existing.companyId);
    const updated = await svc.update(
      reminderId,
      { status: "cancelled" },
      { userId: ctx.actor.userId ?? "board", agentId: null },
    );
    return {
      reminder: {
        id: reminderId,
        title: updated?.title ?? existing.title,
        status: updated?.status ?? "cancelled",
      },
      message: `Reminder "${updated?.title ?? existing.title}" cancelled.`,
    };
  },
};

export const CHAT_TOOLS: ChatToolDefinition[] = [
  listCompaniesTool,
  getCompanyTool,
  listAgentsTool,
  getAgentTool,
  listIssuesTool,
  getIssueTool,
  createIssueTool,
  broadcastDirectiveTool,
  addCommentTool,
  webFetchTool,
  createReminderTool,
  listRemindersTool,
  cancelReminderTool,
] as ChatToolDefinition[];

const TOOLS_BY_NAME: Record<string, ChatToolDefinition> = Object.fromEntries(
  CHAT_TOOLS.map((tool) => [tool.name, tool]),
);

export function getChatTool(name: string): ChatToolDefinition | undefined {
  return TOOLS_BY_NAME[name];
}

export function listChatToolSpecs(): AnthropicToolSpec[] {
  return CHAT_TOOLS.map((t) => t.spec);
}

// ─── Plugin tools bridge ──────────────────────────────────────────────
//
// Plugin tools (e.g. `3cx-tools:pbx_click_to_call`) are registered with
// `PluginToolDispatcher` and live on a different surface than the
// hardcoded chat tools above. To let chat-Agent mode invoke them, we
// project each plugin tool into the same `AnthropicToolSpec` shape and
// route execution back through the dispatcher.
//
// Anthropic / Bedrock / Gemini tool names must match
// `^[a-zA-Z0-9_-]{1,64}$` — no colons. The plugin namespaced name
// `<pluginKey>:<toolName>` is converted to `<pluginKey>__<toolName>`
// using a double-underscore separator (only the FIRST colon is replaced
// so plugin tool names that contain underscores are unaffected). The
// reverse mapping happens at execute time.

const PLUGIN_TOOL_SEPARATOR = "__";

function pluginToolToChatName(namespacedName: string): string {
  // "3cx-tools:pbx_click_to_call" -> "3cx-tools__pbx_click_to_call"
  const idx = namespacedName.indexOf(":");
  if (idx < 0) return namespacedName;
  return (
    namespacedName.slice(0, idx) +
    PLUGIN_TOOL_SEPARATOR +
    namespacedName.slice(idx + 1)
  );
}

function chatNameToPluginTool(chatName: string): string {
  // "3cx-tools__pbx_click_to_call" -> "3cx-tools:pbx_click_to_call"
  const idx = chatName.indexOf(PLUGIN_TOOL_SEPARATOR);
  if (idx < 0) return chatName;
  return (
    chatName.slice(0, idx) +
    ":" +
    chatName.slice(idx + PLUGIN_TOOL_SEPARATOR.length)
  );
}

/**
 * True if the chat-name looks like a plugin tool name we projected
 * (contains `__`). None of the hardcoded chat tools above use that
 * separator, so this is a clean partition.
 */
export function isPluginChatToolName(chatName: string): boolean {
  return chatName.includes(PLUGIN_TOOL_SEPARATOR);
}

/**
 * Enumerate plugin tools as AnthropicToolSpec[] for inclusion in a
 * chat-Agent session's tool list. Returns [] when the session has no
 * company in scope (every plugin tool would fail ECOMPANY_NOT_ALLOWED
 * without one — exposing them to the LLM would just lead to confusing
 * errors).
 */
export async function listPluginToolSpecsForChat(
  dispatcher: PluginToolDispatcher | null,
  companyId: string | null,
): Promise<AnthropicToolSpec[]> {
  if (!dispatcher || !companyId) return [];
  let tools;
  try {
    tools = await dispatcher.listToolsForAgent({ companyId });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), companyId },
      "Failed to list plugin tools for chat — proceeding without",
    );
    return [];
  }
  return tools.map((t) => ({
    name: pluginToolToChatName(t.name),
    description: `${t.displayName} — ${t.description}`,
    input_schema: t.parametersSchema as AnthropicToolSpec["input_schema"],
  }));
}

/**
 * Execute a plugin tool that was surfaced into a chat-Agent session.
 * Builds a synthetic `runContext` (`agentId="clippy:<userId>"`, fresh
 * runId) since chat-Agent isn't an agent run. The plugin worker only
 * uses agentId/runId for telemetry; companyId is the security-relevant
 * field and that comes from the session.
 */
export async function executePluginChatTool(
  dispatcher: PluginToolDispatcher | null,
  chatName: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  if (!dispatcher) {
    return {
      ok: false,
      error: "Plugin tool dispatch is not enabled on this server.",
    };
  }
  if (!ctx.defaultCompanyId) {
    return {
      ok: false,
      error:
        "No company in scope. Plugin tools require a company — pin one on the chat session or ask the user which company they mean.",
    };
  }
  const namespacedName = chatNameToPluginTool(chatName);
  const runContext = {
    agentId: `clippy:${ctx.actor.userId}`,
    runId: randomUUID(),
    companyId: ctx.defaultCompanyId,
    projectId: "",
    chatSessionId: ctx.chatSessionId,
  };
  try {
    const exec = await dispatcher.executeTool(namespacedName, rawInput, runContext);
    if (exec.result.error) return { ok: false, error: exec.result.error };
    // For drafted tools (intercepted by the trust-loop gate), the synthesized
    // result carries the "Do not retry the tool — end your turn" instruction in
    // `content` and the structured metadata in `data`. We must surface the
    // content; otherwise the LLM only sees `{drafted:true,...}` and re-calls
    // the same tool on the next loop iteration, queueing duplicate approvals.
    const data = exec.result.data;
    const isDraft =
      typeof data === "object" &&
      data !== null &&
      (data as Record<string, unknown>).drafted === true;
    if (isDraft && typeof exec.result.content === "string") {
      return { ok: true, result: exec.result.content };
    }
    return {
      ok: true,
      result: data ?? exec.result.content ?? null,
    };
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), tool: namespacedName },
      "Plugin chat tool execution failed",
    );
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function executeChatTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
  dispatcher?: PluginToolDispatcher | null,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  if (isPluginChatToolName(name)) {
    return executePluginChatTool(dispatcher ?? null, name, rawInput, ctx);
  }
  const tool = getChatTool(name);
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
  const parsed = tool.inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `Invalid input: ${parsed.error.message}` };
  }
  try {
    const result = await tool.handler(parsed.data, ctx);
    return { ok: true, result };
  } catch (err) {
    if (err && typeof err === "object" && "status" in err && "message" in err) {
      return { ok: false, error: String((err as { message: string }).message) };
    }
    logger.error({ err, tool: name }, "Chat tool execution failed");
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Resolve the active companyId for the actor. Falls back to the first
// accessible company when the session didn't pin one.
export async function resolveDefaultCompanyId(
  db: Db,
  actor: ToolActor,
  preferredId: string | null,
): Promise<string | null> {
  if (preferredId) {
    if (actor.isInstanceAdmin || actor.companyIds.includes(preferredId)) {
      return preferredId;
    }
  }
  if (actor.companyIds.length > 0) return actor.companyIds[0];
  if (actor.isInstanceAdmin) {
    const row = await db
      .select({ id: companies.id })
      .from(companies)
      .limit(1)
      .then((r) => r[0] ?? null);
    return row?.id ?? null;
  }
  return null;
}

// Make TS happy about the unused membership import which we may need later.
void companyMemberships;
