/**
 * Server side of the starter catalog — the thing behind "What do you want
 * done?".
 *
 * Two jobs:
 *
 * 1. **Tell the truth about readiness.** For each outcome card, say whether
 *    it can actually run in this company right now, and if not, exactly what
 *    is missing. The old Routines page let you switch something on and then
 *    quietly did nothing because a connector was never authorised. The whole
 *    point of this surface is that the price of admission is stated before
 *    you commit.
 *
 * 2. **Do the setup, not just describe it.** Switching a card on turns on
 *    what it needs, creates the routine, puts it on a schedule, and runs it
 *    once so the operator sees a real result the same minute — rather than
 *    being sent off to find the Plugin Manager on their own.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, plugins } from "@paperclipai/db";
import {
  STARTER_CARDS,
  findStarterCard,
  type StarterCard,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { routineService } from "./routines.js";
import { logger } from "../middleware/logger.js";

/** Why a card cannot run yet, in words an operator can act on. */
export interface StarterBlocker {
  pluginKey: string;
  /**
   * `missing`  — never installed. Someone has to install it.
   * `disabled` — installed but switched off. We can turn it back on.
   */
  kind: "missing" | "disabled";
  detail: string;
}

export interface StarterCardStatus {
  card: StarterCard;
  /** True when switching this on will genuinely work end to end. */
  ready: boolean;
  /**
   * True when the only thing standing in the way is plugins we can switch
   * on ourselves. The UI can offer a single button for these rather than
   * sending the operator away.
   */
  fixable: boolean;
  blockers: StarterBlocker[];
  /** Set when this company already has a routine from this card. */
  existingRoutineId: string | null;
}

export interface StarterActivationStep {
  step: string;
  ok: boolean;
  detail: string;
}

export interface StarterActivationResult {
  cardId: string;
  routineId: string | null;
  runId: string | null;
  steps: StarterActivationStep[];
  /** True only when the routine exists, is scheduled, AND has been run once. */
  ranOnce: boolean;
}

type Actor = { userId?: string | null };

/**
 * Marker written into a created routine's description so a company's
 * existing starter routines can be recognised later. Kept out of the title
 * because the title is what the operator reads.
 */
export function starterRoutineMarker(cardId: string): string {
  return `<!-- paperclip:starter-card=${cardId} -->`;
}

export function starterCatalogService(
  db: Db,
  deps: {
    /** Enables an installed-but-disabled plugin. Injected so this service
     *  does not depend on the whole plugin lifecycle module. */
    enablePlugin?: (pluginId: string) => Promise<unknown>;
  } = {},
) {
  const routines = routineService(db);

  async function pluginStateByKey(): Promise<Map<string, { id: string; status: string }>> {
    const rows = await db
      .select({ id: plugins.id, pluginKey: plugins.pluginKey, status: plugins.status })
      .from(plugins);
    return new Map(rows.map((r) => [r.pluginKey, { id: r.id, status: r.status }]));
  }

  function blockersFor(
    card: StarterCard,
    state: Map<string, { id: string; status: string }>,
  ): StarterBlocker[] {
    const blockers: StarterBlocker[] = [];
    for (const key of card.requiresPlugins) {
      const record = state.get(key);
      if (!record || record.status === "uninstalled") {
        blockers.push({
          pluginKey: key,
          kind: "missing",
          detail: `${key} is not installed`,
        });
      } else if (record.status !== "ready") {
        blockers.push({
          pluginKey: key,
          kind: "disabled",
          detail: `${key} is installed but not running (${record.status})`,
        });
      }
    }
    return blockers;
  }

  /**
   * Find a routine this company already made from `cardId`, so the panel can
   * show "already on" instead of silently creating a second copy of the same
   * job every time someone clicks.
   */
  async function existingRoutineIdFor(companyId: string, cardId: string): Promise<string | null> {
    const marker = starterRoutineMarker(cardId);
    const list = await routines.list(companyId);
    for (const routine of list) {
      const detail = await routines.getDetail(routine.id);
      if (detail?.description?.includes(marker)) return routine.id;
    }
    return null;
  }

  async function listForCompany(companyId: string): Promise<StarterCardStatus[]> {
    const state = await pluginStateByKey();
    const out: StarterCardStatus[] = [];
    for (const card of STARTER_CARDS) {
      const blockers = blockersFor(card, state);
      out.push({
        card,
        ready: blockers.length === 0,
        fixable: blockers.length > 0 && blockers.every((b) => b.kind === "disabled"),
        blockers,
        existingRoutineId: await existingRoutineIdFor(companyId, card.id),
      });
    }
    return out;
  }

  /**
   * Pick who the routine should be assigned to. Preference order: the CEO
   * (who can delegate onward), then any officer, then anything idle. A
   * routine with no assignee is created paused, because an unassigned
   * routine that looks active is exactly the silent no-op this design is
   * meant to eliminate.
   */
  async function pickAssignee(companyId: string): Promise<string | null> {
    const roster = await db
      .select({ id: agents.id, role: agents.role, status: agents.status })
      .from(agents)
      .where(eq(agents.companyId, companyId));
    const usable = roster.filter((a) => a.status !== "terminated" && a.status !== "paused");
    return (
      usable.find((a) => a.role === "ceo")?.id ??
      usable.find((a) => ["coo", "cmo", "cto", "cfo"].includes(a.role))?.id ??
      usable[0]?.id ??
      null
    );
  }

  async function activate(
    companyId: string,
    cardId: string,
    actor: Actor,
  ): Promise<StarterActivationResult> {
    const card = findStarterCard(cardId);
    if (!card) throw notFound(`No starter card '${cardId}'`);

    const steps: StarterActivationStep[] = [];
    const existing = await existingRoutineIdFor(companyId, cardId);
    if (existing) {
      throw unprocessable(
        "This is already switched on for this company — open it from the Routines page to change or remove it.",
      );
    }

    // 1. Turn on what we can, and refuse honestly on what we can't.
    const state = await pluginStateByKey();
    const blockers = blockersFor(card, state);
    for (const blocker of blockers) {
      if (blocker.kind === "missing") {
        throw unprocessable(
          `"${card.title}" needs the ${blocker.pluginKey} extension, which isn't installed. ` +
            `Install it from the Plugins page and then switch this on — it won't do anything without it.`,
        );
      }
      const record = state.get(blocker.pluginKey);
      if (!record || !deps.enablePlugin) {
        throw unprocessable(`Could not switch on ${blocker.pluginKey} automatically.`);
      }
      try {
        await deps.enablePlugin(record.id);
        steps.push({
          step: "enable-plugin",
          ok: true,
          detail: `Switched on ${blocker.pluginKey}`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        steps.push({ step: "enable-plugin", ok: false, detail: `${blocker.pluginKey}: ${message}` });
        throw unprocessable(`Could not switch on ${blocker.pluginKey}: ${message}`);
      }
    }
    if (blockers.length === 0) {
      steps.push({
        step: "check-requirements",
        ok: true,
        detail:
          card.requiresPlugins.length > 0
            ? `Already connected: ${card.requiresPlugins.join(", ")}`
            : "Nothing to connect",
      });
    }

    // 2. Create the routine, assigned to somebody who can actually run it.
    const assigneeAgentId = await pickAssignee(companyId);
    const routine = await routines.create(
      companyId,
      {
        title: card.routine.title,
        description: `${card.routine.description}\n\n${starterRoutineMarker(card.id)}`,
        assigneeAgentId,
        priority: card.routine.priority,
        // No assignee means nothing would pick this up; leave it paused and
        // say so, rather than showing an "active" routine that never runs.
        status: assigneeAgentId ? "active" : "paused",
        // Skip a tick rather than pile up if one run is still going, and don't
        // replay missed ticks after downtime — a routine that catches up on a
        // week of missed mornings would fire seven of the same job at once.
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [],
      },
      { agentId: null, userId: actor.userId ?? null },
    );
    steps.push({
      step: "create-routine",
      ok: true,
      detail: assigneeAgentId
        ? `Created "${card.routine.title}"`
        : `Created "${card.routine.title}" — paused, because this company has no agent to run it`,
    });

    // 3. Put it on the schedule.
    await routines.createTrigger(
      routine.id,
      {
        kind: "schedule",
        cronExpression: card.routine.cron,
        timezone: card.routine.timezone,
        label: card.when,
        enabled: true,
      },
      { agentId: null, userId: actor.userId ?? null },
    );
    steps.push({ step: "schedule", ok: true, detail: card.when });

    // 4. Run it once now. This is the part that turns "I switched something
    //    on" into "I can see it working", and it is the acceptance test for
    //    this whole feature.
    let runId: string | null = null;
    if (assigneeAgentId) {
      try {
        const run = await routines.runRoutine(
          routine.id,
          { source: "manual" },
          { userId: actor.userId ?? null },
        );
        runId = (run as { id?: string } | null)?.id ?? null;
        steps.push({ step: "first-run", ok: true, detail: "Started its first run now" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err, companyId, cardId }, "starter card first run failed");
        steps.push({
          step: "first-run",
          ok: false,
          detail: `Set up, but the first run could not start: ${message}`,
        });
      }
    } else {
      steps.push({
        step: "first-run",
        ok: false,
        detail: "Skipped — no agent in this company to run it",
      });
    }

    return {
      cardId: card.id,
      routineId: routine.id,
      runId,
      steps,
      ranOnce: runId !== null,
    };
  }

  return { listForCompany, activate };
}
