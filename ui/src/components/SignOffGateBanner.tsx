import { useState } from "react";
import { ClipboardCheck } from "lucide-react";
import type { Issue } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * The control that actually signs work off.
 *
 * The attention queue puts "PAP-12 finished and wants your review" in front of
 * the operator with a Review button, and until now that button led to an issue
 * page where the only thing about the gate was a line of text in the properties
 * panel saying "Review pending with Barry". There was nowhere to approve it.
 * This is that missing control, on the issue itself, where the row points.
 */

/** Who the stage is waiting on, and what kind of stage it is. */
export function pendingSignOffForUser(
  issue: Pick<Issue, "executionState">,
  currentUserId: string | null,
): { stageType: "review" | "approval"; instructions: string | null } | null {
  const state = issue.executionState;
  if (!state || state.status !== "pending") return null;
  const participant = state.currentParticipant;
  if (!participant || participant.type !== "user") return null;
  // The server rejects anyone who is not the named participant, so showing
  // the control to someone else would just be a button that always fails.
  // A board with no session user (local_implicit) has no one to compare to
  // and is allowed through, matching how the queue scopes these rows.
  if (currentUserId && participant.userId !== currentUserId) return null;
  const stageType = state.currentStageType === "approval" ? "approval" : "review";
  return { stageType, instructions: state.reviewRequest?.instructions ?? null };
}

export function SignOffGateBanner({
  issue,
  currentUserId,
  onDecide,
  isPending = false,
  error = null,
}: {
  issue: Pick<Issue, "executionState">;
  currentUserId: string | null;
  /**
   * Approving sends status "done"; requesting changes sends "in_progress".
   * The comment is required by the server on both, so the button stays
   * disabled until there is one.
   */
  onDecide: (decision: { status: "done" | "in_progress"; comment: string }) => void;
  isPending?: boolean;
  error?: string | null;
}) {
  const [comment, setComment] = useState("");
  const gate = pendingSignOffForUser(issue, currentUserId);
  if (!gate) return null;

  const canDecide = comment.trim().length > 0 && !isPending;
  const heading =
    gate.stageType === "approval"
      ? "This is waiting for your approval to move forward."
      : "The work is finished and waiting for your review.";

  return (
    <div className="rounded-md border border-violet-500/35 bg-violet-500/10 p-3 text-sm">
      <div className="flex items-start gap-2.5">
        <ClipboardCheck className="mt-0.5 h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" />
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <p className="font-medium text-violet-900 dark:text-violet-100">{heading}</p>
            <p className="mt-0.5 text-xs text-violet-900/80 dark:text-violet-100/80">
              Nothing moves until you decide. The issue stays open either way.
            </p>
          </div>

          {gate.instructions && (
            <p className="whitespace-pre-wrap text-xs text-violet-900/90 dark:text-violet-100/90">
              {gate.instructions}
            </p>
          )}

          <Textarea
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder={
              gate.stageType === "approval"
                ? "Say why you are approving, or what needs changing…"
                : "Say what you think, or what needs changing…"
            }
            rows={2}
            aria-label="Sign-off comment"
            className="text-sm"
          />
          <p className="text-xs text-muted-foreground">
            A comment is required, so whoever picks this up next knows why.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={!canDecide}
              onClick={() => onDecide({ status: "done", comment: comment.trim() })}
            >
              {gate.stageType === "approval" ? "Approve" : "Approve and finish"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canDecide}
              onClick={() => onDecide({ status: "in_progress", comment: comment.trim() })}
            >
              Request changes
            </Button>
          </div>

          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
        </div>
      </div>
    </div>
  );
}
