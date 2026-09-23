import { and, inArray, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { describeSavedModel, findModelInList } from "@paperclipai/shared";
import type { AdapterModel } from "../adapters/types.js";
import { listAdapterModels, refreshAdapterModels } from "../adapters/registry.js";
import { fetchLiveOllamaModels, fetchLiveAiderModels } from "../adapters/ollama-models.js";
import { fetchLiveGeminiModels } from "../adapters/gemini-models.js";
import { fetchLiveCodexModels, getCodexModelAvailability } from "../adapters/codex-models.js";
import { getClaudeModelAvailability } from "../adapters/claude-models.js";
import { agentService } from "./agents.js";
import { logActivity } from "./activity-log.js";
import { refreshModelCatalog } from "./model-catalog.js";
import {
  readModelAvailabilityState,
  writeModelAvailabilityState,
  type ModelAvailabilityState,
} from "./model-availability-state.js";
import { logger } from "../middleware/logger.js";

/**
 * Adapters whose menus we refresh on the daily tick so retired models drop off
 * and new ones appear without anyone editing a list by hand. Refreshing simply
 * re-reads each adapter's live source and warms its cache.
 */
const REFRESH_ADAPTER_TYPES = [
  "ollama_local",
  "aider_local",
  "gemini_local",
  "claude_local",
  "codex_local",
  "opencode_local",
] as const;

/**
 * Live authoritative model source per adapter type. Returns null when the list
 * can't be determined right now (provider unreachable, no credential), so the
 * caller can tell "the model is gone" apart from "I couldn't check".
 *
 * Only adapters that expose an EXACT list are here: Ollama/Aider report the
 * models actually pulled, Gemini reports the models the key can call plus the
 * "auto" picker, and Codex reports every model the account can use, hidden
 * ones included, straight from the Codex CLI. claude_local is deliberately
 * absent: its CLI lists current models only, and older ones still run, so a
 * model missing from that list is flagged (see noteModelChanges), never
 * paused.
 */
type LiveModelFetcher = () => Promise<AdapterModel[] | null>;
const DETECTION_FETCHERS: Record<string, LiveModelFetcher> = {
  ollama_local: () => fetchLiveOllamaModels(),
  aider_local: () => fetchLiveAiderModels(),
  gemini_local: () => fetchLiveGeminiModels(),
  codex_local: () => fetchLiveCodexModels(),
};

interface TrackedList {
  models: AdapterModel[];
  /** Every id the provider accepts, when it accepts more than it shows (Codex's hidden models). */
  acceptedIds?: string[];
  /**
   * Whether a saved model missing from this list is worth a notice. Not when
   * the list leaves out ids the tool still accepts: the Anthropic API list
   * has no `opus` or `sonnet`, which the Claude CLI takes happily.
   */
  reportUnlisted: boolean;
}

/**
 * Lists worth reporting changes from: ones that came from the provider itself,
 * never a built-in fallback, so a new model is announced because it really
 * appeared. Ollama and Aider are left out (a model pulled locally is not a
 * release), and so is OpenCode (it lists every model of every provider it
 * knows, which would bury the feed).
 */
const TRACKED_LISTS: Record<string, () => Promise<TrackedList | null>> = {
  claude_local: async () => {
    const availability = await getClaudeModelAvailability();
    if (availability.source !== "cli" && availability.source !== "api") return null;
    return { models: availability.models, reportUnlisted: availability.source === "cli" };
  },
  codex_local: async () => {
    const availability = await getCodexModelAvailability();
    if (availability.source === "curated") return null;
    return {
      models: availability.models,
      acceptedIds: availability.allIds ?? undefined,
      reportUnlisted: availability.source === "codex",
    };
  },
  gemini_local: async () =>
    (await fetchLiveGeminiModels()) ? { models: await listAdapterModels("gemini_local"), reportUnlisted: true } : null,
};

/**
 * Environment variables that give an agent a sign-in of its own. Such an agent
 * may see different models from the account the daily check asks with, so a
 * model missing from that account's list proves nothing about it.
 */
const OWN_SIGN_IN_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CODEX_API_KEY",
  "CODEX_HOME",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
];

/** True when the agent signs in its own way or runs its own copy of the tool. */
function usesOwnSignIn(adapterConfig: unknown): boolean {
  if (typeof adapterConfig !== "object" || adapterConfig === null || Array.isArray(adapterConfig)) return false;
  const config = adapterConfig as Record<string, unknown>;
  if (typeof config.command === "string" && config.command.trim().length > 0) return true;
  const env = config.env;
  if (typeof env !== "object" || env === null || Array.isArray(env)) return false;
  return OWN_SIGN_IN_ENV_KEYS.some((key) => Object.prototype.hasOwnProperty.call(env, key));
}

/** Agents in these states are not eligible to run, so we leave them alone. */
const NON_RUNNABLE_STATUSES = ["paused", "terminated", "pending_approval"];

export interface VanishedModelFlag {
  agentId: string;
  companyId: string;
  adapterType: string;
  model: string;
}

export interface NewModelAnnouncement {
  adapterType: string;
  model: string;
  label: string;
  companyIds: string[];
}

export interface AgentModelFlag {
  agentId: string;
  companyId: string;
  adapterType: string;
  model: string;
  state: "legacy" | "retiring" | "unavailable";
  replacement: string | null;
}

export interface DailyModelRefreshResult {
  refreshed: Array<{ adapterType: string; count: number }>;
  paused: VanishedModelFlag[];
  /** Adapter types whose live list couldn't be determined this run (skipped). */
  indeterminate: string[];
  announced: NewModelAnnouncement[];
  flagged: AgentModelFlag[];
}

export interface ModelAvailabilityStateStore {
  read(): Promise<ModelAvailabilityState>;
  write(state: ModelAvailabilityState): Promise<void>;
}

const fileStateStore: ModelAvailabilityStateStore = {
  read: () => readModelAvailabilityState(),
  write: (state) => writeModelAvailabilityState(state),
};

function readConfiguredModel(adapterConfig: unknown): string {
  if (typeof adapterConfig !== "object" || adapterConfig === null || Array.isArray(adapterConfig)) return "";
  const model = (adapterConfig as Record<string, unknown>).model;
  return typeof model === "string" ? model.trim() : "";
}

function formatDay(iso: string | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

export function adapterModelRefreshService(db: Db, opts: { stateStore?: ModelAvailabilityStateStore } = {}) {
  const agentsSvc = agentService(db);
  const stateStore = opts.stateStore ?? fileStateStore;

  async function refreshMenus(): Promise<Array<{ adapterType: string; count: number }>> {
    const out: Array<{ adapterType: string; count: number }> = [];
    for (const type of REFRESH_ADAPTER_TYPES) {
      try {
        const models = await refreshAdapterModels(type);
        out.push({ adapterType: type, count: models.length });
      } catch (err) {
        logger.warn({ err, adapterType: type }, "adapter model menu refresh failed");
      }
    }
    return out;
  }

  async function detectVanishedModels(): Promise<{ paused: VanishedModelFlag[]; indeterminate: string[] }> {
    const paused: VanishedModelFlag[] = [];
    const indeterminate: string[] = [];
    const detectableTypes = Object.keys(DETECTION_FETCHERS);

    const rows = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
      })
      .from(agents)
      .where(
        and(inArray(agents.adapterType, detectableTypes), notInArray(agents.status, NON_RUNNABLE_STATUSES)),
      );
    if (rows.length === 0) return { paused, indeterminate };

    // Resolve each in-use adapter's authoritative list once.
    const availableByType = new Map<string, AdapterModel[] | null>();
    for (const type of detectableTypes) {
      if (!rows.some((r) => r.adapterType === type)) continue;
      let live: AdapterModel[] | null = null;
      try {
        live = await DETECTION_FETCHERS[type]();
      } catch (err) {
        logger.warn({ err, adapterType: type }, "adapter live-model fetch failed during vanished-model detection");
        live = null;
      }
      if (live === null) {
        indeterminate.push(type);
        availableByType.set(type, null);
      } else {
        availableByType.set(type, live);
      }
    }

    for (const row of rows) {
      const available = availableByType.get(row.adapterType);
      // A null list means we couldn't authoritatively check this adapter; never auto-pause.
      if (!available) continue;
      const model = readConfiguredModel(row.adapterConfig);
      // Empty model means "use the adapter default", which can't have vanished.
      if (!model) continue;
      // Codex is checked with one account; an agent with its own sign-in may
      // well have the model. It gets a notice at most, never a pause.
      if (row.adapterType === "codex_local" && usesOwnSignIn(row.adapterConfig)) continue;
      // Loose on purpose: a context suffix or a dated snapshot of a listed
      // model is that model, not a vanished one.
      if (findModelInList(available, model)) continue;

      try {
        await agentsSvc.pause(row.id, "system");
        await logActivity(db, {
          companyId: row.companyId,
          actorType: "system",
          actorId: "adapter-model-refresh",
          action: "agent.model_unavailable",
          entityType: "agent",
          entityId: row.id,
          agentId: row.id,
          details: {
            adapterType: row.adapterType,
            model,
            reason: "The model assigned to this agent is no longer offered by its provider. The agent was paused so it does not fail silently; pick a current model and resume it.",
            availableModelCount: available.length,
          },
        });
        paused.push({ agentId: row.id, companyId: row.companyId, adapterType: row.adapterType, model });
      } catch (err) {
        logger.warn({ err, agentId: row.id, adapterType: row.adapterType, model }, "failed to pause agent whose model vanished");
      }
    }
    return { paused, indeterminate };
  }

  /**
   * Compare each provider's list with what the last check saw: announce
   * models that are new since then, and tell each agent, once, when the model
   * it runs on has been replaced by a newer one, is retiring, or is no longer
   * listed. Nothing is changed on any agent.
   */
  async function noteModelChanges(
    skipAgentIds: ReadonlySet<string> = new Set(),
    now = new Date(),
  ): Promise<{ announced: NewModelAnnouncement[]; flagged: AgentModelFlag[] }> {
    const announced: NewModelAnnouncement[] = [];
    const flagged: AgentModelFlag[] = [];
    const state = await stateStore.read();
    const nowIso = now.toISOString();

    const lists = new Map<string, TrackedList>();
    for (const [type, read] of Object.entries(TRACKED_LISTS)) {
      try {
        const list = await read();
        if (list && list.models.length > 0) lists.set(type, list);
      } catch (err) {
        logger.warn({ err, adapterType: type }, "could not read an adapter's model list for change tracking");
      }
    }
    if (lists.size === 0) return { announced, flagged };

    const rows = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
      })
      .from(agents)
      .where(and(inArray(agents.adapterType, [...lists.keys()]), notInArray(agents.status, ["terminated"])));

    for (const [type, { models }] of lists) {
      const previous = state.adapters[type];
      const seen = previous?.models ?? {};
      const companyIds = [...new Set(rows.filter((r) => r.adapterType === type).map((r) => r.companyId))];
      for (const model of models) {
        const before = seen[model.id];
        seen[model.id] = {
          label: model.label,
          firstSeenAt: before?.firstSeenAt ?? nowIso,
          lastSeenAt: nowIso,
          ...(model.status ? { status: model.status } : {}),
          ...(model.retiresAt ? { retiresAt: model.retiresAt } : {}),
        };
        // The first check only records a baseline: everything would look new.
        if (!previous || before || (model.status ?? "current") !== "current") continue;
        announced.push({ adapterType: type, model: model.id, label: model.label, companyIds });
        for (const companyId of companyIds) {
          await logActivity(db, {
            companyId,
            actorType: "system",
            actorId: "adapter-model-refresh",
            action: "model.available",
            entityType: "company",
            entityId: companyId,
            details: {
              adapterType: type,
              model: model.id,
              label: model.label,
              ...(model.releasedAt ? { releasedAt: model.releasedAt } : {}),
            },
          }).catch((err) => logger.warn({ err, companyId, model: model.id }, "could not log a new-model notice"));
        }
      }
      state.adapters[type] = { checkedAt: nowIso, models: seen };
    }

    for (const row of rows) {
      const list = lists.get(row.adapterType);
      const configured = readConfiguredModel(row.adapterConfig);
      if (!list || skipAgentIds.has(row.id)) continue;
      const saved = describeSavedModel(list.models, configured);
      // "Not listed" is only worth saying when the list is the whole story:
      // not for an agent with its own sign-in, whose account may differ, and
      // not for an id the provider accepts without showing it.
      const unlistedButFine =
        saved.kind === "unavailable" &&
        (!list.reportUnlisted ||
          usesOwnSignIn(row.adapterConfig) ||
          findModelInList((list.acceptedIds ?? []).map((id) => ({ id, label: id })), configured) !== null);
      if (unlistedButFine || (saved.kind !== "legacy" && saved.kind !== "retiring" && saved.kind !== "unavailable")) {
        delete state.agentNotices[row.id];
        continue;
      }
      const key = `${configured}|${saved.kind}`;
      if (state.agentNotices[row.id]?.key === key) continue;
      const current = saved.kind === "unavailable" ? null : saved.model;
      const replacement = saved.replacement;
      const retiresOn = formatDay(current?.retiresAt);
      const reason =
        saved.kind === "retiring"
          ? `${current?.label ?? configured} is retiring${retiresOn ? ` on ${retiresOn}` : ""}.`
          : saved.kind === "legacy"
            ? `${current?.label ?? configured} has been replaced by a newer model.`
            : `${configured} is not in the list of models this provider currently offers.`;
      await logActivity(db, {
        companyId: row.companyId,
        actorType: "system",
        actorId: "adapter-model-refresh",
        action: "agent.model_needs_update",
        entityType: "agent",
        entityId: row.id,
        agentId: row.id,
        details: {
          adapterType: row.adapterType,
          model: configured,
          state: saved.kind,
          reason: replacement ? `${reason} Consider switching to ${replacement.label}.` : reason,
          ...(replacement ? { replacementModel: replacement.id, replacementLabel: replacement.label } : {}),
          ...(current?.retiresAt ? { retiresAt: current.retiresAt } : {}),
          ...(current?.notice ? { notice: current.notice } : {}),
        },
      }).catch((err) => logger.warn({ err, agentId: row.id }, "could not log a model notice for an agent"));
      state.agentNotices[row.id] = { key, notedAt: nowIso };
      flagged.push({
        agentId: row.id,
        companyId: row.companyId,
        adapterType: row.adapterType,
        model: configured,
        state: saved.kind,
        replacement: replacement?.id ?? null,
      });
    }

    await stateStore.write(state);
    return { announced, flagged };
  }

  async function runDailyRefresh(): Promise<DailyModelRefreshResult> {
    // The catalog first, so every list below is marked from today's copy.
    await refreshModelCatalog({ force: true }).catch((err) => {
      logger.warn({ err }, "model catalog refresh failed; lists keep the last good copy");
    });
    const refreshed = await refreshMenus();
    const { paused, indeterminate } = await detectVanishedModels();
    let announced: NewModelAnnouncement[] = [];
    let flagged: AgentModelFlag[] = [];
    try {
      ({ announced, flagged } = await noteModelChanges(new Set(paused.map((p) => p.agentId))));
    } catch (err) {
      logger.warn({ err }, "tracking model changes failed; menus and pauses are unaffected");
    }
    return { refreshed, paused, indeterminate, announced, flagged };
  }

  return { runDailyRefresh, refreshMenus, detectVanishedModels, noteModelChanges };
}
