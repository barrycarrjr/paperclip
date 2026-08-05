import { ClipboardCheck, Stamp } from "lucide-react";
import { Link } from "@/lib/router";
import type { PendingReviewGate } from "../api/issues";
import { timeAgo } from "../lib/timeAgo";

/**
 * One issue whose review/approval gate is waiting on a human, in the
 * Brief's "Awaiting your tap" section. The acting surface is the issue
 * page (properties panel + thread), so the whole row links there.
 */

const STAGE_PRESENTATION = {
  review: {
    icon: ClipboardCheck,
    line: "finished work and wants your review",
    cta: "Review",
  },
  approval: {
    icon: Stamp,
    line: "needs your approval to move forward",
    cta: "Approve",
  },
} as const;

export function ReviewGateRow({
  gate,
  hrefPrefix = "",
}: {
  gate: PendingReviewGate;
  /** Portfolio pages pass "/{issuePrefix}" so links cross companies. */
  hrefPrefix?: string;
}) {
  const presentation = STAGE_PRESENTATION[gate.stageType ?? "review"];
  const Icon = presentation.icon;
  const issueRef = gate.identifier ?? gate.issueId;
  return (
    <Link
      to={`${hrefPrefix}/issues/${issueRef}`}
      className="flex items-center gap-3 px-4 py-2.5 text-sm no-underline hover:bg-accent/40"
    >
      <Icon className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" />
      <div className="min-w-0 flex-1">
        <div className="truncate">
          <span className="font-medium">{gate.identifier ?? "Issue"}</span>{" "}
          <span className="text-muted-foreground">{presentation.line}</span>
        </div>
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {gate.title}
          {gate.reviewInstructions ? ` · ${gate.reviewInstructions}` : ""}
          {` · last activity ${timeAgo(gate.updatedAt)}`}
        </div>
      </div>
      <span className="shrink-0 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-foreground">
        {presentation.cta}
      </span>
    </Link>
  );
}
