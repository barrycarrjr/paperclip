import {
  AGENT_ACTION_TYPES,
  AGENT_ACTION_TYPE_DESCRIPTIONS,
  AGENT_ACTION_TYPE_LABELS,
  type AgentActionMode,
  type AgentActionPolicyOverride,
  type AgentActionType,
  type CompanyActionPolicy,
  type EffectiveAgentActionPolicy,
} from "@paperclipai/shared";

type Props =
  | {
      scope: "company";
      policies: CompanyActionPolicy[];
      disabled?: boolean;
      onChange: (actionType: AgentActionType, mode: AgentActionMode) => void;
    }
  | {
      scope: "agent";
      overrides: AgentActionPolicyOverride[];
      effective: EffectiveAgentActionPolicy[];
      disabled?: boolean;
      onChange: (actionType: AgentActionType, mode: AgentActionMode | null) => void;
    };

const modeLabel: Record<AgentActionMode, string> = {
  ask_first: "Ask first",
  go_ahead: "Go ahead",
};

export function ActionPolicyControls(props: Props) {
  return (
    <div className="divide-y divide-border">
      {AGENT_ACTION_TYPES.map((actionType) => {
        const companyPolicy = props.scope === "company"
          ? props.policies.find((policy) => policy.actionType === actionType)
          : null;
        const override = props.scope === "agent"
          ? props.overrides.find((policy) => policy.actionType === actionType)
          : null;
        const effective = props.scope === "agent"
          ? props.effective.find((policy) => policy.actionType === actionType)
          : null;
        const value = props.scope === "company" ? companyPolicy?.mode ?? "ask_first" : override?.mode ?? "";

        return (
          <div key={actionType} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <div className="text-sm">{AGENT_ACTION_TYPE_LABELS[actionType]}</div>
              <p className="text-xs text-muted-foreground">{AGENT_ACTION_TYPE_DESCRIPTIONS[actionType]}</p>
              {effective ? (
                <p className="text-xs text-muted-foreground">
                  Effective: {modeLabel[effective.effectiveMode]}, {effective.source === "agent" ? "agent override" : "company setting"}.
                </p>
              ) : null}
            </div>
            <select
              aria-label={`${AGENT_ACTION_TYPE_LABELS[actionType]} policy`}
              data-testid={`action-policy-${actionType}`}
              className="h-9 min-w-44 rounded-md border border-input bg-background px-3 text-sm"
              value={value}
              disabled={props.disabled}
              onChange={(event) => {
                const mode = event.target.value as AgentActionMode | "";
                if (props.scope === "company") props.onChange(actionType, mode as AgentActionMode);
                else props.onChange(actionType, mode || null);
              }}
            >
              {props.scope === "agent" ? <option value="">Use company setting</option> : null}
              <option value="ask_first">Ask first</option>
              <option value="go_ahead">Go ahead</option>
            </select>
          </div>
        );
      })}
    </div>
  );
}
