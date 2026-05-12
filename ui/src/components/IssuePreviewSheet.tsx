import { useQuery } from "@tanstack/react-query";
import { Bot, ExternalLink, MessageSquare, User } from "lucide-react";
import type { Issue, IssueComment, IssueLabel } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { issuesApi } from "../api/issues";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { StatusIcon } from "./StatusIcon";
import { MarkdownBody } from "./MarkdownBody";
import { priorityColor, priorityColorDefault } from "../lib/status-colors";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";

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
}: IssuePreviewSheetProps) {
  const open = !!issue;

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

  const issueLabels = effectiveIssue
    ? (effectiveIssue.labelIds ?? [])
        .map((id) => labels.find((l) => l.id === id))
        .filter((l): l is IssueLabel => !!l)
    : [];

  const assigneeAgentName = effectiveIssue?.assigneeAgentId
    ? agentNameById.get(effectiveIssue.assigneeAgentId) ?? null
    : null;
  const fullPagePath = effectiveIssue && companyPrefix
    ? `/${companyPrefix}/issues/${effectiveIssue.id}`
    : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-2xl overflow-hidden flex flex-col p-0"
      >
        {effectiveIssue && (
          <>
            <div className="flex items-start gap-3 px-5 pt-5 pb-4 border-b border-border shrink-0">
              <StatusIcon
                status={effectiveIssue.status}
                blockerAttention={effectiveIssue.blockerAttention}
                className="h-5 w-5 shrink-0 mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground mb-1">
                  <span className="font-mono">{effectiveIssue.identifier ?? ""}</span>
                  <span>·</span>
                  <span className="capitalize">{statusLabel(effectiveIssue.status)}</span>
                  <span>·</span>
                  <span
                    className={cn(
                      "font-semibold uppercase tracking-wide",
                      priorityColor[effectiveIssue.priority] ?? priorityColorDefault,
                    )}
                  >
                    {effectiveIssue.priority}
                  </span>
                </div>
                <h2 className="text-base font-semibold leading-snug break-words pr-8">
                  {effectiveIssue.title}
                </h2>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  {assigneeAgentName ? (
                    <span className="inline-flex items-center gap-1">
                      <Bot className="h-3 w-3" />
                      {assigneeAgentName}
                    </span>
                  ) : effectiveIssue.assigneeUserId ? (
                    <span className="inline-flex items-center gap-1">
                      <User className="h-3 w-3" />
                      User
                    </span>
                  ) : (
                    <span className="italic opacity-60">Unassigned</span>
                  )}
                  <span>Updated {timeAgo(effectiveIssue.updatedAt)}</span>
                  <span>Created {timeAgo(effectiveIssue.createdAt)}</span>
                </div>
                {issueLabels.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {issueLabels.map((l) => (
                      <span
                        key={l.id}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded-full"
                        style={{
                          backgroundColor: (l.color || "#888") + "33",
                          color: l.color || "inherit",
                        }}
                      >
                        {l.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-5">
              <section>
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
                  Description
                </h3>
                {effectiveIssue.description?.trim() ? (
                  <MarkdownBody className="text-sm leading-relaxed">
                    {effectiveIssue.description}
                  </MarkdownBody>
                ) : (
                  <p className="text-sm italic text-muted-foreground">No description.</p>
                )}
              </section>

              <section>
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2 flex items-center gap-1.5">
                  <MessageSquare className="h-3 w-3" />
                  Recent comments
                </h3>
                {comments && comments.length > 0 ? (
                  <ul className="space-y-3">
                    {comments.map((c) => (
                      <CommentItem key={c.id} comment={c} agentNameById={agentNameById} />
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm italic text-muted-foreground">No comments yet.</p>
                )}
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
