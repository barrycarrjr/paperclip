import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Bot, ExternalLink, Undo2 } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  holdSourceLine,
  holdStageLabel,
  holderName,
} from "@/lib/email-agent-holds";
import {
  emailHandoffsApi,
  type EmailHandoffSummary,
  type TakeOverHandoffResult,
} from "@/api/emailHandoffs";

/**
 * What a message looks like while an agent has it, inside Email.
 *
 * This is the piece Email never had. The handover, the stage it is at and
 * the work it created were all already recorded, and all of it was only
 * visible on the work item's own page, which is not where anyone reading
 * their mail is looking.
 *
 * The panel deliberately does not offer "hand back". That is the agent
 * giving the work up, and it belongs on the work item where the agent's own
 * account of why lives. What a person needs here is the opposite move: to
 * take the message back.
 */

const STAGE_TONE: Record<string, string> = {
  delegated: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30",
  acknowledged: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/30",
  in_progress: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/30",
  needs_review: "bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/30",
};

export function EmailAgentHoldPanel({
  companyId,
  hold,
  onTakenOver,
  showSource = false,
  className,
}: {
  companyId: string;
  hold: EmailHandoffSummary;
  /**
   * Told what actually happened, not just that it worked. The panel is gone
   * a moment later (the message stops being held), so whoever owns the page
   * has to be the one that keeps the outcome on screen.
   */
  onTakenOver: (result: TakeOverHandoffResult, agentName: string) => void;
  /** The "With agents" list shows mail from every folder, so it says where each came from. */
  showSource?: boolean;
  className?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const who = holderName(hold);

  const takeOverMutation = useMutation({
    mutationFn: () =>
      emailHandoffsApi.takeOver(companyId, hold.issueId, hold.id, {
        reason,
        expectedVersion: hold.version,
      }),
    onSuccess: (result) => {
      setError(null);
      setConfirming(false);
      setReason("");
      onTakenOver(result, who);
    },
    onError: (err: unknown) => {
      setError(
        err instanceof Error
          ? err.message
          : "That did not work, and the agent still has the message.",
      );
    },
  });

  const workLabel = hold.issue
    ? `${hold.issue.identifier ?? "the work item"}: ${hold.issue.title}`
    : null;

  return (
    <section
      aria-label="An agent has this message"
      className={cn("rounded-xl border border-border bg-card p-3 space-y-2", className)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Bot className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-medium truncate">With {who}</span>
        </div>
        <span
          className={cn(
            "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium shrink-0",
            STAGE_TONE[hold.status] ?? "bg-muted text-muted-foreground border-border",
          )}
        >
          {holdStageLabel(hold.status)}
        </span>
      </div>

      {showSource && (
        <p className="text-xs text-muted-foreground truncate">{holdSourceLine(hold)}</p>
      )}

      {workLabel ? (
        <Link
          to={`/issues/${hold.issue!.identifier ?? hold.issue!.id}`}
          className="inline-flex items-start gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span className="underline underline-offset-2">{workLabel}</span>
        </Link>
      ) : (
        // Honest rather than blank: the work item can have been deleted, and
        // a missing link should say why there is nothing to click.
        <p className="text-xs text-muted-foreground">
          The work this created can no longer be found.
        </p>
      )}

      {error && (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}

      {!confirming ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setConfirming(true);
            setError(null);
          }}
        >
          <Undo2 className="h-3.5 w-3.5 mr-1" />
          Take it back
        </Button>
      ) : (
        <div className="space-y-2">
          {/* Said before the button, not after it. Stopping an agent that is
              part-way through a job is a real action, and nobody should find
              out what it did by watching it happen. */}
          <div className="rounded-lg border border-border bg-muted/50 p-2.5 space-y-1">
            <p className="text-xs font-medium">If you take this back:</p>
            <ul className="text-xs text-muted-foreground space-y-1 list-disc pl-4">
              <li>The message is yours again and leaves the "With agents" list.</li>
              <li>{who} stops. If it has a run going, that run is stopped.</li>
              <li>
                The work item stays, with everything on it so far. {who} is taken off it, and work
                already under way goes back to the to-do list.
              </li>
              <li>Nothing is sent to whoever emailed you.</li>
            </ul>
          </div>
          <Label htmlFor={`take-over-reason-${hold.id}`} className="text-xs text-muted-foreground">
            Say why you are taking it back. The work item keeps this, so whoever reads it later
            knows what happened.
          </Label>
          <textarea
            id={`take-over-reason-${hold.id}`}
            rows={2}
            className="w-full rounded-lg border border-border bg-background p-2 text-sm"
            placeholder="I want to answer this one myself"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!reason.trim() || takeOverMutation.isPending}
              onClick={() => takeOverMutation.mutate()}
            >
              {takeOverMutation.isPending ? "Taking it back..." : `Take it back from ${who}`}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={takeOverMutation.isPending}
              onClick={() => {
                setConfirming(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
