import type { ReactNode } from "react";
import type { IssueRelationIssueSummary } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";
import { PILL_HOLDING_TEXT_CLASS, PillText } from "./PillText";
import { StatusIcon } from "./StatusIcon";

export function IssueReferencePill({
  issue,
  strikethrough,
  className,
  children,
}: {
  issue: Pick<IssueRelationIssueSummary, "id" | "identifier" | "title"> &
    Partial<Pick<IssueRelationIssueSummary, "status">>;
  strikethrough?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const issueLabel = issue.identifier ?? issue.title;
  const classNames = cn(
    "paperclip-mention-chip paperclip-mention-chip--issue",
    "gap-1 rounded-full border border-border px-2 py-0.5 text-xs no-underline",
    // An issue without an identifier shows its whole title, which can be
    // any length.
    PILL_HOLDING_TEXT_CLASS,
    issue.identifier && "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring",
    strikethrough && "opacity-60 line-through decoration-muted-foreground",
    className,
  );
  const content = (
    <>
      {issue.status ? <StatusIcon status={issue.status} className="h-3 w-3 shrink-0" /> : null}
      {children !== undefined ? children : <PillText text={issue.identifier ?? issue.title} />}
    </>
  );

  if (!issue.identifier) {
    return (
      <span
        data-mention-kind="issue"
        className={classNames}
        title={issue.title}
        aria-label={`Issue: ${issue.title}`}
      >
        {content}
      </span>
    );
  }

  return (
    <Link
      to={`/issues/${issueLabel}`}
      data-mention-kind="issue"
      className={classNames}
      title={issue.title}
      aria-label={`Issue ${issueLabel}: ${issue.title}`}
    >
      {content}
    </Link>
  );
}
