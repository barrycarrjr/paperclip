import { HelpCircle, ListChecks, ShieldQuestion } from "lucide-react";
import { Link } from "@/lib/router";
import type { PendingCompanyInteraction } from "../api/issues";
import { timeAgo } from "../lib/timeAgo";

/**
 * One unanswered agent question in the Brief's "Awaiting your tap" section.
 * Clicking anywhere lands on the issue thread's answering card (the
 * `#interaction-` anchor is scrolled to by IssueChatThread).
 */

const KIND_PRESENTATION = {
  ask_user_questions: { icon: HelpCircle, verb: "is asking a question", cta: "Answer" },
  request_confirmation: { icon: ShieldQuestion, verb: "wants a go-ahead", cta: "Decide" },
  suggest_tasks: { icon: ListChecks, verb: "proposed new tasks", cta: "Review" },
} as const;

export function pendingQuestionHref(interaction: PendingCompanyInteraction): string {
  const issueRef = interaction.issueIdentifier ?? interaction.issueId;
  return `/issues/${issueRef}#interaction-${interaction.id}`;
}

export function PendingQuestionRow({
  interaction,
  agentName,
  hrefPrefix = "",
}: {
  interaction: PendingCompanyInteraction;
  /** Resolved display name of the asking agent, when known. */
  agentName?: string | null;
  /** Portfolio pages pass "/{issuePrefix}" so links cross companies. */
  hrefPrefix?: string;
}) {
  const presentation = KIND_PRESENTATION[interaction.kind];
  const Icon = presentation.icon;
  const headline = interaction.title?.trim() || interaction.summary?.trim() || null;
  const href = `${hrefPrefix}${pendingQuestionHref(interaction)}`;
  return (
    <Link
      to={href}
      className="flex items-center gap-3 px-4 py-2.5 text-sm no-underline hover:bg-accent/40"
    >
      <Icon className="h-4 w-4 shrink-0 text-sky-600 dark:text-sky-400" />
      <div className="min-w-0 flex-1">
        <div className="truncate">
          <span className="font-medium">{agentName ?? "An agent"}</span>{" "}
          <span className="text-muted-foreground">{presentation.verb}</span>
          {headline ? <span>: {headline}</span> : null}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {interaction.issueIdentifier ?? "issue"} · {interaction.issueTitle} · waiting{" "}
          {timeAgo(interaction.createdAt)}
        </div>
      </div>
      <span className="shrink-0 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-foreground">
        {presentation.cta}
      </span>
    </Link>
  );
}
