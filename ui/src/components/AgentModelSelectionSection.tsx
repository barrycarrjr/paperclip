import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import {
  ISSUE_PRIORITIES,
  agentModelSelectionSchema,
  type AgentModelSelection,
  type IssuePriority,
  type ModelSelectionRule,
} from "@paperclipai/shared";
import type { AdapterModel } from "../api/agents";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { DraftInput, Field, ToggleField } from "./agent-config-primitives";

const selectClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm";
const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const help = {
  enabled:
    "Pick the model for each run on a task from the task's labels and priority. A model set on the task itself always wins.",
  allowedModels: "The only models selection may use for this agent.",
  rules: "Checked top to bottom; the first rule whose conditions all hold picks the model.",
  fallbackModel: "Used when no rule matches. Runs with no task always use the agent's own model.",
};

/** What the section shows for an agent that has never saved a setting: off, with its own model allowed. */
export function initialModelSelection(agentModel: string): AgentModelSelection {
  return { enabled: false, allowedModels: agentModel ? [agentModel] : [], rules: [], fallbackModel: null };
}

export function AgentModelSelectionSection({
  value,
  onChange,
  models,
  agentModel,
  labelNames,
}: {
  value: AgentModelSelection;
  onChange: (next: AgentModelSelection) => void;
  /** The adapter's model list, used for names and suggestions. */
  models: AdapterModel[];
  /** The agent's own Model setting, the fallback when none is chosen. */
  agentModel: string;
  /** The company's label names, offered as suggestions. */
  labelNames: string[];
}) {
  const problems = useMemo(() => {
    const parsed = agentModelSelectionSchema.safeParse(value);
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
  }, [value]);
  const labelFor = (id: string) => models.find((model) => model.id === id)?.label ?? id;

  function update(patch: Partial<AgentModelSelection>) {
    onChange({ ...value, ...patch });
  }

  function removeAllowedModel(id: string) {
    update({
      allowedModels: value.allowedModels.filter((model) => model !== id),
      fallbackModel: value.fallbackModel === id ? null : value.fallbackModel,
    });
  }

  function updateRule(index: number, patch: Partial<ModelSelectionRule>) {
    update({ rules: value.rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)) });
  }

  function moveRule(index: number, offset: -1 | 1) {
    const rules = [...value.rules];
    const [rule] = rules.splice(index, 1);
    rules.splice(index + offset, 0, rule!);
    update({ rules });
  }

  return (
    <div className="space-y-3" data-testid="agent-model-selection">
      <ToggleField
        label="Pick the model per task"
        hint={help.enabled}
        checked={value.enabled}
        onChange={(enabled) => update({ enabled })}
        toggleTestId="agent-model-selection-toggle"
      />
      {value.enabled && (
        <>
          <Field label="Allowed models" hint={help.allowedModels}>
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {value.allowedModels.length === 0 && (
                  <span className="text-xs text-muted-foreground">No models allowed yet.</span>
                )}
                {value.allowedModels.map((id) => (
                  <span
                    key={id}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-mono"
                  >
                    {labelFor(id)}
                    <button
                      type="button"
                      aria-label={`Remove ${labelFor(id)}`}
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => removeAllowedModel(id)}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
              <AddModelInput
                models={models.filter((model) => !value.allowedModels.includes(model.id))}
                onAdd={(id) => update({ allowedModels: [...value.allowedModels, id] })}
              />
            </div>
          </Field>

          <Field label="Rules" hint={help.rules}>
            <div className="space-y-2">
              {value.rules.map((rule, index) => (
                <RuleRow
                  key={index}
                  index={index}
                  rule={rule}
                  allowedModels={value.allowedModels}
                  labelFor={labelFor}
                  labelNames={labelNames}
                  isFirst={index === 0}
                  isLast={index === value.rules.length - 1}
                  onChange={(patch) => updateRule(index, patch)}
                  onMove={(offset) => moveRule(index, offset)}
                  onRemove={() => update({ rules: value.rules.filter((_, i) => i !== index) })}
                />
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={value.allowedModels.length === 0}
                onClick={() =>
                  update({ rules: [...value.rules, { labels: [], priorities: [], model: value.allowedModels[0]! }] })
                }
              >
                <Plus className="h-3.5 w-3.5 mr-1" /> Add rule
              </Button>
            </div>
          </Field>

          <Field label="When no rule matches" hint={help.fallbackModel}>
            <select
              className={selectClass}
              data-testid="agent-model-selection-fallback"
              value={value.fallbackModel ?? ""}
              onChange={(event) => update({ fallbackModel: event.target.value || null })}
            >
              <option value="">Agent's own model{agentModel ? ` (${labelFor(agentModel)})` : ""}</option>
              {value.allowedModels.map((id) => (
                <option key={id} value={id}>{labelFor(id)}</option>
              ))}
            </select>
          </Field>
        </>
      )}
      {problems.length > 0 && (
        <ul className="text-xs text-destructive space-y-0.5" data-testid="agent-model-selection-problems">
          {problems.map((problem) => <li key={problem}>{problem}</li>)}
        </ul>
      )}
    </div>
  );
}

function AddModelInput({ models, onAdd }: { models: AdapterModel[]; onAdd: (id: string) => void }) {
  const [draft, setDraft] = useState("");
  const listId = "agent-model-selection-model-options";
  function add() {
    const id = draft.trim();
    if (!id) return;
    onAdd(id);
    setDraft("");
  }
  return (
    <div className="flex items-center gap-2">
      <input
        className={inputClass}
        list={listId}
        value={draft}
        placeholder="Add a model"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            add();
          }
        }}
      />
      <datalist id={listId}>
        {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
      </datalist>
      <Button type="button" variant="outline" size="sm" onClick={add} disabled={!draft.trim()}>
        Add
      </Button>
    </div>
  );
}

function RuleRow({
  index,
  rule,
  allowedModels,
  labelFor,
  labelNames,
  isFirst,
  isLast,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  rule: ModelSelectionRule;
  allowedModels: string[];
  labelFor: (id: string) => string;
  labelNames: string[];
  isFirst: boolean;
  isLast: boolean;
  onChange: (patch: Partial<ModelSelectionRule>) => void;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
}) {
  const labelListId = `agent-model-selection-labels-${index}`;
  const priorities = rule.priorities ?? [];
  function togglePriority(priority: IssuePriority) {
    onChange({
      priorities: priorities.includes(priority)
        ? priorities.filter((p) => p !== priority)
        : [...priorities, priority],
    });
  }
  return (
    <div className="rounded-md border border-border p-2.5 space-y-2" data-testid={`agent-model-selection-rule-${index}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">Rule {index + 1}</span>
        <div className="flex items-center gap-0.5">
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Move rule up" disabled={isFirst} onClick={() => onMove(-1)}>
            <ArrowUp className="h-3 w-3" />
          </Button>
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Move rule down" disabled={isLast} onClick={() => onMove(1)}>
            <ArrowDown className="h-3 w-3" />
          </Button>
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Remove rule" onClick={onRemove}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>
      <Field label="Task has any of these labels (comma-separated)">
        <DraftInput
          value={(rule.labels ?? []).join(", ")}
          onCommit={(text) => onChange({ labels: splitLabels(text) })}
          className={inputClass}
          placeholder="legal, research"
          list={labelListId}
        />
        <datalist id={labelListId}>
          {labelNames.map((name) => <option key={name} value={name} />)}
        </datalist>
      </Field>
      <Field label="and its priority is any of">
        <div className="flex flex-wrap gap-1.5">
          {ISSUE_PRIORITIES.map((priority) => (
            <button
              key={priority}
              type="button"
              aria-pressed={priorities.includes(priority)}
              className={cn(
                "rounded-md border px-2 py-0.5 text-xs capitalize transition-colors",
                priorities.includes(priority)
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
              onClick={() => togglePriority(priority)}
            >
              {priority}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Use model">
        <select className={selectClass} value={rule.model} onChange={(event) => onChange({ model: event.target.value })}>
          {!allowedModels.includes(rule.model) && <option value={rule.model}>{labelFor(rule.model)} (not allowed)</option>}
          {allowedModels.map((id) => <option key={id} value={id}>{labelFor(id)}</option>)}
        </select>
      </Field>
    </div>
  );
}

function splitLabels(text: string): string[] {
  return Array.from(new Set(text.split(",").map((part) => part.trim()).filter(Boolean)));
}
