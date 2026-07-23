import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AvailableModel } from "../api/chat";
import { formatDraftModelLabel } from "../lib/model-utils";

interface DraftModelSelectProps {
  /** Model id, or "" to let the server auto-pick. */
  value: string;
  onChange: (model: string) => void;
  models: AvailableModel[];
}

/** Model picker for the AI Draft button. Shared by the IMAP composer and the
 *  Help Scout composer so both offer the same list and the same "Auto" default. */
export function DraftModelSelect({ value, onChange, models }: DraftModelSelectProps) {
  return (
    <Select
      value={value || "__auto__"}
      onValueChange={(v) => onChange(v === "__auto__" ? "" : v)}
    >
      <SelectTrigger
        size="sm"
        className="h-8 w-auto max-w-[180px] gap-1 px-2 text-xs"
        title="Model used for AI Draft"
      >
        <SelectValue placeholder="Auto" />
      </SelectTrigger>
      <SelectContent align="end" className="max-h-72">
        <SelectItem value="__auto__">Auto (server picks)</SelectItem>
        {models.length === 0 ? (
          <SelectItem value="__none__" disabled>
            No models available
          </SelectItem>
        ) : (
          models.map((m) => (
            <SelectItem key={`${m.provider}:${m.model}:${m.source ?? ""}`} value={m.model}>
              <span className="font-mono">{formatDraftModelLabel(m.model)}</span>
              {m.source ? (
                <span className="ml-2 text-[10px] text-muted-foreground">via {m.source}</span>
              ) : null}
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  );
}
