import { DEFAULT_CODEX_LOCAL_MODEL } from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";
import type { ModelListEntry } from "@paperclipai/shared";

/**
 * Adapters whose agents start with a model filled in, and the built-in model
 * to use when the provider's own list is not available. Every other adapter
 * starts on its own default, which is an empty model.
 */
const BUILT_IN_DEFAULT_MODELS: Readonly<Record<string, string>> = {
  codex_local: DEFAULT_CODEX_LOCAL_MODEL,
  gemini_local: DEFAULT_GEMINI_LOCAL_MODEL,
  cursor: DEFAULT_CURSOR_LOCAL_MODEL,
};

/**
 * The model to fill in when an agent is set up on this adapter: the provider's
 * own default once its list has loaded, otherwise the built-in one. Empty for
 * adapters that pick their own model.
 *
 * The built-in ids go stale (new Codex agents were being pinned to a model
 * Codex had stopped offering), so they are only the fallback.
 */
export function defaultModelForAdapter(
  adapterType: string,
  models?: readonly ModelListEntry[] | null,
): string {
  const builtIn = BUILT_IN_DEFAULT_MODELS[adapterType];
  if (builtIn === undefined) return "";
  const listed = models?.find((m) => m.isDefault && (m.status ?? "current") === "current");
  return listed?.id ?? builtIn;
}
