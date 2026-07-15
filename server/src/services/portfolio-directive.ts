import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import { issueService } from "./issues.js";
import { heartbeatService } from "./heartbeat.js";
import { queueIssueAssignmentWakeup } from "./issue-assignment-wakeup.js";
import { logger } from "../middleware/logger.js";

// ─── Portfolio Directive (the "conductor") ────────────────────────────────
//
// A portfolio directive is a single high-level intent the board expresses
// once from HQ ("get every company's Google reviews replied to") that fans
// out to each operating company's CEO agent as an assigned, woken issue.
// Each CEO then decomposes it and delegates to the right sub-agent using the
// existing org-chart delegation pattern — so the intelligence of "what to do
// here" lives in each company's CEO, not in a central engine.
//
// This composes existing primitives and adds no new tables:
//   - issueService.create()          → the real create with all invariants
//   - queueIssueAssignmentWakeup()   → actually runs the assignee
//   - originKind/originId            → tag + correlate the fan-out set
//
// Cross-company writes are gated by board membership (same rule the other
// chat tools use): companies the board user can't write to are skipped with
// a reason rather than failing the whole broadcast.

/** Board user acting via Clippy. Mirrors chat-tools' ToolActor. */
export interface DirectiveActor {
  userId: string;
  isInstanceAdmin: boolean;
  companyIds: string[];
}

export interface DirectiveDispatch {
  companyId: string;
  companyName: string;
  ceoAgentId: string;
  ceoAgentName: string;
  issueId: string;
  issueIdentifier: string | null;
}

export interface DirectiveSkip {
  companyId: string;
  companyName: string;
  reason: string;
}

export interface DirectiveResult {
  directiveId: string;
  intent: string;
  title: string;
  dispatched: DirectiveDispatch[];
  skipped: DirectiveSkip[];
}

export interface BroadcastDirectiveInput {
  actor: DirectiveActor;
  /** The high-level intent, verbatim from the operator. */
  intent: string;
  /** Optional short issue title; derived from `intent` when omitted. */
  title?: string;
  /**
   * Restrict the fan-out to these company ids. When omitted, every active
   * operating company the board user can write to is targeted. Ids the user
   * can't reach are reported under `skipped`.
   */
  companyIds?: string[];
  /**
   * Include the HQ (portfolio-root) company as a target. Defaults to false —
   * HQ is the cockpit, not an operating company.
   */
  includePortfolioRoot?: boolean;
}

// Agent lifecycle states that mean "can't take work". Kept permissive: any
// status not in this set (idle, busy, active, …) is treated as assignable.
const TERMINAL_AGENT_STATUSES = ["terminated", "archived", "disabled", "suspended"];
// Company states that shouldn't receive directives.
const INACTIVE_COMPANY_STATUSES = ["archived", "deleted", "suspended"];
/** originKind tag shared by every issue in a directive fan-out. */
export const PORTFOLIO_DIRECTIVE_ORIGIN_KIND = "portfolio_directive";
const ORIGIN_KIND = PORTFOLIO_DIRECTIVE_ORIGIN_KIND;

const ORDINARY_TITLE_MAX = 120;

function deriveTitle(intent: string): string {
  const firstLine = intent.trim().split("\n")[0]!.trim();
  if (firstLine.length <= ORDINARY_TITLE_MAX) return `Directive: ${firstLine}`;
  return `Directive: ${firstLine.slice(0, ORDINARY_TITLE_MAX - 1).trimEnd()}…`;
}

function directiveBody(intent: string, companyName: string, directiveId: string): string {
  return [
    intent.trim(),
    "",
    "---",
    `This is a **portfolio directive** issued from HQ by the board. As CEO of ${companyName}, decide how it applies here, break it into concrete tasks, and delegate each to the right agent — create child issues assigned to them (use find-by-capability if you're unsure who owns it).`,
    "",
    "If a required capability or tool isn't installed for this company, say so in a comment instead of guessing. Route anything that needs the board's sign-off through an approval so it surfaces in Portfolio Approvals at HQ.",
    "",
    `Directive ID: \`${directiveId}\``,
  ].join("\n");
}

export function portfolioDirectiveService(db: Db) {
  const issues = issueService(db);
  const heartbeat = heartbeatService(db);

  function canWrite(actor: DirectiveActor, companyId: string): boolean {
    return actor.isInstanceAdmin || actor.companyIds.includes(companyId);
  }

  async function resolveTargetCompanies(
    input: BroadcastDirectiveInput,
  ): Promise<{
    targets: { id: string; name: string }[];
    skipped: DirectiveSkip[];
  }> {
    const { actor, companyIds, includePortfolioRoot } = input;
    const skipped: DirectiveSkip[] = [];

    let rows: { id: string; name: string; status: string; isPortfolioRoot: boolean }[];
    if (companyIds && companyIds.length > 0) {
      rows = await db
        .select({
          id: companies.id,
          name: companies.name,
          status: companies.status,
          isPortfolioRoot: companies.isPortfolioRoot,
        })
        .from(companies)
        .where(inArray(companies.id, companyIds));
      // Report explicitly-requested ids that don't exist at all.
      const found = new Set(rows.map((r) => r.id));
      for (const id of companyIds) {
        if (!found.has(id)) {
          skipped.push({ companyId: id, companyName: id, reason: "Company not found" });
        }
      }
    } else {
      const accessibleIds = actor.isInstanceAdmin ? null : actor.companyIds;
      if (accessibleIds && accessibleIds.length === 0) {
        return { targets: [], skipped };
      }
      rows = await db
        .select({
          id: companies.id,
          name: companies.name,
          status: companies.status,
          isPortfolioRoot: companies.isPortfolioRoot,
        })
        .from(companies)
        .where(accessibleIds ? inArray(companies.id, accessibleIds) : undefined);
    }

    const targets: { id: string; name: string }[] = [];
    for (const row of rows) {
      if (row.isPortfolioRoot && !includePortfolioRoot) {
        // HQ is the cockpit; silently excluded from a portfolio-wide fan-out
        // unless explicitly named. Only surface a skip when it was requested.
        if (companyIds?.includes(row.id)) {
          skipped.push({
            companyId: row.id,
            companyName: row.name,
            reason: "HQ (portfolio root) excluded — pass includePortfolioRoot to target it",
          });
        }
        continue;
      }
      if (INACTIVE_COMPANY_STATUSES.includes(row.status)) {
        skipped.push({ companyId: row.id, companyName: row.name, reason: `Company is ${row.status}` });
        continue;
      }
      if (!canWrite(actor, row.id)) {
        skipped.push({
          companyId: row.id,
          companyName: row.name,
          reason: "No write access — you are not a member of this company",
        });
        continue;
      }
      targets.push({ id: row.id, name: row.name });
    }
    return { targets, skipped };
  }

  /** Resolve a company's CEO agent: role='ceo' first, else the org-chart root. */
  async function findCeo(companyId: string): Promise<{ id: string; name: string } | null> {
    const ceoRows = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          eq(agents.role, "ceo"),
          notInArray(agents.status, TERMINAL_AGENT_STATUSES),
        ),
      )
      .orderBy(asc(agents.createdAt))
      .limit(1);
    if (ceoRows[0]) return ceoRows[0];

    // Fallback: the top of the org chart (reports to nobody).
    const rootRows = await db
      .select({ id: agents.id, name: agents.name, reportsTo: agents.reportsTo })
      .from(agents)
      .where(
        and(eq(agents.companyId, companyId), notInArray(agents.status, TERMINAL_AGENT_STATUSES)),
      )
      .orderBy(asc(agents.createdAt));
    const root = rootRows.find((r) => r.reportsTo == null);
    return root ? { id: root.id, name: root.name } : null;
  }

  async function broadcast(input: BroadcastDirectiveInput): Promise<DirectiveResult> {
    const directiveId = randomUUID();
    const intent = input.intent.trim();
    const title = (input.title?.trim() || deriveTitle(intent)).slice(0, 200);

    const { targets, skipped } = await resolveTargetCompanies(input);
    const dispatched: DirectiveDispatch[] = [];

    for (const company of targets) {
      const ceo = await findCeo(company.id);
      if (!ceo) {
        skipped.push({
          companyId: company.id,
          companyName: company.name,
          reason: "No CEO or top-level agent to delegate to",
        });
        continue;
      }
      try {
        const created = await issues.create(company.id, {
          title,
          description: directiveBody(intent, company.name, directiveId),
          status: "todo",
          assigneeAgentId: ceo.id,
          createdByUserId: input.actor.userId,
          originKind: ORIGIN_KIND,
          originId: directiveId,
        });
        await queueIssueAssignmentWakeup({
          heartbeat,
          issue: created,
          reason: "portfolio directive",
          mutation: "assigned",
          contextSource: "portfolio_directive",
          requestedByActorType: "user",
          requestedByActorId: input.actor.userId,
        });
        dispatched.push({
          companyId: company.id,
          companyName: company.name,
          ceoAgentId: ceo.id,
          ceoAgentName: ceo.name,
          issueId: created.id,
          issueIdentifier: created.identifier ?? null,
        });
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), companyId: company.id, directiveId },
          "portfolio directive: failed to dispatch to company",
        );
        skipped.push({
          companyId: company.id,
          companyName: company.name,
          reason: err instanceof Error ? err.message : "Failed to create the directive issue",
        });
      }
    }

    logger.info(
      { directiveId, dispatched: dispatched.length, skipped: skipped.length },
      "portfolio directive broadcast",
    );
    return { directiveId, intent, title, dispatched, skipped };
  }

  return { broadcast };
}

export type PortfolioDirectiveService = ReturnType<typeof portfolioDirectiveService>;
