import { useMemo } from "react";
import type { AvailableModel } from "../api/chat";
import { chatModelEntry } from "../lib/model-display";
import { formatDraftModelLabel } from "../lib/model-utils";
import { ModelPicker } from "./ModelPicker";

interface DraftModelSelectProps {
  /** Model id, or "" to let the server auto-pick. */
  value: string;
  onChange: (model: string) => void;
  models: AvailableModel[];
}

/** Model picker for the AI Draft button. Shared by the IMAP composer and the
 *  Help Scout composer so both offer the same list and the same "Auto" default. */
export function DraftModelSelect({ value, onChange, models }: DraftModelSelectProps) {
  const entries = useMemo(
    () =>
      models.map((m) => ({
        ...chatModelEntry(m),
        ...(m.source ? { hint: `via ${m.source}` } : {}),
      })),
    [models],
  );
  return (
    <ModelPicker
      models={entries}
      value={value}
      onChange={onChange}
      emptyOption={{ label: "Auto (server picks)" }}
      emptyMessage="No models available"
      describeValue={(id) => ({ label: formatDraftModelLabel(id) })}
      appearance="select"
      align="end"
      triggerClassName="h-8 w-auto max-w-[180px] gap-1 px-2 text-xs"
      triggerTitle="Model used for AI Draft"
      aria-label="Model used for AI Draft"
    />
  );
}
