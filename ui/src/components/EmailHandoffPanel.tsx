import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, Undo2, Check, AlertTriangle, Clock } from "lucide-react";
import type { EmailDelegationState } from "@paperclipai/shared";
import { emailHandoffsApi, type EmailHandoff } from "@/api/emailHandoffs";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

/**
 * What an email handoff looks like on the issue it produced.
 *
 * Shows only when the issue actually came from an email, so it costs nothing
 * on the issues that did not. The wording avoids the word "delegation"
 * everywhere a person reads it: on screen this is "an email someone handed
 * over", not a lifecycle object.
 */

const STATE_LABEL: Record<EmailDelegationState, string> = {
  delegated: "Waiting to be picked up",
  acknowledged: "Picked up",
  in_progress: "Being worked on",
  needs_review: "Waiting on review",
  resolved: "Finished",
  handed_back: "Handed back",
  re_delegated: "Passed to someone else",
};

const STATE_TONE: Record<EmailDelegationState, string> = {
  delegated: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30",
  acknowledged: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/30",
  in_progress: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/30",
  needs_review: "bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/30",
  resolved: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
  handed_back: "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/30",
  re_delegated: "bg-muted text-muted-foreground border-border",
};

/**
 * What to say about the reply, in the words a person would use.
 *
 * "queued" is called out rather than glossed, because the difference between
 * a message that has gone and one that is waiting for you is the whole point
 * of the approval setting.
 */
function replyLine(handoff: EmailHandoff): { text: string; tone: "ok" | "waiting" | "bad" } | null {
  switch (handoff.replyState) {
    case "sent":
      return { text: "Replied to the sender.", tone: "ok" };
    case "queued":
      return { text: "The reply is waiting for you in Approvals.", tone: "waiting" };
    case "failed":
      return {
        text: handoff.replyError
          ? `The reply did not send: ${handoff.replyError}`
          : "The reply did not send.",
        tone: "bad",
      };
    default:
      return null;
  }
}

const TERMINAL: EmailDelegationState[] = ["resolved", "handed_back", "re_delegated"];

export function EmailHandoffPanel({
  companyId,
  issueId,
}: {
  companyId: string | null;
  issueId: string;
}) {
  const queryClient = useQueryClient();
  const [replyBody, setReplyBody] = useState("");
  const [handBackReason, setHandBackReason] = useState("");
  const [mode, setMode] = useState<"idle" | "finishing" | "handing-back">("idle");
  const [error, setError] = useState<string | null>(null);

  const handoffsQuery = useQuery({
    queryKey: queryKeys.issues.emailHandoffs(issueId),
    queryFn: () => emailHandoffsApi.listForIssue(companyId!, issueId),
    enabled: Boolean(companyId && issueId),
  });

  const handoffs = handoffsQuery.data ?? [];
  // Newest first from the server; the open one is what the buttons act on.
  const open = handoffs.find((h) => !TERMINAL.includes(h.status)) ?? null;

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: queryKeys.issues.emailHandoffs(issueId) });
  }

  function failed(err: unknown) {
    // Say what went wrong rather than leaving the button looking like it did
    // nothing — the same rule the mail actions follow.
    setError(err instanceof Error ? err.message : "That did not work. Try again.");
  }

  const acknowledgeMutation = useMutation({
    mutationFn: (h: EmailHandoff) =>
      emailHandoffsApi.acknowledge(companyId!, issueId, h.id, h.version),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: failed,
  });

  const resolveMutation = useMutation({
    mutationFn: (h: EmailHandoff) =>
      emailHandoffsApi.resolve(companyId!, issueId, h.id, {
        replyBody: replyBody.trim() ? replyBody : undefined,
        expectedVersion: h.version,
      }),
    onSuccess: () => {
      setError(null);
      setReplyBody("");
      setMode("idle");
      invalidate();
    },
    onError: failed,
  });

  const handBackMutation = useMutation({
    mutationFn: (h: EmailHandoff) =>
      emailHandoffsApi.handBack(companyId!, issueId, h.id, {
        reason: handBackReason,
        expectedVersion: h.version,
      }),
    onSuccess: () => {
      setError(null);
      setHandBackReason("");
      setMode("idle");
      invalidate();
    },
    onError: failed,
  });

  const busy =
    acknowledgeMutation.isPending || resolveMutation.isPending || handBackMutation.isPending;

  // Nothing to show on an issue that did not come from an email.
  if (handoffsQuery.isLoading || handoffs.length === 0) return null;

  return (
    <section className="rounded-xl border border-border bg-card p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
          <h2 className="text-sm font-semibold">Handed over from an email</h2>
        </div>
        {open && (
          <span
            className={cn(
              "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium shrink-0",
              STATE_TONE[open.status],
            )}
          >
            {STATE_LABEL[open.status]}
          </span>
        )}
      </div>

      {handoffs.map((handoff) => {
        const reply = replyLine(handoff);
        const isOpen = handoff.id === open?.id;
        return (
          <div
            key={handoff.id}
            className={cn(
              "space-y-2 text-sm",
              !isOpen && "border-t border-border pt-3 opacity-70",
            )}
          >
            {!isOpen && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Clock className="h-3 w-3 shrink-0" />
                <span>{STATE_LABEL[handoff.status]}</span>
              </div>
            )}
            <p className="text-muted-foreground">
              {handoff.mailbox}
              {handoff.folder ? ` / ${handoff.folder}` : ""}
              {handoff.messageId ? (
                <span className="block truncate text-xs opacity-70">{handoff.messageId}</span>
              ) : null}
            </p>
            {handoff.handedBackReason && (
              <p className="text-orange-700 dark:text-orange-400">
                Handed back: {handoff.handedBackReason}
              </p>
            )}
            {handoff.resolutionNote && (
              <p className="text-muted-foreground">{handoff.resolutionNote}</p>
            )}
            {reply && (
              <p
                className={cn(
                  "flex items-start gap-1.5",
                  reply.tone === "ok" && "text-emerald-700 dark:text-emerald-400",
                  reply.tone === "waiting" && "text-amber-700 dark:text-amber-400",
                  reply.tone === "bad" && "text-destructive",
                )}
              >
                {reply.tone === "bad" ? (
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                ) : (
                  <Check className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                )}
                <span>{reply.text}</span>
              </p>
            )}
          </div>
        );
      })}

      {error && (
        <p className="flex items-start gap-1.5 text-sm text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}

      {open && mode === "idle" && (
        <div className="flex flex-wrap gap-2">
          {open.status === "delegated" && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => acknowledgeMutation.mutate(open)}
            >
              Mark as picked up
            </Button>
          )}
          <Button size="sm" disabled={busy} onClick={() => setMode("finishing")}>
            Finish and reply
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setMode("handing-back")}
          >
            <Undo2 className="h-3.5 w-3.5 mr-1" />
            Hand back
          </Button>
        </div>
      )}

      {open && mode === "finishing" && (
        <div className="space-y-2">
          <Label htmlFor="handoff-reply" className="text-xs text-muted-foreground">
            This goes to whoever sent the email. Leave it empty to finish without replying.
          </Label>
          <textarea
            id="handoff-reply"
            rows={4}
            className="w-full rounded-lg border border-border bg-background p-2 text-sm"
            placeholder="Thanks for waiting, that refund has gone through..."
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => resolveMutation.mutate(open)}>
              {replyBody.trim() ? "Send and finish" : "Finish without replying"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setMode("idle");
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {open && mode === "handing-back" && (
        <div className="space-y-2">
          <Label htmlFor="handoff-reason" className="text-xs text-muted-foreground">
            Say what is blocking you. Whoever picks this up next has only this to go on. Nothing is
            sent to the sender.
          </Label>
          <textarea
            id="handoff-reason"
            rows={3}
            className="w-full rounded-lg border border-border bg-background p-2 text-sm"
            placeholder="Needs billing access I do not have"
            value={handBackReason}
            onChange={(e) => setHandBackReason(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy || !handBackReason.trim()}
              onClick={() => handBackMutation.mutate(open)}
            >
              Hand back
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setMode("idle");
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
