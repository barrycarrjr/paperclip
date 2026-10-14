import type { AdapterModelUsage } from "@paperclipai/adapter-utils";
import { readModelUsage, sumModelUsage } from "@paperclipai/adapter-utils/model-usage";
import type { parseClaudeStreamJson } from "./parse.js";

export function combineClaudeUsage(reports: Array<ReturnType<typeof parseClaudeStreamJson>>) {
  const nonempty = reports.filter(report => report.modelUsage || !(report.costUsd === 0
    && report.usage && Object.values(report.usage).every(value => value === 0)
    && ((report.resultJson?.usage as Record<string, unknown> | undefined)?.cache_creation_input_tokens ?? 0) === 0));
  let modelUsage: Record<string, AdapterModelUsage> | null = null;
  if (nonempty.length && nonempty.every(report => report.modelUsage)) {
    const combined: Record<string, AdapterModelUsage> = Object.create(null);
    for (const report of nonempty) for (const [model, row] of Object.entries(report.modelUsage!)) {
      const previous = combined[model] ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0 };
      combined[model] = { inputTokens: previous.inputTokens + row.inputTokens, outputTokens: previous.outputTokens + row.outputTokens,
        cachedInputTokens: previous.cachedInputTokens + row.cachedInputTokens, cacheCreationInputTokens: previous.cacheCreationInputTokens + row.cacheCreationInputTokens,
        costUsd: previous.costUsd + row.costUsd };
    }
    modelUsage = readModelUsage(combined);
  }
  const costs = reports.map(report => report.costUsd ?? (report.modelUsage
    ? Object.values(report.modelUsage).reduce((sum, row) => sum + row.costUsd, 0) : null));
  const total = costs.every(cost => cost !== null) ? costs.reduce<number>((sum, cost) => sum + cost!, 0) : null;
  const knownCosts = costs.filter((cost): cost is number => cost !== null);
  const knownCost = knownCosts.length ? knownCosts.reduce((sum, cost) => sum + cost, 0) : null;
  // Native aggregate usage also belongs to this process, including on resume.
  // When model attribution is incomplete, retain complete aggregate counters.
  const aggregateReports = reports.map(report => {
    if (report.modelUsage) return sumModelUsage(report.modelUsage);
    if (!report.usage) return null;
    const raw = report.resultJson?.usage as Record<string, unknown> | undefined;
    // The legacy parser defaults absent counters to zero. That is not proof of
    // complete consumption for an opted-in run with an incomplete model map.
    const explicitlyEmpty = report.costUsd === 0 && raw && Object.keys(raw).length === 0;
    if (!explicitlyEmpty && (typeof raw?.input_tokens !== "number" || typeof raw?.output_tokens !== "number")) return null;
    const creation = raw?.cache_creation_input_tokens ?? 0;
    const validated = readModelUsage({ aggregate: { inputTokens: explicitlyEmpty ? 0 : raw!.input_tokens,
      outputTokens: explicitlyEmpty ? 0 : raw!.output_tokens, cachedInputTokens: raw?.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: creation, costUsd: 0 } });
    return validated ? sumModelUsage(validated) : null;
  });
  const aggregate = aggregateReports.every(usage => usage !== null) ? aggregateReports.reduce((sum, usage) => ({
    inputTokens: sum.inputTokens + usage!.inputTokens, outputTokens: sum.outputTokens + usage!.outputTokens,
    cachedInputTokens: (sum.cachedInputTokens ?? 0) + (usage!.cachedInputTokens ?? 0),
  }), { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }) : null;
  const validAggregate = aggregate && readModelUsage({ aggregate: { ...aggregate, cacheCreationInputTokens: 0, costUsd: 0 } });
  const knownReports = aggregateReports.filter((usage): usage is NonNullable<typeof usage> => usage !== null);
  const knownAggregate = knownReports.length ? knownReports.reduce((sum, usage) => ({
    inputTokens: sum.inputTokens + usage.inputTokens, outputTokens: sum.outputTokens + usage.outputTokens,
    cachedInputTokens: (sum.cachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0),
  }), { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }) : null;
  const validKnown = knownAggregate && readModelUsage({ aggregate: { ...knownAggregate, cacheCreationInputTokens: 0, costUsd: 0 } });
  return { modelUsage, usage: modelUsage ? sumModelUsage(modelUsage) : validAggregate ? aggregate : null,
    knownUsage: validKnown ? knownAggregate : null,
    costUsd: total !== null && Number.isFinite(total) ? total : null,
    knownCostUsd: knownCost !== null && Number.isFinite(knownCost) ? knownCost : null };
}
