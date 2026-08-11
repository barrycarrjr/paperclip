import { api } from "./client";
import type { StarterCard } from "@paperclipai/shared";

export interface StarterBlocker {
  pluginKey: string;
  kind: "missing" | "disabled";
  detail: string;
}

export interface StarterCardStatus {
  card: StarterCard;
  ready: boolean;
  /** Blocked only by plugins we can switch on ourselves. */
  fixable: boolean;
  blockers: StarterBlocker[];
  existingRoutineId: string | null;
}

export interface StarterCategory {
  id: string;
  title: string;
  blurb: string;
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
  ranOnce: boolean;
}

export const starterCatalogApi = {
  list: (companyId: string) =>
    api.get<{ categories: StarterCategory[]; cards: StarterCardStatus[] }>(
      `/companies/${companyId}/starter-catalog`,
    ),

  search: (companyId: string, query: string) =>
    api.get<{ query: string; matches: StarterCardStatus[] }>(
      `/companies/${companyId}/starter-catalog/search?q=${encodeURIComponent(query)}`,
    ),

  activate: (companyId: string, cardId: string) =>
    api.post<StarterActivationResult>(
      `/companies/${companyId}/starter-catalog/${cardId}/activate`,
      {},
    ),
};
