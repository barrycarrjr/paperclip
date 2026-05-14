import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, MessageSquare, Send } from "lucide-react";
import type { Issue, IssueComment, IssueLabel } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { issuesApi } from "../api/issues";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { AssigneePicker } from "./AssigneePicker";
import { InlineEditor } from "./InlineEditor";
import { LabelsPicker } from "./LabelsPicker";
import { MarkdownBody } from "./MarkdownBody";
import { PriorityIcon } from "./PriorityIcon";
import { StatusIcon } from "./StatusIcon";
import { timeAgo } from "../lib/timeAgo";

export interface IssuePreviewSheetProps {
  /** Issue to preview, or null to keep the sheet closed. */
  issue: Issue | null;
  /** Issue prefix for the company (used to build the "Open full page" link). */
  companyPrefix: string | null;
  /** Map of agent id → display name for assignee resolution. */
  agentNameById: Map<string, string>;
  /** Labels available for the issue's company. */
  labels: IssueLabel[];
  /** Closes the sheet. Triggered by Radix on overlay/Escape/close-button. */
  onOpenChange: (open: boolean) => void;
  /** Applies an inline edit to the issue (status, priority, assignee, labels, title, description). */
  onIssueUpdate: (issueId: string, partial: Record<string, unknown>) => Promise<unknown>;
}

const STATUS_LABEL_OVERRIDES: Record<string, string> = {
  in_progress: "In progress",
  in_review: "In review",
};

function statusLabel(status: string) {
  return STATUS_LABEL_OVERRIDES[status] ?? status.replace(/_/g, " ");
}

export function IssuePreviewSheet({
  issue,
  companyPrefix,
  agentNameById,
  labels,
  onOpenChange,
  onIssueUpdate,
}: IssuePreviewSheetProps) {
  const open = !!issue;
  const queryClient = useQueryClient();
  const [commentDraft, setCommentDraft] = useState("");

  // Re-fetch the issue so the description and metadata are fresh — the list
  // payload may be cached. Comments are fetched on demand too.
  const { data: freshIssue } = useQuery({
    queryKey: ["issue-preview", "detail", issue?.id],
    queryFn: () => issuesApi.get(issue!.id),
    enabled: !!issue?.id,
    staleTime: 30_000,
  });
  const effectiveIssue = freshIssue ?? issue;

  const { data: comments } = useQuery({
    queryKey: ["issue-preview", "comments", issue?.id],
    queryFn: () => issuesApi.listComments(issue!.id, { order: "desc", limit: 10 }),
    enabled: !!issue?.id,
    staleTime: 30_000,
  });

  const addComment = useMutation({
    mutationFn: ({ issueId, body }: { issueId: string; body: string }) =>
      issuesApi.addComment(issueId, body),
    onSuccess: (_, vars) => {
      void queryClient.invalidateQueries({ queryKey: ["issue-preview", "comments", vars.issueId] });
      void queryClient.invalidateQueries({ queryKey: ["issue-preview", "detail", vars.issueId] });
      // The list query is keyed by [..., selectedCompanyId, ...]; invalidate the
      // prefix so the row's updated-at refreshes too.
      void queryClient.invalidateQueries({ queryKey: ["portfolio-issues"] });
      setCommentDraft("");
    },
  });

  const assigneeAgentName = effectiveIssue?.assigneeAgentId
    ? agentNameById.get(effectiveIssue.assigneeAgentId) ?? null
    : null;
  const fullPagePath = effectiveIssue && companyPrefix
    ? `/${companyPrefix}/issues/${effectiveIssue.id}`
    : null;

  const handleUpdate = (partial: Record<string, unknown>) =>
    effectiveIssue
      ? onIssueUpdate(effectiveIssue.id, partial)
      : Promise.resolve();

  // Reset the draft when the sheet opens a different issue.
  useEffect(() => {
    setCommentDraft("");
    addComment.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue?.id]);

  function submitComment() {
    const body = commentDraft.trim();
    if (!body || !effectiveIssue || addComment.isPending) return;
    addComment.mutate({ issueId: effectiveIssue.id, body });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-2xl overflow-hidden flex flex-col p-0"
      >
        {effectiveIssue && (
          <>
            <div className="flex items-start gap-3 px-5 pt-5 pb-4 border-b border-border shrink-0">
              <span onClick={(e) => e.stopPropagation()} className="mt-0.5">
                <StatusIcon
                  status={effectiveIssue.status}
                  blockerAttention={effectiveIssue.blockerAttention}
                  onChange={(status) => handleUpdate({ status })}
                  className="h-5 w-5 shrink-0"
                />
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground mb-1">
                  <span className="font-mono">{effectiveIssue.identifier ?? ""}</span>
                  <span>·</span>
                  <span className="capitalize">{statusLabel(effectiveIssue.status)}</span>
                  <span>·</span>
                  <span onClick={(e) => e.stopPropagation()} className="inline-flex">
                    <PriorityIcon
                      priority={effectiveIssue.priority}
                      onChange={(priority) => handleUpdate({ priority })}
                      showLabel
                    />
                  </span>
                </div>
                <InlineEditor
                  value={effectiveIssue.title}
                  onSave={(title) => handleUpdate({ title })}
                  as="h2"
                  className="text-base font-semibold leading-snug pr-8"
                />
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  <AssigneePicker
                    companyId={effectiveIssue.companyId}
                    assigneeAgentId={effectiveIssue.assigneeAgentId}
                    assigneeUserId={effectiveIssue.assigneeUserId}
                    createdByUserId={effectiveIssue.createdByUserId}
                    assigneeAgentName={assigneeAgentName}
                    onChange={(next) => handleUpdate({ ...next })}
                    compact
                  />
                  <span>Updated {timeAgo(effectiveIssue.updatedAt)}</span>
                  <span>Created {timeAgo(effectiveIssue.createdAt)}</span>
                </div>
                <div className="mt-2">
                  <LabelsPicker
                    companyId={effectiveIssue.companyId}
                    labelIds={effectiveIssue.labelIds ?? []}
                    availableLabels={labels}
                    selectedLabels={effectiveIssue.labels ?? undefined}
                    onChange={(labelIds) => handleUpdate({ labelIds })}
                  />
                </div>
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-5">
              <section>
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
                  Description
                </h3>
                <InlineEditor
                  value={effectiveIssue.description ?? ""}
                  onSave={(description) => handleUpdate({ description })}
                  multiline
                  foldable
                  placeholder="Add a description..."
                  className="text-sm leading-relaxed"
                />
              </section>

              <section>
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2 flex items-center gap-1.5">
                  <MessageSquare className="h-3 w-3" />
                  Recent comments
                </h3>
                {comments && comments.length > 0 ? (
                  <ul className="space-y-3 mb-3">
                    {comments.map((c) => (
                      <CommentItem key={c.id} comment={c} agentNameById={agentNameById} />
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm italic text-muted-foreground mb-3">No comments yet.</p>
                )}
                <div className="flex flex-col gap-2">
                  <Textarea
                    value={commentDraft}
                    onChange={(e) => setCommentDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        submitComment();
                      }
                    }}
                    placeholder="Write a comment… (⌘/Ctrl + Enter to send)"
                    className="text-sm resize-none"
                    rows={3}
                    disabled={addComment.isPending}
                  />
                  <div className="flex items-center justify-end gap-2">
                    {addComment.isError && (
                      <span className="text-[11px] text-destructive">Could not send. Try again.</span>
                    )}
                    <Button
                      size="sm"
                      onClick={submitComment}
                      disabled={!commentDraft.trim() || addComment.isPending}
                    >
                      <Send className="h-3.5 w-3.5 mr-1" />
                      {addComment.isPending ? "Sending…" : "Send"}
                    </Button>
                  </div>
                </div>
              </section>
            </div>

            {fullPagePath && (
              <div className="px-5 py-3 border-t border-border shrink-0 flex justify-end">
                <Link
                  to={fullPagePath}
                  className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 border border-border bg-foreground text-background hover:opacity-90 rounded-sm no-underline"
                  onClick={() => onOpenChange(false)}
                >
                  Open full page
                  <ExternalLink className="h-3 w-3" />
                </Link>
              </div>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function CommentItem({
  comment,
  agentNameById,
}: {
  comment: IssueComment;
  agentNameById: Map<string, string>;
}) {
  const author = comment.authorAgentId
    ? agentNameById.get(comment.authorAgentId) ?? "Agent"
    : comment.authorUserId
      ? "User"
      : "System";
  return (
    <li className="border border-border/60 rounded-md p-3 bg-card/40">
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground mb-1.5">
        <span className="font-medium text-foreground">{author}</span>
        <span>·</span>
        <span>{timeAgo(comment.createdAt)}</span>
      </div>
      <MarkdownBody className="text-sm leading-relaxed">{comment.body}</MarkdownBody>
    </li>
  );
}
