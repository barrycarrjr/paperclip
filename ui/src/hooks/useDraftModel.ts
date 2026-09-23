import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { chatApi } from "../api/chat";

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
 * The model the AI Draft button uses, and the list to pick it from. An empty
 * string means "let the server pick".
 *
 * The Email page and the email pop-out both draft replies, and the pop-out
 * stays mounted underneath the page the whole time. Holding the pick in each
 * one's own state would freeze the pop-out on whatever was saved when the page
 * loaded, so a model chosen in the page's composer would not be the one the
 * pop-out drafted with. One store, read by both, keeps them the same.
 */
export function useDraftModel() {
  const draftModel = useSyncExternalStore(subscribe, readDraftModel, readDraftModel);
  const { data } = useQuery({
    queryKey: ["email", "draftModels"],
    queryFn: () => chatApi.listModels().then((r) => r.models),
    staleTime: 5 * 60_000,
  });
  return { draftModel, setDraftModel: saveDraftModel, draftModels: data ?? [] };
}
