import { PauseCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RunFailureCause } from "@paperclipai/shared";

/**
 * What is actually wrong with this run, and what the operator can do about it.
 *
 * Before this, a failed run showed a red chip, a Retry button and, further down
 * the page, whatever fix panel happened to apply. The operator's words for it
 * were: "it's not clear what I should do, it doesn't feel like I can do
 * anything other than click Retry, but what if I don't want to retry?" - and
 * for an expired login, Retry was the one action guaranteed not to work. Each
 * press produced another identical failure and another row on his Brief.
 *
 * So the cause is named first, the fix is named next, and the alternatives to
 * retrying are offered here rather than left to be inferred from a button in
 * the page header.
 */
export type PauseState = "available" | "pending" | "paused";

export function RunFailureGuidance({
  cause,
  agentLabel = "This agent",
  pauseState,
  onPause,
}: {
  cause: RunFailureCause;
  /** The agent's name where the page knows it; a plain noun where it does not. */
  agentLabel?: string;
  pauseState: PauseState;
  onPause: () => void;
}) {
  return (
    <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
      <p className="text-sm font-medium">{cause.summarize(agentLabel)}</p>
      <p className="text-xs text-muted-foreground">{cause.fix}</p>
      {cause.retryCannotWork && (
        <p className="text-xs text-muted-foreground">
          Retrying now fails the same way. It is worth doing once the fix is in, not before.
        </p>
      )}
      {pauseState === "paused" ? (
        <p className="text-[11px] text-muted-foreground">
          Paused, so it will not try again until you resume it.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={onPause}
            disabled={pauseState === "pending"}
          >
            <PauseCircle className="mr-1 h-3.5 w-3.5" />
            {pauseState === "pending" ? "Pausing…" : "Pause this agent"}
          </Button>
          <span className="text-[11px] text-muted-foreground">
            Stops it trying again while you sort the fix out.
          </span>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground/90">
        Or leave it: "Seen it, not retrying" on your Brief takes it off your list without stopping
        or changing anything.
      </p>
    </div>
  );
}
