import { useQuery } from "@tanstack/react-query";
import {
  AGENT_PERMISSION_DEFAULT_ADAPTER_TYPES,
  AGENT_PERMISSION_LEGACY_CONFIG_KEYS,
  isAgentPermissionDefaultAdapterType,
  readAgentOwnSkipPermissions,
  resolveAgentSkipPermissions,
  type AgentPermissionDefaultAdapterType,
  type AgentPermissionSource,
  type SkipPermissionsByAdapterType,
} from "@paperclipai/shared";
import { companiesApi } from "@/api/companies";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { getAdapterLabel } from "@/adapters/adapter-display-registry";
import type { AdapterConfigFieldsProps } from "@/adapters/types";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { Field } from "./agent-config-primitives";

const selectClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm";

const SOURCE_LABELS: Record<AgentPermissionSource, string> = {
  agent: "set on this agent",
  company: "company default",
  instance: "instance default",
  code: "built-in default",
};

export function describeRunPermission(value: boolean): string {
  return value ? "On (skips permission prompts)" : "Off (asks for permission)";
}

export function describeRunPermissionSource(source: AgentPermissionSource): string {
  return SOURCE_LABELS[source];
}

type TriState = "" | "on" | "off";

function toTriState(value: boolean | null | undefined): TriState {
  if (value === true) return "on";
  if (value === false) return "off";
  return "";
}

function fromTriState(value: string): boolean | null {
  if (value === "on") return true;
  if (value === "off") return false;
  return null;
}

/** Company and instance defaults, for showing what an agent would inherit. */
export function useAgentPermissionDefaults(companyId: string | null | undefined) {
  const instanceQuery = useQuery({
    queryKey: queryKeys.instance.agentDefaults,
    queryFn: () => instanceSettingsApi.getAgentDefaults(),
  });
  const companyQuery = useQuery({
    queryKey: companyId ? queryKeys.companies.agentDefaults(companyId) : ["companies", "none", "agent-defaults"],
    queryFn: () => companiesApi.getAgentDefaults(companyId!),
    enabled: Boolean(companyId),
  });
  return {
    instanceDefaults: instanceQuery.data ?? null,
    companyDefaults: companyQuery.data ?? null,
    isLoading: instanceQuery.isLoading || companyQuery.isLoading,
  };
}

/**
 * One select per supported adapter type: inherit, on or off. Used on the
 * instance Agent defaults page and in company settings.
 */
export function RunPermissionDefaultsEditor({
  values,
  inherited,
  inheritedLabel,
  onChange,
  disabled,
  testIdPrefix,
}: {
  values: SkipPermissionsByAdapterType;
  /** What an unset entry falls back to, per adapter type. */
  inherited: (adapterType: AgentPermissionDefaultAdapterType) => { value: boolean; source: AgentPermissionSource };
  inheritedLabel: string;
  onChange: (adapterType: AgentPermissionDefaultAdapterType, value: boolean | null) => void;
  disabled?: boolean;
  testIdPrefix: string;
}) {
  return (
    <div className="space-y-3">
      {AGENT_PERMISSION_DEFAULT_ADAPTER_TYPES.map((adapterType) => {
        const fallback = inherited(adapterType);
        return (
          <Field key={adapterType} label={getAdapterLabel(adapterType)}>
            <select
              className={selectClass}
              data-testid={`${testIdPrefix}-${adapterType}`}
              value={toTriState(values[adapterType])}
              disabled={disabled}
              onChange={(event) => onChange(adapterType, fromTriState(event.target.value))}
            >
              <option value="">
                {inheritedLabel}: {fallback.value ? "On" : "Off"} ({describeRunPermissionSource(fallback.source)})
              </option>
              <option value="on">{describeRunPermission(true)}</option>
              <option value="off">{describeRunPermission(false)}</option>
            </select>
          </Field>
        );
      })}
    </div>
  );
}

/**
 * The agent's own "skip permissions" setting, with a "use default" choice
 * that clears the stored value so the agent inherits.
 */
export function RunPermissionField({
  label,
  hint,
  configKey,
  createValueKey,
  props,
}: {
  label: string;
  hint: string;
  /** adapterConfig key this adapter reads. */
  configKey: string;
  /** CreateConfigValues key used in create mode. */
  createValueKey: "dangerouslySkipPermissions" | "dangerouslyBypassSandbox";
  props: AdapterConfigFieldsProps;
}) {
  const { isCreate, adapterType, values, set, config, eff, mark } = props;
  const { selectedCompanyId } = useCompany();
  const { companyDefaults, instanceDefaults } = useAgentPermissionDefaults(selectedCompanyId);
  if (!isAgentPermissionDefaultAdapterType(adapterType)) return null;

  const legacyKeys = AGENT_PERMISSION_LEGACY_CONFIG_KEYS[adapterType] ?? [];
  const ownValue = isCreate
    ? (typeof values?.[createValueKey] === "boolean" ? (values[createValueKey] as boolean) : null)
    : readAgentOwnSkipPermissions(
        adapterType,
        Object.fromEntries(
          [configKey, ...legacyKeys].map((key) => [key, eff("adapterConfig", key, config[key])]),
        ),
      );
  const inherited = resolveAgentSkipPermissions({
    adapterType,
    adapterConfig: {},
    companyDefaults,
    instanceDefaults,
  });
  const effective = ownValue ?? inherited?.skipPermissions ?? true;
  const source: AgentPermissionSource = ownValue !== null ? "agent" : (inherited?.source ?? "code");

  const handleChange = (raw: string) => {
    const next = fromTriState(raw);
    if (isCreate) {
      set!({ [createValueKey]: next ?? undefined });
      return;
    }
    // undefined drops the key on save, so the agent inherits again.
    mark("adapterConfig", configKey, next ?? undefined);
    for (const key of legacyKeys) mark("adapterConfig", key, undefined);
  };

  return (
    <Field label={label} hint={hint}>
      <select
        className={selectClass}
        data-testid="agent-run-permission-select"
        value={toTriState(ownValue)}
        onChange={(event) => handleChange(event.target.value)}
      >
        <option value="">
          Use default: {inherited?.skipPermissions ? "On" : "Off"} ({describeRunPermissionSource(inherited?.source ?? "code")})
        </option>
        <option value="on">{describeRunPermission(true)}</option>
        <option value="off">{describeRunPermission(false)}</option>
      </select>
      <p className="mt-1 text-xs text-muted-foreground" data-testid="agent-run-permission-effective">
        Effective: {effective ? "On" : "Off"}, {describeRunPermissionSource(source)}.
      </p>
    </Field>
  );
}
