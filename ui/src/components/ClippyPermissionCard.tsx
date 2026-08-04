import { useState } from "react";
import { ChevronDown, ChevronRight, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { describeChatTool, formatCountdown } from "../lib/clippy-tool-labels";
import { useNowTick } from "../hooks/useNowTick";

interface Props {
  toolName: string;
  input: unknown;
  /** Epoch ms when the server auto-denies this request. */
  expiresAt?: number;
  onApprove: () => void;
  onDeny: () => void;
}

export function ClippyPermissionCard({ toolName, input, expiresAt, onApprove, onDeny }: Props) {
  const [showDetails, setShowDetails] = useState(false);
  const presentation = describeChatTool(toolName, input);
  const now = useNowTick(expiresAt != null);
  const remainingMs = expiresAt != null ? expiresAt - now : null;
  const timedOut = remainingMs != null && remainingMs <= 0;

  return (
    <div className="my-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-900 dark:bg-amber-950/30">
      <div className="mb-1.5 flex items-center gap-1.5 text-amber-900 dark:text-amber-300">
        <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">Clippy wants to: {presentation.label.toLowerCase()}</span>
        <span className="ml-auto shrink-0 rounded-full bg-foreground px-1.5 py-px text-[10px] font-semibold text-background">
          does something real
        </span>
      </div>
      <p className="mb-2 text-foreground">{presentation.sentence}</p>
      <button
        type="button"
        className="mb-2 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        onClick={() => setShowDetails((v) => !v)}
      >
        {showDetails ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        Technical details
      </button>
      {showDetails && (
        <div className="mb-2 space-y-1">
          <div className="font-mono text-[11px] text-muted-foreground">{toolName}</div>
          <pre className="max-h-40 overflow-auto rounded bg-background/60 p-1.5 text-[11px]">
            {JSON.stringify(input, null, 2)}
          </pre>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onApprove} disabled={timedOut}>
          Approve
        </Button>
        <Button size="sm" variant="ghost" onClick={onDeny} disabled={timedOut}>
          Deny
        </Button>
        {remainingMs != null && (
          <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
            {timedOut
              ? "Timed out. Treated as denied."
              : `Cancels itself in ${formatCountdown(remainingMs)} if you don't answer`}
          </span>
        )}
      </div>
    </div>
  );
}
