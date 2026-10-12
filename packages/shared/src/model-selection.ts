import { z } from "zod";
import { ISSUE_PRIORITIES, type IssuePriority } from "./constants.js";

/**
 * Automatic model selection: an agent can let Paperclip pick the model for a
 * run on a task from signals already on the task (its labels and priority),
 * within a list of models the operator allows for that agent. Stored on the
 * agent as `runtimeConfig.modelSelection`. Off unless `enabled` is true.
 */

export const RUN_MODEL_SOURCES = ["manual", "rule", "fallback", "agent-default"] as const;
export type RunModelSource = (typeof RUN_MODEL_SOURCES)[number];

export const MODEL_SELECTION_MAX_MODELS = 20;
export const MODEL_SELECTION_MAX_RULES = 20;

export interface ModelSelectionRule {
  /** Matches a task carrying any of these labels (by name, any case). */
  labels?: string[];
  /** Matches a task whose priority is any of these. */
  priorities?: IssuePriority[];
  model: string;
}

export interface AgentModelSelection {
  enabled: boolean;
  allowedModels: string[];
  /** Checked in order; the first rule whose conditions all hold wins. */
  rules: ModelSelectionRule[];
  /** Used when no rule matches. Unset means the agent's own model. */
  fallbackModel?: string | null;
}

export interface RunModelChoice {
  /** Null when nothing names a model and the adapter picks its own. */
  model: string | null;
  source: RunModelSource;
  reason: string;
}

const modelIdSchema = z.string().trim().min(1).max(200);

export const modelSelectionRuleSchema = z.object({
  labels: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  priorities: z.array(z.enum(ISSUE_PRIORITIES)).max(ISSUE_PRIORITIES.length).optional(),
  model: modelIdSchema,
}).strict().refine(
  (rule) => (rule.labels?.length ?? 0) > 0 || (rule.priorities?.length ?? 0) > 0,
  { message: "A rule needs at least one label or priority" },
);

export const agentModelSelectionSchema = z.object({
  enabled: z.boolean(),
  allowedModels: z.array(modelIdSchema).max(MODEL_SELECTION_MAX_MODELS),
  rules: z.array(modelSelectionRuleSchema).max(MODEL_SELECTION_MAX_RULES),
  fallbackModel: modelIdSchema.nullable().optional(),
}).strict().superRefine((value, ctx) => {
  const allowed = new Set(value.allowedModels);
  if (value.enabled && allowed.size === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allowedModels"],
      message: "Allow at least one model to turn automatic model selection on",
    });
  }
  value.rules.forEach((rule, index) => {
    if (!allowed.has(rule.model)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rules", index, "model"],
        message: `Rule ${index + 1} uses "${rule.model}", which is not in the allowed models`,
      });
    }
  });
  if (value.fallbackModel && !allowed.has(value.fallbackModel)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["fallbackModel"],
      message: `Fallback model "${value.fallbackModel}" is not in the allowed models`,
    });
  }
});

/** Reads a stored setting, or null when it is missing, malformed or off. */
export function readEnabledModelSelection(raw: unknown): AgentModelSelection | null {
  const parsed = agentModelSelectionSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.enabled) return null;
  return parsed.data;
}

export interface ChooseRunModelInput {
  /** The agent's `runtimeConfig.modelSelection`, as stored. */
  selection: unknown;
  /** A model set on the task itself (the new-issue dialog override). */
  manualModel: string | null;
  /** The model the agent would use anyway, after instance defaults. */
  agentModel: string | null;
  /** Signals from the task the run is for; null for a run with no task. */
  task: { labels: string[]; priority: string | null } | null;
}

export function chooseRunModel(input: ChooseRunModelInput): RunModelChoice {
  if (input.manualModel) {
    return { model: input.manualModel, source: "manual", reason: "Model set on this task" };
  }
  const agentDefault: RunModelChoice = {
    model: input.agentModel,
    source: "agent-default",
    reason: input.agentModel ? "Agent's configured model" : "Adapter's default model",
  };
  const selection = readEnabledModelSelection(input.selection);
  if (!selection) return agentDefault;
  if (!input.task) {
    return { ...agentDefault, reason: `${agentDefault.reason}; run has no task to apply rules to` };
  }

  const allowed = new Set(selection.allowedModels);
  const taskLabels = new Set(input.task.labels.map(normalizeLabel));
  for (const [index, rule] of selection.rules.entries()) {
    if (!allowed.has(rule.model)) continue;
    const match = matchRule(rule, taskLabels, input.task.priority);
    if (match) {
      return { model: rule.model, source: "rule", reason: `${match} matched rule ${index + 1}` };
    }
  }
  return chooseFallback(selection, input.agentModel);
}

function chooseFallback(selection: AgentModelSelection, agentModel: string | null): RunModelChoice {
  const allowed = new Set(selection.allowedModels);
  if (selection.fallbackModel && allowed.has(selection.fallbackModel)) {
    return { model: selection.fallbackModel, source: "fallback", reason: "No rule matched; fallback model" };
  }
  if (agentModel && allowed.has(agentModel)) {
    return { model: agentModel, source: "fallback", reason: "No rule matched; agent's configured model" };
  }
  return {
    model: selection.allowedModels[0]!,
    source: "fallback",
    reason: "No rule matched and the agent's model is not allowed; first allowed model",
  };
}

/** Describes what matched (e.g. "label `legal`"), or null when the rule does not apply. */
function matchRule(
  rule: ModelSelectionRule,
  taskLabels: Set<string>,
  taskPriority: string | null,
): string | null {
  const parts: string[] = [];
  if (rule.labels && rule.labels.length > 0) {
    const label = rule.labels.find((candidate) => taskLabels.has(normalizeLabel(candidate)));
    if (!label) return null;
    parts.push(`label \`${label}\``);
  }
  if (rule.priorities && rule.priorities.length > 0) {
    if (!taskPriority || !rule.priorities.includes(taskPriority as IssuePriority)) return null;
    parts.push(`priority \`${taskPriority}\``);
  }
  return parts.length > 0 ? parts.join(" and ") : null;
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}
