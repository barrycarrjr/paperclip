import { useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { findModelInList } from "@paperclipai/shared";
import { chatApi, type AvailableModel } from "../api/chat";
import { chatModelEntry } from "../lib/model-display";

const STORAGE_KEY = "email-draftModel";

// Only set when the browser refuses to store the pick (private browsing, a full
// quota). The choice then still holds for the rest of the session instead of
// snapping back to Auto.
let unsaved: string | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readDraftModel(): string {
  if (unsaved !== null) return unsaved;
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveDraftModel(model: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, model);
    unsaved = null;
  } catch {
    unsaved = model;
  }
  for (const listener of listeners) listener();
}

/**
 * The saved pick, if the loaded list still offers it, as the list names it
 * (a pick saved as `x[1m]` or as a dated snapshot matches its listed model).
 * Otherwise "", so the server picks. That includes the time before the list
 * has loaded: a pick saved on an earlier visit can name a model the providers
 * have since dropped, and a draft must never go out on one of those.
 */
export function resolveDraftModel(saved: string, models: readonly AvailableModel[] | undefined): string {
  if (!saved || !models) return "";
  return findModelInList(models.map(chatModelEntry), saved)?.id ?? "";
}

/**
 * The model the AI Draft button uses, and the list to pick it from. An empty
 * string means "let the server pick".
 *
 * The Email page and the email pop-out both draft replies, and the pop-out
 * stays mounted underneath the page the whole time. Holding the pick in each
 * one's own state would freeze the pop-out on whatever was saved when the page
 * loaded, so a model chosen in the page's composer would not be the one the
 * pop-out drafted with. One store, read by both, keeps them the same.
 *
 * A saved pick the list no longer has is ignored rather than erased, so it
 * comes back by itself if the provider lists that model again.
 */
export function useDraftModel() {
  const savedModel = useSyncExternalStore(subscribe, readDraftModel, readDraftModel);
  const { data } = useQuery({
    queryKey: ["email", "draftModels"],
    queryFn: () => chatApi.listModels().then((r) => r.models),
    staleTime: 5 * 60_000,
  });
  const draftModel = useMemo(() => resolveDraftModel(savedModel, data), [savedModel, data]);
  return { draftModel, setDraftModel: saveDraftModel, draftModels: data ?? [] };
}
