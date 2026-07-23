export function extractProviderId(modelId: string): string | null {
  const trimmed = modelId.trim();
  if (!trimmed.includes("/")) return null;
  const provider = trimmed.slice(0, trimmed.indexOf("/")).trim();
  return provider || null;
}

export function extractProviderIdWithFallback(modelId: string, fallback = "other"): string {
  return extractProviderId(modelId) ?? fallback;
}

export function extractModelName(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed.includes("/")) return trimmed;
  return trimmed.slice(trimmed.indexOf("/") + 1).trim();
}

// Adapter-routed model ids encode as `adapter:<adapterType>:<modelId>`.
// Strip the prefix so a model picker shows the plain model name; the adapter
// source is rendered separately as a "via X" hint.
export function formatDraftModelLabel(modelId: string): string {
  if (!modelId.startsWith("adapter:")) return modelId;
  const rest = modelId.slice("adapter:".length);
  const sep = rest.indexOf(":");
  return sep > 0 ? rest.slice(sep + 1) : modelId;
}
