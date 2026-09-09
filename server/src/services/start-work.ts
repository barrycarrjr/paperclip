/**
 * Plain-language "Start work" (P5b): turn what an operator typed into a
 * reviewable plan.
 *
 * The operator types what they want done. This service asks one AI model
 * for a short list of tasks, checks every line of that answer against what
 * this company can actually run (its usable agents, its installed and
 * running plugins), and writes exactly two rows: one container issue for the
 * request (status backlog, nobody assigned, so nothing wakes) and one
 * pending suggest_tasks card hanging off it. Nothing else exists until a
 * board user accepts the card through the ordinary interaction routes.
 *
 * Fail-closed is the rule throughout. No AI call happens without a usable
 * agent; no row is written without a usable plan; a task the company cannot
 * run is shown under "Left out" rather than trusted to the model's word.
 */

import { and, desc, eq, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, companies, issues } from "@paperclipai/db";
import {
  MAX_START_WORK_TASKS,
  START_WORK_ORIGIN_KIND,
  STARTER_CARDS,
  searchStarterCards,
  startWorkInteractionIdempotencyKey,
  startWorkPlannerOutputSchema,
  stripDashes,
  type StartWorkPlanRequest,
  type StartWorkPlanResponse,
  type StartWorkPlannerOutput,
  type SuggestTasksInteraction,
} from "@paperclipai/shared";
import { HttpError, notFound, serviceUnavailable, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { budgetService } from "./budgets.js";
import { pickOneShotModel } from "./chat-providers.js";
import { instanceSettingsService } from "./instance-settings.js";
import { issueService } from "./issues.js";
import {
  buildTaskCreationOrder,
  issueThreadInteractionService,
} from "./issue-thread-interactions.js";
import { completeOnce, OneShotJsonError, parseJsonObject } from "./llm-one-shot.js";
import { routineService } from "./routines.js";
import {
  blockersForPlugins,
  pickAssigneeForCompany,
  pluginStateByKey,
  UNASSIGNABLE_AGENT_STATUSES,
  type PluginStateByKey,
} from "./starter-catalog.js";

export const START_WORK_REQUEST_CONSTRAINT = "issues_start_work_request_uq";

/** Wording shared by the container description and the "existing" lookup that strips it back off. */
const CONTAINER_DESCRIPTION_FOOTER =
  "\n\nAsked for in plain words by a board user. The accepted plan appears as this issue's child tasks.";

const NO_AGENT_MESSAGE =
  "This company has no agent to do the work. Add an agent first, then try again.";
const NO_MODEL_MESSAGE =
  "No AI model is set up yet, so a plan cannot be drafted. Add one under Instance settings, then try again. Nothing was created.";
const UNUSABLE_PLAN_MESSAGE =
  "Could not turn that into a plan. Try saying it a different way, with the outcome you want. Nothing was created.";
const TOO_MANY_PLANS_MESSAGE =
  "You have asked for a lot of plans in a short time. Wait a few minutes and try again. Nothing was created.";

/**
 * Activity log actions this service writes.
 *
 * `plan_requested` is written before the model is called, so a person
 * running up the instance's AI bill is visible in the log even when every
 * draft then fails. `planned` is written inside the same transaction as the
 * plan itself and carries the header facts a retry has to be able to repeat
 * (see storedPlanNotes).
 */
const PLAN_REQUESTED_ACTION = "issue.start_work.plan_requested";
const PLAN_NOTES_ACTION = "issue.start_work.planned";

/**
 * A cheap ceiling on how many fresh plans one person may ask one company
 * for. Each draft is up to two AI calls charged to the instance, not to any
 * agent's budget, so without this any member with write access can spend
 * without limit. Kept in memory on purpose: it is a speed bump against a
 * script, not accounting, and real metering stays deferred as the spec says.
 * Repeats of a requestKey never reach it, because they never call the model.
 */
const PLAN_LIMIT_PER_WINDOW = 10;
const PLAN_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const planDraftTimes = new Map<string, number[]>();

function assertPlanRateLimit(companyId: string, userId: string): void {
  const key = `${companyId}:${userId}`;
  const now = Date.now();
  const recent = (planDraftTimes.get(key) ?? []).filter((at) => now - at < PLAN_LIMIT_WINDOW_MS);
  if (recent.length >= PLAN_LIMIT_PER_WINDOW) {
    planDraftTimes.set(key, recent);
    throw new HttpError(429, TOO_MANY_PLANS_MESSAGE);
  }
  recent.push(now);
  planDraftTimes.set(key, recent);
}

type Actor = { userId: string };

/**
 * The header facts that are not reconstructable from the stored card: which
 * tasks were left out and why, and whether the request sounded like a
 * recurring job. Written with the plan, read back when the same requestKey
 * is sent again, so a retry after a browser timeout shows the same header
 * as the first answer did.
 */
type StoredPlanNotes = {
  leftOut: StartWorkPlanResponse["leftOut"];
  soundsRecurring: boolean;
  recurringNote: string | null;
};

const EMPTY_PLAN_NOTES: StoredPlanNotes = { leftOut: [], soundsRecurring: false, recurringNote: null };

/** Defensive read: an old or hand edited row degrades to a blank header, never a crash. */
function readPlanNotes(details: unknown): StoredPlanNotes {
  if (!details || typeof details !== "object") return EMPTY_PLAN_NOTES;
  const plan = (details as Record<string, unknown>).plan;
  if (!plan || typeof plan !== "object") return EMPTY_PLAN_NOTES;
  const raw = plan as Record<string, unknown>;
  const leftOut = Array.isArray(raw.leftOut)
    ? raw.leftOut.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const { title, reason } = entry as Record<string, unknown>;
      if (typeof title !== "string" || typeof reason !== "string" || !title || !reason) return [];
      return [{ title, reason }];
    })
    : [];
  return {
    leftOut,
    soundsRecurring: raw.soundsRecurring === true,
    recurringNote: typeof raw.recurringNote === "string" ? raw.recurringNote : null,
  };
}

type RosterAgent = {
  id: string;
  name: string;
  role: string;
  title: string | null;
  capabilities: string | null;
};

type PayloadTask = SuggestTasksInteraction["payload"]["tasks"][number];

export type StartWorkPlanResult = StartWorkPlanResponse & {
  /** `existing` when the requestKey already had a container; the route answers 200 instead of 201. */
  status: "created" | "existing";
};

/**
 * Concurrent submits of the same request collapse onto one promise, so a
 * double Enter or a retried request in the same process never runs the
 * planner twice. Cross-process repeats are caught by the database index.
 */
const inflight = new Map<string, Promise<StartWorkPlanResult>>();

function firstLineOf(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ?? text.trim();
}

/** Hard cut, no ellipsis: the limits here are column and schema limits, not display ones. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max).trimEnd();
}

/**
 * The identifier column is nullable in the schema, but issueService.create
 * always allocates one; a null here would be a corrupt row, not a case.
 */
function identifierOf(row: { id: string; identifier: string | null }): string {
  if (!row.identifier) throw new Error(`start work: issue ${row.id} has no identifier`);
  return row.identifier;
}

function containerTitleFor(text: string): string {
  return truncate(`Request: ${firstLineOf(text)}`, 200);
}

/** Recursively applies the no-dash rule to every string in the model's answer. */
function stripDashesDeep(value: unknown): unknown {
  if (typeof value === "string") return stripDashes(value);
  if (Array.isArray(value)) return value.map(stripDashesDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, stripDashesDeep(entry)]),
    );
  }
  return value;
}

function isStartWorkRequestConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const err = error as { code?: string; constraint?: string; constraint_name?: string; cause?: unknown };
  const constraint = err.constraint ?? err.constraint_name;
  if (err.code === "23505" && constraint === START_WORK_REQUEST_CONSTRAINT) return true;
  // drizzle can wrap the driver error; the pg fields then sit on `cause`.
  return err.cause !== undefined && err.cause !== error && isStartWorkRequestConflict(err.cause);
}

/**
 * The parent rules the accept path will apply, run on the model's own
 * answer so a typo in a parentClientKey is quoted back to it and repaired,
 * rather than surfacing as an internal sentence the operator cannot act on.
 * Returns null when the shape is fine, or the problem in the same "field:
 * what is wrong" form the schema errors use.
 */
export function plannerParentProblem(output: StartWorkPlannerOutput): string | null {
  const keys = new Set(output.tasks.map((task) => task.clientKey));

  const unknown = output.tasks.filter(
    (task) => task.parentClientKey && !keys.has(task.parentClientKey),
  );
  if (unknown.length > 0) {
    return unknown
      .map((task) =>
        `tasks.${task.clientKey}.parentClientKey: no task in this plan has clientKey "${task.parentClientKey}". `
        + "Use the clientKey of another task in this plan, or null.")
      .join("\n");
  }

  // Every parent exists by now, so any failure to reach a top level task is
  // a loop: t1 under t2 under t1. Accept refuses those, so the model gets
  // its one chance to break the loop instead.
  const parentOf = new Map(output.tasks.map((task) => [task.clientKey, task.parentClientKey ?? null] as const));
  const settled = new Set<string>();
  const looping = new Set<string>();
  for (const task of output.tasks) {
    const seen = new Set<string>();
    let current: string | null = task.clientKey;
    while (current && !settled.has(current)) {
      if (seen.has(current)) {
        for (const key of seen) looping.add(key);
        break;
      }
      seen.add(current);
      current = parentOf.get(current) ?? null;
    }
    if (looping.size === 0) for (const key of seen) settled.add(key);
  }
  if (looping.size > 0) {
    return `tasks.parentClientKey: these tasks sit under each other in a loop (${[...looping].sort().join(", ")}), `
      + "so none of them can be created. Give at least one of them parentClientKey null.";
  }

  return null;
}

export interface PlannerContext {
  companyName: string;
  text: string;
  roster: RosterAgent[];
  readyPluginKeys: string[];
  routineTitles: string[];
  starterCards: Array<{ id: string; title: string; requiresPlugins: string[]; ready: boolean }>;
  matchedCardIds: string[];
}

/**
 * What the model is told. Only this company's facts, and only the ones it
 * needs to assign owners and to avoid proposing work the company cannot run
 * or already runs. Open issues and other companies are deliberately absent.
 */
export function buildPlannerPrompt(context: PlannerContext): { system: string; user: string } {
  const system = [
    "You draft a short work plan for a small business from a request typed by its owner.",
    "Return ONLY a JSON object. No prose, no markdown fence, nothing before or after the JSON.",
    "",
    "Shape:",
    "{",
    '  "summary": string (at most 1000 characters, plain words, what the plan achieves),',
    '  "soundsRecurring": boolean (true when the request sounds like something to repeat on a schedule),',
    '  "recurringNote": string or null (one short line, at most 300 characters, only when soundsRecurring is true),',
    '  "tasks": [',
    "    {",
    '      "clientKey": string (short unique key such as "t1"),',
    '      "parentClientKey": string or null (the clientKey of a task this one belongs under, or null),',
    '      "title": string (at most 240 characters, an outcome someone can act on),',
    '      "why": string (at most 2000 characters, what to do and why it matters),',
    '      "priority": "urgent" | "high" | "medium" | "low" | null,',
    '      "assigneeAgentId": string (the id of one agent from the roster),',
    '      "needsPlugins": string[] (plugin keys from the ready list this task cannot run without; empty when none)',
    "    }",
    "  ]",
    "}",
    "",
    "Rules:",
    `1. At most ${MAX_START_WORK_TASKS} tasks. If more work is needed, fold the rest into the summary as later items.`,
    "2. Every task names one agent from the roster by its id. Pick the agent whose role, title or capabilities fit best.",
    "3. needsPlugins may only contain keys from the ready plugin list. Never invent a plugin key.",
    "4. If the request already matches an existing routine or a starter card, say so in the summary and do not add a task that duplicates it.",
    "5. Never use an em dash or an en dash anywhere. Use commas, full stops or parentheses instead.",
    "6. Write in plain everyday words the business owner would use. No jargon.",
    "7. clientKey values must be unique within the plan, and parentClientKey must name a task in this same plan or be null.",
  ].join("\n");

  const user = [
    `Company: ${context.companyName}`,
    "",
    "Request from the owner, in their own words:",
    "<<<",
    context.text,
    ">>>",
    "",
    "Agents you may assign work to (roster):",
    JSON.stringify(context.roster, null, 2),
    "",
    "Plugins installed and ready (the only plugin keys allowed in needsPlugins):",
    JSON.stringify(context.readyPluginKeys),
    "",
    "Routines this company already runs (do not duplicate; mention instead):",
    JSON.stringify(context.routineTitles),
    "",
    "Ready-made starter cards (do not duplicate; mention instead):",
    JSON.stringify(context.starterCards, null, 2),
    "",
    context.matchedCardIds.length > 0
      ? `Starter cards whose wording matches this request: ${JSON.stringify(context.matchedCardIds)}`
      : "No starter card matches this request.",
  ].join("\n");

  return { system, user };
}

export function startWorkService(db: Db) {
  const interactions = issueThreadInteractionService(db);

  async function findContainer(companyId: string, requestKey: string) {
    return db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        description: issues.description,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, START_WORK_ORIGIN_KIND),
          eq(issues.originId, requestKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function loadCompany(companyId: string) {
    const company = await db
      .select({ name: companies.name, isPortfolioRoot: companies.isPortfolioRoot })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company) throw notFound("Company not found");
    return company;
  }

  /**
   * The same filter pickAssigneeForCompany applies, from the same list:
   * paused, terminated and pending approval agents never do work. Offering
   * one of the last two would draft a plan that accept then refuses with a
   * 409 nobody can act on.
   */
  async function usableRoster(companyId: string): Promise<RosterAgent[]> {
    return db
      .select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
        title: agents.title,
        capabilities: agents.capabilities,
      })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), notInArray(agents.status, [...UNASSIGNABLE_AGENT_STATUSES])));
  }

  async function budgetWarnings(companyId: string, tasks: PayloadTask[], roster: RosterAgent[]) {
    const budgets = budgetService(db);
    const nameById = new Map(roster.map((agent) => [agent.id, agent.name] as const));
    const warnings: StartWorkPlanResponse["warnings"] = [];
    const assigneeIds = [...new Set(tasks.map((task) => task.assigneeAgentId).filter((id): id is string => Boolean(id)))];
    for (const agentId of assigneeIds) {
      const block = await budgets.getInvocationBlock(companyId, agentId);
      if (block) {
        warnings.push({ agentId, agentName: nameById.get(agentId) ?? block.scopeName, reason: block.reason });
      }
    }
    return warnings;
  }

  /**
   * The header facts for a plan that already exists, read back from the
   * activity row written in the same transaction as the plan.
   *
   * Why the activity log and not a column: the two jsonb columns on
   * issue_thread_interactions are both spoken for. `payload` is parsed with
   * suggestTasksPayloadSchema on every read, which strips anything not in
   * that schema, so an extra field there would be silently dropped; `result`
   * is what the accept and reject paths write and is parsed the same way, so
   * a pending card must not carry one. The issues table has no free form
   * metadata column either (its jsonb columns all belong to the execution
   * engine, and a truthy executionState changes how recovery treats a row).
   * activity_log.details is already a free form jsonb record that nothing
   * else parses, it is already indexed by (entity_type, entity_id) for
   * exactly this lookup, and this service already writes a row per plan. So
   * this needs no schema change and borrows no column from its real owner.
   */
  async function storedPlanNotes(containerId: string): Promise<StoredPlanNotes> {
    const row = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.action, PLAN_NOTES_ACTION),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, containerId),
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return readPlanNotes(row?.details ?? null);
  }

  /**
   * A repeated requestKey never runs the planner again. The stored card is
   * the plan, whatever state it is in now (pending, accepted or rejected),
   * so a retry after a reject hands back the rejected plan rather than a
   * fresh draft. The left-out list and the recurring note come back from the
   * plan's activity row, so the header reads the same as it did the first
   * time; only the model name is deliberately blank, because this answer did
   * not call a model.
   */
  async function findExisting(companyId: string, requestKey: string): Promise<StartWorkPlanResult | null> {
    const container = await findContainer(companyId, requestKey);
    if (!container) return null;

    const idempotencyKey = startWorkInteractionIdempotencyKey(requestKey);
    const cards = (await interactions.listForIssue(container.id)).filter(
      (row): row is SuggestTasksInteraction => row.kind === "suggest_tasks",
    );
    const interaction = cards.find((row) => row.idempotencyKey === idempotencyKey) ?? cards[0] ?? null;
    if (!interaction) {
      // Both rows are written in one transaction, so this is corruption, not
      // a race. Say so rather than drafting a second plan onto the row.
      throw unprocessable(`Request ${container.identifier} has no plan card. Open it and add the work by hand.`);
    }

    const [company, lead, roster, general, notes] = await Promise.all([
      loadCompany(companyId),
      pickAssigneeForCompany(db, companyId),
      usableRoster(companyId),
      instanceSettingsService(db).getGeneral(),
      storedPlanNotes(container.id),
    ]);
    const originalText = (container.description ?? "").replace(CONTAINER_DESCRIPTION_FOOTER, "");

    return {
      status: "existing",
      issue: { id: container.id, identifier: identifierOf(container), title: container.title },
      interaction,
      lead,
      leftOut: notes.leftOut,
      warnings: await budgetWarnings(companyId, interaction.payload.tasks, roster),
      notes: {
        soundsRecurring: notes.soundsRecurring,
        recurringNote: notes.recurringNote,
        companyName: company.name,
        isPortfolioRoot: company.isPortfolioRoot,
      },
      guardrails: { outboundHold: general.outboundToolDraftMode },
      planner: { modelUsed: null },
      matchedCards: searchStarterCards(originalText).map((card) => card.id),
    };
  }

  /**
   * One model call, one repair round. The repair round quotes the model its
   * own answer and the exact problems with it; a second unusable answer is
   * refused rather than guessed at.
   *
   * "Problems" covers the schema and the parent rules alike, so a made up
   * parentClientKey or a loop gets the same one repair chance rule 7 of the
   * prompt promises, instead of failing later with wording written for
   * developers.
   */
  async function draftWithModel(
    model: string,
    prompt: { system: string; user: string },
    actor: Actor,
  ): Promise<StartWorkPlannerOutput> {
    let content = prompt.user;
    let lastProblem: string | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reply = await completeOnce({
        model,
        system: prompt.system,
        content,
        callerLabel: "start-work-planner",
        boardUserId: actor.userId,
      });
      let problem: string;
      try {
        const cleaned = stripDashesDeep(parseJsonObject(reply.text));
        const parsed = startWorkPlannerOutputSchema.safeParse(cleaned);
        if (parsed.success) {
          const parentProblem = plannerParentProblem(parsed.data);
          if (!parentProblem) return parsed.data;
          problem = parentProblem;
        } else {
          problem = parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("\n");
        }
      } catch (err) {
        if (!(err instanceof OneShotJsonError)) throw err;
        problem = err.message;
      }
      lastProblem = problem;
      content = [
        prompt.user,
        "",
        "Your previous answer could not be used. It was:",
        "<<<",
        reply.text,
        ">>>",
        "",
        "Problems:",
        problem,
        "",
        "Return only the corrected JSON object.",
      ].join("\n");
    }
    logger.warn({ model, problem: lastProblem }, "start work: planner output unusable after one repair round");
    throw unprocessable(UNUSABLE_PLAN_MESSAGE);
  }

  /**
   * Turns the model's answer into a suggest_tasks payload the company can
   * really run. Only the whitelisted fields survive, every assignee is from
   * the usable roster, and any task needing a plugin that is not installed
   * and running is moved to leftOut with the same words the starter cards
   * use. The reviewer is only ever shown tasks that would actually start.
   */
  async function normalisePlan(
    companyId: string,
    output: StartWorkPlannerOutput,
    roster: RosterAgent[],
    pluginState: PluginStateByKey,
  ): Promise<{ tasks: PayloadTask[]; leftOut: StartWorkPlanResponse["leftOut"] }> {
    const rosterIds = new Set(roster.map((agent) => agent.id));
    const leftOut: StartWorkPlanResponse["leftOut"] = [];
    const leftOutKeys = new Set<string>();
    const missingPluginKeys = new Set<string>();
    let fallback: { id: string; name: string } | null | undefined;

    const kept: PayloadTask[] = [];
    for (const task of output.tasks.slice(0, MAX_START_WORK_TASKS)) {
      const blockers = blockersForPlugins(task.needsPlugins, pluginState);
      if (blockers.length > 0) {
        leftOut.push({ title: task.title, reason: blockers.map((b) => b.detail).join(", ") });
        leftOutKeys.add(task.clientKey);
        for (const blocker of blockers) missingPluginKeys.add(blocker.pluginKey);
        continue;
      }

      let assigneeAgentId = task.assigneeAgentId;
      if (!assigneeAgentId || !rosterIds.has(assigneeAgentId)) {
        if (fallback === undefined) fallback = await pickAssigneeForCompany(db, companyId);
        if (!fallback) throw unprocessable(NO_AGENT_MESSAGE);
        logger.info(
          { companyId, clientKey: task.clientKey, proposed: task.assigneeAgentId, replacement: fallback.id },
          "start work: planner named an agent outside the usable roster; replaced with the company lead",
        );
        assigneeAgentId = fallback.id;
      }

      kept.push({
        clientKey: task.clientKey,
        parentClientKey: task.parentClientKey ?? null,
        title: task.title,
        description: task.why,
        priority: task.priority ?? "medium",
        assigneeAgentId,
      });
    }

    if (kept.length === 0) {
      throw unprocessable(
        `Everything in that plan needs a plugin that is not ready: ${[...missingPluginKeys].join(", ")}. Install it on the Plugins page first.`,
      );
    }

    // A task whose parent was left out is still real work; it moves up to
    // sit directly under the request rather than sinking the whole plan.
    for (const task of kept) {
      if (task.parentClientKey && leftOutKeys.has(task.parentClientKey)) {
        task.parentClientKey = null;
      }
    }

    // Same cycle and unknown-parent rules accept will apply, run now so the
    // reviewer is never shown a plan that would fail the moment they accept.
    // draftWithModel already gave the model its repair round on these, so
    // anything left here is the model failing twice, not an operator
    // mistake: it gets the same plain sentence every other unusable answer
    // gets, never buildTaskCreationOrder's own developer wording.
    try {
      buildTaskCreationOrder(kept);
    } catch (err) {
      logger.warn(
        { companyId, err: err instanceof Error ? err.message : String(err) },
        "start work: normalised plan still fails the task order rules",
      );
      throw unprocessable(UNUSABLE_PLAN_MESSAGE);
    }

    return { tasks: kept, leftOut };
  }

  async function draft(companyId: string, input: StartWorkPlanRequest, actor: Actor): Promise<StartWorkPlanResult> {
    // Only genuinely new requests reach here, so this counts drafts, not
    // retries of one.
    assertPlanRateLimit(companyId, actor.userId);

    const roster = await usableRoster(companyId);
    if (roster.length === 0) throw unprocessable(NO_AGENT_MESSAGE);

    const model = await pickOneShotModel();
    if (!model) throw serviceUnavailable(NO_MODEL_MESSAGE);

    const [company, pluginState, routines] = await Promise.all([
      loadCompany(companyId),
      pluginStateByKey(db),
      routineService(db).list(companyId),
    ]);
    const readyPluginKeys = [...pluginState.entries()]
      .filter(([, state]) => state.status === "ready")
      .map(([key]) => key)
      .sort();
    const matchedCardIds = searchStarterCards(input.text).map((card) => card.id);
    const prompt = buildPlannerPrompt({
      companyName: company.name,
      text: input.text,
      roster,
      readyPluginKeys,
      routineTitles: routines.map((routine) => routine.title),
      starterCards: STARTER_CARDS.map((card) => ({
        id: card.id,
        title: card.title,
        requiresPlugins: card.requiresPlugins,
        ready: blockersForPlugins(card.requiresPlugins, pluginState).length === 0,
      })),
      matchedCardIds,
    });

    // Written before the model is called, so someone driving this route hard
    // shows up in the activity log even when every draft then fails.
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actor.userId,
      action: PLAN_REQUESTED_ACTION,
      entityType: "company",
      entityId: companyId,
      details: {
        source: "start_work",
        requestKey: input.requestKey,
        model,
        requestLength: input.text.length,
      },
    });

    const output = await draftWithModel(model, prompt, actor);
    const { tasks, leftOut } = await normalisePlan(companyId, output, roster, pluginState);
    const warnings = await budgetWarnings(companyId, tasks, roster);

    const firstLine = firstLineOf(input.text);
    const summary = truncate(
      `Drafted by ${model}. ${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}.`
        + (leftOut.length > 0
          ? ` Left out because a plugin is not ready: ${leftOut.map((entry) => entry.title).join(", ")}.`
          : ""),
      1000,
    );

    let written: { container: { id: string; identifier: string; title: string }; interaction: SuggestTasksInteraction };
    try {
      written = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const container = await issueService(txDb).create(companyId, {
          title: containerTitleFor(input.text),
          description: `${input.text}${CONTAINER_DESCRIPTION_FOOTER}`,
          status: "backlog",
          priority: "medium",
          originKind: START_WORK_ORIGIN_KIND,
          originId: input.requestKey,
          createdByUserId: actor.userId,
        });
        // The footer names the request so an agent reading one child task
        // alone can find the whole ask; the identifier only exists now.
        const identifier = identifierOf(container);
        const footer = `\n\nFrom the request "${firstLine}" (${identifier}).`;
        const interaction = await issueThreadInteractionService(txDb).create(
          { id: container.id, companyId },
          {
            kind: "suggest_tasks",
            idempotencyKey: startWorkInteractionIdempotencyKey(input.requestKey),
            title: truncate(`Plan for: ${firstLine}`, 240),
            summary,
            continuationPolicy: "wake_assignee_on_accept",
            payload: {
              version: 1,
              tasks: tasks.map((task) => ({ ...task, description: `${task.description}${footer}` })),
            },
          },
          { userId: actor.userId },
        );
        if (interaction.kind !== "suggest_tasks") {
          throw new Error("start work: created interaction is not a suggest_tasks card");
        }
        // Same transaction as the plan, so a stored plan always has its
        // header facts and a rolled back one leaves none behind. Written
        // straight to the table rather than through logActivity because
        // this row is read back verbatim by storedPlanNotes, and because
        // its live event would otherwise fire before the commit.
        await txDb.insert(activityLog).values({
          companyId,
          actorType: "user",
          actorId: actor.userId,
          action: PLAN_NOTES_ACTION,
          entityType: "issue",
          entityId: container.id,
          details: {
            source: "start_work",
            requestKey: input.requestKey,
            modelUsed: model,
            plan: {
              leftOut,
              soundsRecurring: output.soundsRecurring,
              recurringNote: output.soundsRecurring ? output.recurringNote : null,
            },
          },
        });
        return {
          container: { id: container.id, identifier, title: container.title },
          interaction,
        };
      });
    } catch (err) {
      // Another process got there first (two tabs, a retried request on a
      // second server). The transaction rolled back; hand back theirs.
      if (isStartWorkRequestConflict(err)) {
        const existing = await findExisting(companyId, input.requestKey);
        if (existing) return existing;
      }
      throw err;
    }

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actor.userId,
      action: "issue.thread_interaction_created",
      entityType: "issue",
      entityId: written.container.id,
      details: {
        source: "start_work",
        interactionId: written.interaction.id,
        interactionKind: written.interaction.kind,
        interactionStatus: written.interaction.status,
        continuationPolicy: written.interaction.continuationPolicy,
        modelUsed: model,
        taskCount: tasks.length,
        leftOutCount: leftOut.length,
      },
    });

    const [lead, general] = await Promise.all([
      pickAssigneeForCompany(db, companyId),
      instanceSettingsService(db).getGeneral(),
    ]);

    return {
      status: "created",
      issue: written.container,
      interaction: written.interaction,
      lead,
      leftOut,
      warnings,
      notes: {
        soundsRecurring: output.soundsRecurring,
        recurringNote: output.soundsRecurring ? output.recurringNote : null,
        companyName: company.name,
        isPortfolioRoot: company.isPortfolioRoot,
      },
      guardrails: { outboundHold: general.outboundToolDraftMode },
      planner: { modelUsed: model },
      matchedCards: matchedCardIds,
    };
  }

  return {
    /**
     * Draft a plan for one typed request, or hand back the plan that request
     * already has. `companyId` is the route parameter; the body never names
     * a company.
     */
    plan: async (companyId: string, input: StartWorkPlanRequest, actor: Actor): Promise<StartWorkPlanResult> => {
      const existing = await findExisting(companyId, input.requestKey);
      if (existing) return existing;

      const key = `${companyId}:${input.requestKey}`;
      const running = inflight.get(key);
      if (running) return running;

      const promise = draft(companyId, input, actor).finally(() => {
        inflight.delete(key);
      });
      inflight.set(key, promise);
      return promise;
    },
  };
}
