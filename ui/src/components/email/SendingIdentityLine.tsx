import { AlertTriangle } from "lucide-react";
import type { SendingIdentity } from "./sendingIdentity";
import { cn } from "../../lib/utils";

/**
 * The "From" line at the point of sending. Read-only on purpose: choosing a
 * different sender is done by picking a different mailbox, which is the one
 * place that choice already lives, and a second dropdown here would be a
 * second place for the two to disagree.
 */
export function SendingIdentityLine({
  identity,
  className,
}: {
  identity: SendingIdentity;
  className?: string;
}) {
  return (
    <div className={cn("flex items-baseline gap-2 text-xs", className)} data-testid="sending-identity">
      <span className="font-medium text-muted-foreground">From</span>
      {identity.unknown ? (
        <span className="inline-flex items-center gap-1 text-destructive">
          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
          {identity.label}
        </span>
      ) : (
        <span className={cn("truncate", identity.isAddress ? "text-foreground" : "text-muted-foreground")}>
          {identity.label}
          {!identity.isAddress && (
            <span className="ml-1 opacity-70">(no sending address configured for this mailbox)</span>
          )}
        </span>
      )}
    </div>
  );
}
