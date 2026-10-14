import { AGENT_DEFAULT_MAX_TURNS_PER_RUN } from "@paperclipai/adapter-utils/run-limits";
import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  ToggleField,
  DraftInput,
  DraftNumberInput,
  help,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";
import { RunPermissionField } from "../../components/RunPermissionDefaults";
import { LocalWorkspaceRuntimeFields } from "../local-workspace-runtime-fields";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Injected into the system prompt at runtime.";

export function ClaudeLocalConfigFields({
  mode,
  isCreate,
  adapterType,
  values,
  set,
  config,
  eff,
  mark,
  models,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  return (
    <>
      {!hideInstructionsFile && (
        <Field label="Agent instructions file" hint={instructionsFileHint}>
          <div className="flex items-center gap-2">
            <DraftInput
              value={
                isCreate
                  ? values!.instructionsFilePath ?? ""
                  : eff(
                      "adapterConfig",
                      "instructionsFilePath",
                      String(config.instructionsFilePath ?? ""),
                    )
              }
              onCommit={(v) =>
                isCreate
                  ? set!({ instructionsFilePath: v })
                  : mark("adapterConfig", "instructionsFilePath", v || undefined)
              }
              immediate
              className={inputClass}
              placeholder="/absolute/path/to/AGENTS.md"
            />
            <ChoosePathButton />
          </div>
        </Field>
      )}
      <LocalWorkspaceRuntimeFields
        isCreate={isCreate}
        values={values}
        set={set}
        config={config}
        mark={mark}
        eff={eff}
        mode={mode}
        adapterType={adapterType}
        models={models}
      />
    </>
  );
}

export function ClaudeLocalAdvancedFields(props: AdapterConfigFieldsProps) {
  const { isCreate, values, set, config, eff, mark } = props;
  return (
    <>
      <Field label="Advisor model" hint="Request a second model for advice. Leave blank to keep advice off for this agent. Accepts a model alias or full id. Experimental availability depends on the account, provider and models. Calls have no separate cap and consume provider usage; run timeout and turn limits still apply.">
        <DraftInput
          aria-label="Advisor model"
          value={isCreate ? values!.advisorModel ?? "" : eff("adapterConfig", "advisorModel", String(config.advisorModel ?? ""))}
          onCommit={(value) => isCreate ? set!({ advisorModel: value.trim() }) : mark("adapterConfig", "advisorModel", value.trim() || undefined)}
          immediate
          className={inputClass}
          placeholder="Off, or a model alias / full id"
          maxLength={200}
        />
      </Field>
      <ToggleField
        label="Enable Chrome"
        hint={help.chrome}
        checked={
          isCreate
            ? values!.chrome
            : eff("adapterConfig", "chrome", config.chrome === true)
        }
        onChange={(v) =>
          isCreate
            ? set!({ chrome: v })
            : mark("adapterConfig", "chrome", v)
        }
      />
      <RunPermissionField
        label="Skip permissions"
        hint={help.dangerouslySkipPermissions}
        configKey="dangerouslySkipPermissions"
        createValueKey="dangerouslySkipPermissions"
        props={props}
      />
      <Field label="Max turns per run" hint={help.maxTurnsPerRun}>
        {isCreate ? (
          <input
            type="number"
            className={inputClass}
            value={values!.maxTurnsPerRun}
            onChange={(e) => set!({ maxTurnsPerRun: Number(e.target.value) })}
          />
        ) : (
          <DraftNumberInput
            value={eff(
              "adapterConfig",
              "maxTurnsPerRun",
              Number(config.maxTurnsPerRun ?? AGENT_DEFAULT_MAX_TURNS_PER_RUN),
            )}
            onCommit={(v) => mark("adapterConfig", "maxTurnsPerRun", v)}
            immediate
            className={inputClass}
          />
        )}
      </Field>
    </>
  );
}
