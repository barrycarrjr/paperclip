import { and, inArray, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import type { AdapterModel } from "../adapters/types.js";
import { refreshAdapterModels } from "../adapters/registry.js";
import { fetchLiveOllamaModels, fetchLiveAiderModels } from "../adapters/ollama-models.js";
import { fetchLiveGeminiModels } from "../adapters/gemini-models.js";
import { agentService } from "./agents.js";
import { logActivity } from "./activity-log.js";
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
 * models actually pulled, and Gemini reports the models the key can call plus
 * the "auto" picker. claude_local and codex_local are deliberately absent: the
 * CLI's model ids and the provider's list-endpoint ids can legitimately differ
 * (aliases, dated snapshots), so auto-pausing on a mismatch would produce false
 * alarms. Claude is validated on demand through its probe instead.
 */
type LiveModelFetcher = () => Promise<AdapterModel[] | null>;
const DETECTION_FETCHERS: Record<string, LiveModelFetcher> = {
  ollama_local: () => fetchLiveOllamaModels(),
  aider_local: () => fetchLiveAiderModels(),
  gemini_local: () => fetchLiveGeminiModels(),
};

/** Agents in these states are not eligible to run, so we leave them alone. */
const NON_RUNNABLE_STATUSES = ["paused", "terminated", "pending_approval"];

export interface VanishedModelFlag {
  agentId: string;
  companyId: string;
  adapterType: string;
  model: string;
}

export interface DailyModelRefreshResult {
  refreshed: Array<{ adapterType: string; count: number }>;
  paused: VanishedModelFlag[];
  /** Adapter types whose live list couldn't be determined this run (skipped). */
  indeterminate: string[];
}

function readConfiguredModel(adapterConfig: unknown): string {
  if (typeof adapterConfig !== "object" || adapterConfig === null || Array.isArray(adapterConfig)) return "";
  const model = (adapterConfig as Record<string, unknown>).model;
  return typeof model === "string" ? model.trim() : "";
}

export function adapterModelRefreshService(db: Db) {
  const agentsSvc = agentService(db);

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
    const availableByType = new Map<string, Set<string> | null>();
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
        availableByType.set(type, new Set(live.map((m) => m.id)));
      }
    }

    for (const row of rows) {
      const available = availableByType.get(row.adapterType);
      // A null list means we couldn't authoritatively check this adapter; never auto-pause.
      if (!available) continue;
      const model = readConfiguredModel(row.adapterConfig);
      // Empty model means "use the adapter default", which can't have vanished.
      if (!model) continue;
      if (available.has(model)) continue;

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
            availableModelCount: available.size,
          },
        });
        paused.push({ agentId: row.id, companyId: row.companyId, adapterType: row.adapterType, model });
      } catch (err) {
        logger.warn({ err, agentId: row.id, adapterType: row.adapterType, model }, "failed to pause agent whose model vanished");
      }
    }
    return { paused, indeterminate };
  }

  async function runDailyRefresh(): Promise<DailyModelRefreshResult> {
    const refreshed = await refreshMenus();
    const { paused, indeterminate } = await detectVanishedModels();
    return { refreshed, paused, indeterminate };
  }

  return { runDailyRefresh, refreshMenus, detectVanishedModels };
}
