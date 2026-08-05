import { MessageSquareText } from "lucide-react";
import { MarkdownBody } from "./MarkdownBody";
import { cn } from "../lib/utils";

/**
 * The agent's own account of a run, from resultJson.summary (with the
 * resultJson.result string as fallback). This is the lead of the run story:
 * three sentences from the agent beat 243 KB of logs. Never rendered on the
 * run page before this card, despite being persisted for every finished run.
 */
export function RunReportCard({
  summary,
  isLive,
  className,
}: {
  summary: string | null;
  isLive: boolean;
  className?: string;
}) {
  if (!summary && !isLive) return null;
  return (
    <div className={cn("rounded-lg border border-border", className)}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs font-semibold">
        <MessageSquareText className="h-3.5 w-3.5 text-muted-foreground" />
        The agent's report
      </div>
      <div className="px-3 py-2.5">
        {summary ? (
          <MarkdownBody className="text-sm [&_p]:my-1 [&_pre]:my-2">{summary}</MarkdownBody>
        ) : (
          <p className="text-xs text-muted-foreground">
            Still working. The agent writes its report when the run finishes.
          </p>
        )}
      </div>
    </div>
  );
}

/** Extract the agent's report text from a run's resultJson. */
export function runReportText(resultJson: unknown): string | null {
  if (!resultJson || typeof resultJson !== "object") return null;
  const result = resultJson as Record<string, unknown>;
  const summary = typeof result.summary === "string" ? result.summary.trim() : "";
  if (summary) return summary;
  const fallback = typeof result.result === "string" ? result.result.trim() : "";
  return fallback || null;
}
