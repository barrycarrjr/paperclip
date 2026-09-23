import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ModelListEntry } from "@paperclipai/shared";
import type { AdapterModel } from "../api/agents";
import { defaultModelForAdapter } from "../lib/model-defaults";
import { queryKeys } from "../lib/queryKeys";

interface AdapterModelDefaultOptions {
  companyId: string | null | undefined;
  /** The adapter the form shows now. */
  adapterType: string;
  /** The model the form holds now. */
  model: string;
  /** That adapter's model list, or undefined while it loads. */
  models: readonly ModelListEntry[] | undefined;
  setModel: (model: string) => void;
}

/**
 * Fills in the model when an agent's adapter changes, and keeps that fill in
 * step with the provider.
 *
 * The returned `fill(adapterType)` gives the best model known right now: the
 * provider's own default when its list is already loaded, otherwise the
 * built-in one. When the list was not loaded yet, the provider's default is
 * swapped in as soon as it arrives, unless somebody chose a model meanwhile.
 * Without that second step a new Codex agent kept whichever built-in id was
 * current when this UI was built.
 */
export function useAdapterModelDefault({
  companyId,
  adapterType,
  model,
  models,
  setModel,
}: AdapterModelDefaultOptions): (adapterType: string) => string {
  const queryClient = useQueryClient();
  const pending = useRef<{ adapterType: string; model: string } | null>(null);

  const fill = useCallback(
    (nextType: string) => {
      const cached = companyId
        ? queryClient.getQueryData<AdapterModel[]>(queryKeys.agents.adapterModels(companyId, nextType))
        : undefined;
      const filled = defaultModelForAdapter(nextType, cached);
      pending.current = filled && !cached?.length ? { adapterType: nextType, model: filled } : null;
      return filled;
    },
    [companyId, queryClient],
  );

  useEffect(() => {
    const waiting = pending.current;
    if (!waiting) return;
    if (waiting.adapterType !== adapterType || waiting.model !== model) {
      // The adapter changed again, or a person picked a model: leave it be.
      pending.current = null;
      return;
    }
    if (!models || models.length === 0) return;
    pending.current = null;
    const preferred = defaultModelForAdapter(adapterType, models);
    if (preferred && preferred !== model) setModel(preferred);
  }, [adapterType, model, models, setModel]);

  return fill;
}
