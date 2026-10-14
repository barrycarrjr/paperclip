import type { AdapterModelUsage, UsageSummary } from "./types.js";

const tokens = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;

/** All-or-nothing validation avoids attributing a partial or malformed report. */
export function readModelUsage(value: unknown): Record<string, AdapterModelUsage> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 64) return null;
  const result: Record<string, AdapterModelUsage> = Object.create(null);
  for (const [model, item] of entries) {
    if (!model.trim() || model.length > 200 || /[\x00-\x1f\x7f]/.test(model) || !item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (!tokens(row.inputTokens) || !tokens(row.outputTokens) || !tokens(row.cachedInputTokens)
      || !tokens(row.cacheCreationInputTokens) || typeof row.costUsd !== "number" || !Number.isFinite(row.costUsd) || row.costUsd < 0) return null;
    result[model] = { inputTokens: row.inputTokens, outputTokens: row.outputTokens, cachedInputTokens: row.cachedInputTokens,
      cacheCreationInputTokens: row.cacheCreationInputTokens, costUsd: row.costUsd };
  }
  const total = sumModelUsage(result);
  if (![total.inputTokens, total.outputTokens, total.cachedInputTokens].every(tokens)
    || !Number.isFinite(Object.values(result).reduce((sum, row) => sum + row.costUsd, 0))) return null;
  return result;
}

export function sumModelUsage(map: Record<string, AdapterModelUsage>): UsageSummary {
  // Cache writes are consumed input; retain their separate provider count in the map.
  return Object.values(map).reduce((sum, row) => ({ inputTokens: sum.inputTokens + row.inputTokens + row.cacheCreationInputTokens,
    outputTokens: sum.outputTokens + row.outputTokens, cachedInputTokens: (sum.cachedInputTokens ?? 0) + (row.cachedInputTokens ?? 0) }),
  { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
}

/** Largest-remainder allocation preserves the aggregate bill's rounded cents. */
export function allocateModelCostCents(map: Record<string, AdapterModelUsage>, totalCents: number): Record<string, number> | null {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0 || totalCents > 2_147_483_647) return null;
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const entries = Object.entries(map).sort(([a], [b]) => compare(a, b));
  const weight = entries.reduce((sum, [, row]) => sum + row.costUsd, 0);
  if (totalCents > 0 && !(weight > 0)) return null;
  const result: Record<string, number> = Object.create(null);
  const fractions = entries.map(([model, row]) => {
    const share = weight > 0 ? row.costUsd / weight * totalCents : 0;
    result[model] = Math.floor(share);
    return { model, remainder: share - result[model]! };
  }).sort((a, b) => b.remainder - a.remainder || compare(a.model, b.model));
  const left = totalCents - Object.values(result).reduce((sum, value) => sum + value, 0);
  for (let i = 0; i < left; i++) result[fractions[i % fractions.length]!.model]!++;
  return result;
}
