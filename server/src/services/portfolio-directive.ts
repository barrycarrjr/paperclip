import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import {
  directivePreviewSummaryLines,
  type DirectivePreview,
  type DirectivePreviewRecipient,
} from "@paperclipai/shared";
import { issueService } from "./issues.js";
import { heartbeatService } from "./heartbeat.js";
import { instanceSettingsService } from "./instance-settings.js";
import { queueIssueAssignmentWakeup } from "./issue-assignment-wakeup.js";
import { conflict, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { personalCompanyOwner } from "./personal-companies.js";

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

/**
 * Everything needed to work out what a broadcast would do. `broadcast` takes
 * the same fields plus the id of the preview that answered for them, so the
 * two can never be asked different questions.
 */
export interface PreviewDirectiveInput {
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

export interface BroadcastDirectiveInput extends PreviewDirectiveInput {
  /**
   * The `previewId` from the preview the operator actually read. Required:
   * there is no way to send a directive without first asking what it would
   * do, on any path, so neither the Directives page nor Clippy can start
   * work in eight companies from a press nobody was shown the effect of.
   */
  previewId: string;
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

/**
 * Salt for the preview id, minted once per server process and never sent
 * anywhere. It means a `previewId` can only come from a preview this server
 * actually answered: nobody, including the model behind Clippy, can work one
 * out and skip the step.
 */
const PREVIEW_SALT = randomBytes(32).toString("hex");

/**
 * The id of one preview: a fingerprint of everything that preview claimed
 * would happen. Recomputed at send time from a fresh look at the world, so a
 * company archived, a lead replaced, or the approval hold switched off
 * between reading and sending all produce a different id and the send is
 * refused rather than quietly doing something else.
 */
function previewFingerprint(
  userId: string,
  plan: {
    intent: string;
    title: string;
    willReceive: DirectivePreviewRecipient[];
    skipped: DirectiveSkip[];
    outboundHold: boolean;
  },
): string {
  const canonical = JSON.stringify({
    userId,
    intent: plan.intent,
    title: plan.title,
    willReceive: plan.willReceive.map((r) => `${r.companyId}:${r.lead.id}`).sort(),
    skipped: plan.skipped.map((s) => `${s.companyId}:${s.reason}`).sort(),
    outboundHold: plan.outboundHold,
  });
  return createHash("sha256").update(PREVIEW_SALT).update(canonical).digest("hex");
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
    input: PreviewDirectiveInput,
  ): Promise<{
    targets: { id: string; name: string }[];
    skipped: DirectiveSkip[];
  }> {
    const { actor, companyIds, includePortfolioRoot } = input;
    const skipped: DirectiveSkip[] = [];

    let rows: { id: string; name: string; status: string; isPortfolioRoot: boolean }[];
    if (companyIds !== undefined) {
      // An explicit, empty selection means "target nothing" — it must not
      // fall through to the omitted-companyIds branch below, which targets
      // every accessible company. (P4 audit, 2026-09-03: the previous
      // `companyIds && companyIds.length > 0` check treated `[]` the same as
      // "omitted" by accident, since `[] && anything` is truthy but the
      // length check then failed, sending it to the all-companies branch —
      // reachable via the `broadcast_directive` Clippy tool, not just the
      // one first-party form that happens to disable submit on an empty
      // pick.) The route/tool schemas now also reject an explicit empty
      // array outright; this is defense in depth for any other caller.
      if (companyIds.length === 0) {
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
      const personalOwner = personalCompanyOwner(row.id);
      if (personalOwner) {
        // A directive is an instruction to the businesses. Somebody's Personal
        // is not one of them, and a portfolio-wide fan-out that reached into
        // it would put work in a place its owner never opted in to. Only its
        // owner naming it explicitly gets through.
        const namedByOwner = companyIds?.includes(row.id) && actor.userId === personalOwner;
        if (!namedByOwner) {
          if (companyIds?.includes(row.id)) {
            skipped.push({
              companyId: row.id,
              companyName: row.name,
              reason: "Personal companies are private and are not directive targets",
            });
          }
          continue;
        }
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

  /**
   * The whole answer to "what would this do", with nothing written.
   *
   * Both `preview` and `broadcast` go through here, so the preview cannot
   * drift from the send: they resolve the same companies with the same rules
   * and report the same skip reasons, because it is the same code.
   */
  async function resolvePlan(input: PreviewDirectiveInput): Promise<{
    intent: string;
    title: string;
    willReceive: DirectivePreviewRecipient[];
    skipped: DirectiveSkip[];
    outboundHold: boolean;
  }> {
    const intent = input.intent.trim();
    const title = (input.title?.trim() || deriveTitle(intent)).slice(0, 200);
    const { targets, skipped } = await resolveTargetCompanies(input);

    const willReceive: DirectivePreviewRecipient[] = [];
    for (const company of targets) {
      const lead = await findCeo(company.id);
      if (!lead) {
        skipped.push({
          companyId: company.id,
          companyName: company.name,
          reason: "No CEO or top-level agent to delegate to",
        });
        continue;
      }
      willReceive.push({
        companyId: company.id,
        companyName: company.name,
        lead: { id: lead.id, name: lead.name },
      });
    }

    const general = await instanceSettingsService(db).getGeneral();
    return { intent, title, willReceive, skipped, outboundHold: general.outboundToolDraftMode };
  }

  /**
   * Say what a broadcast would do. Reads only: no issue is created, nobody is
   * woken, and no setting is touched, so an operator (or Clippy) can ask this
   * as often as they like and cancelling afterwards leaves nothing behind.
   */
  async function preview(input: PreviewDirectiveInput): Promise<DirectivePreview> {
    const plan = await resolvePlan(input);
    const facts = {
      willReceive: plan.willReceive,
      skipped: plan.skipped,
      guardrails: { outboundHold: plan.outboundHold },
    };
    return {
      previewId: previewFingerprint(input.actor.userId, plan),
      intent: plan.intent,
      title: plan.title,
      ...facts,
      summaryLines: directivePreviewSummaryLines(facts),
    };
  }

  async function broadcast(input: BroadcastDirectiveInput): Promise<DirectiveResult> {
    const directiveId = randomUUID();
    const plan = await resolvePlan(input);
    const { intent, title, skipped } = plan;

    // The gate. A send only goes through carrying the id of a preview of this
    // exact answer, so nobody can be shown one set of companies and send to
    // another, and no path can send without a preview having been produced.
    const expected = previewFingerprint(input.actor.userId, plan);
    if (!input.previewId) {
      throw unprocessable(
        "Preview this directive first, so you can see which companies would receive it and who in each one.",
      );
    }
    if (input.previewId !== expected) {
      throw conflict(
        "This is not what the preview said would happen, or something has changed since. Preview it again before sending.",
      );
    }

    const dispatched: DirectiveDispatch[] = [];

    for (const recipient of plan.willReceive) {
      const { companyId, companyName, lead } = recipient;
      try {
        const created = await issues.create(companyId, {
          title,
          description: directiveBody(intent, companyName, directiveId),
          status: "todo",
          assigneeAgentId: lead.id,
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
          companyId,
          companyName,
          ceoAgentId: lead.id,
          ceoAgentName: lead.name,
          issueId: created.id,
          issueIdentifier: created.identifier ?? null,
        });
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), companyId, directiveId },
          "portfolio directive: failed to dispatch to company",
        );
        skipped.push({
          companyId,
          companyName,
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

  return { preview, broadcast };
}

export type PortfolioDirectiveService = ReturnType<typeof portfolioDirectiveService>;
