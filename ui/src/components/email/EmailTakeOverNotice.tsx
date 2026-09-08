import { AlertTriangle, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { takeOverOutcomeMessage } from "@/lib/email-agent-holds";
import type { TakeOverHandoffResult } from "@/api/emailHandoffs";

/**
 * What happened when a person took a message back, kept on screen.
 *
 * Deliberately not a toast. The moment a take over lands, the message stops
 * being held and the panel that started it disappears, so a message that
 * faded after a few seconds could take a real warning with it: "the agent's
 * run could not be stopped" is exactly the thing a person must not miss.
 * This stays until it is dismissed.
 */
export function EmailTakeOverNotice({
  result,
  agentName,
  onDismiss,
}: {
  result: TakeOverHandoffResult;
  agentName: string;
  onDismiss: () => void;
}) {
  const message = takeOverOutcomeMessage(result, agentName);
  const warning = message.tone === "warning";

  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2 border-b px-3 py-2 text-xs",
        warning
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-border bg-muted/50 text-muted-foreground",
      )}
    >
      {warning ? (
        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      ) : (
        <Check className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      )}
      <div className="flex-1 min-w-0 space-y-1">
        <p className={cn("font-medium", !warning && "text-foreground")}>{message.headline}</p>
        <ul className="space-y-0.5">
          {message.details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="shrink-0"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
