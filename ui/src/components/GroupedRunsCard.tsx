import { memo } from "react";
import { Link } from "@/lib/router";
import type { Issue } from "@paperclipai/shared";
import type { LiveRunForIssue } from "../api/heartbeats";
import { isRunActive } from "./ActiveAgentsPanel";
import { cn, relativeTime } from "../lib/utils";
import { Identity } from "./Identity";
import { ArrowDownRight, CheckCircle2, ExternalLink } from "lucide-react";

export type RunGroupEntry =
  | { kind: "single"; run: LiveRunForIssue }
  | { kind: "group"; issueId: string; runs: LiveRunForIssue[] };

export function groupRunsByIssue(runs: LiveRunForIssue[]): RunGroupEntry[] {
  const byIssue = new Map<string, LiveRunForIssue[]>();
  const orphans: LiveRunForIssue[] = [];
  for (const run of runs) {
    if (run.issueId) {
      const bucket = byIssue.get(run.issueId);
      if (bucket) bucket.push(run);
      else byIssue.set(run.issueId, [run]);
    } else {
      orphans.push(run);
    }
  }
  const rank = (run: LiveRunForIssue) =>
    run.startedAt
      ? new Date(run.startedAt).getTime()
      : new Date(run.createdAt).getTime();
  const entries: { entry: RunGroupEntry; order: number }[] = [];
  for (const [issueId, issueRuns] of byIssue) {
    if (issueRuns.length === 1) {
      entries.push({ entry: { kind: "single", run: issueRuns[0] }, order: rank(issueRuns[0]) });
    } else {
      const latest = Math.max(...issueRuns.map(rank));
      entries.push({ entry: { kind: "group", issueId, runs: issueRuns }, order: latest });
    }
  }
  for (const run of orphans) {
    entries.push({ entry: { kind: "single", run }, order: rank(run) });
  }
  entries.sort((a, b) => b.order - a.order);
  return entries.map((e) => e.entry);
}

type RunRelationship = "first" | "handoff" | "review" | "continuation";

interface RunRow {
  run: LiveRunForIssue;
  relationship: RunRelationship;
}

function classifyRun(
  prev: LiveRunForIssue | null,
  curr: LiveRunForIssue,
  issue: Issue | undefined,
): RunRelationship {
  if (!prev) return "first";
  if (prev.agentId === curr.agentId) return "continuation";
  const startedAt = curr.startedAt ? new Date(curr.startedAt).getTime() : null;
  const issueClosedAt = issue?.completedAt ? new Date(issue.completedAt).getTime() : null;
  if (
    curr.invocationSource === "automation" &&
    startedAt !== null &&
    issueClosedAt !== null &&
    startedAt >= issueClosedAt
  ) {
    return "review";
  }
  return "handoff";
}

function relationshipLabel(rel: RunRelationship): string {
  switch (rel) {
    case "handoff":
      return "Handed off to";
    case "review":
      return "Reviewed by";
    case "continuation":
      return "Continued";
    case "first":
      return "";
  }
}

export const GroupedRunsCard = memo(function GroupedRunsCard({
  issue,
  runs,
  className,
}: {
  issue: Issue | undefined;
  runs: LiveRunForIssue[];
  className?: string;
}) {
  const ordered = [...runs].sort((a, b) => {
    const at = a.startedAt ? new Date(a.startedAt).getTime() : new Date(a.createdAt).getTime();
    const bt = b.startedAt ? new Date(b.startedAt).getTime() : new Date(b.createdAt).getTime();
    return at - bt;
  });

  const rows: RunRow[] = ordered.map((run, i) => ({
    run,
    relationship: classifyRun(i === 0 ? null : ordered[i - 1], run, issue),
  }));

  const anyActive = ordered.some(isRunActive);
  const issueLabel = issue?.identifier ?? ordered[0]?.issueId?.slice(0, 8) ?? "";
  const issueLink = `/issues/${issue?.identifier ?? ordered[0]?.issueId ?? ""}`;

  return (
    <div
      className={cn(
        "flex h-[320px] flex-col overflow-hidden rounded-xl border shadow-sm",
        anyActive
          ? "border-cyan-500/25 bg-cyan-500/[0.04] shadow-[0_16px_40px_rgba(6,182,212,0.08)]"
          : "border-border bg-background/70",
        className,
      )}
    >
      <div className="border-b border-border/60 px-3 py-3">
        <div className="flex items-start justify-between gap-2">
          <Link
            to={issueLink}
            className="min-w-0 flex-1 hover:underline"
            title={issue?.title ? `${issueLabel} - ${issue.title}` : issueLabel}
          >
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {issueLabel}
            </div>
            {issue?.title && (
              <div className="mt-0.5 line-clamp-2 text-xs text-foreground">
                {issue.title}
              </div>
            )}
          </Link>
          <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-[10px] text-muted-foreground">
            {rows.length} runs
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <ol className="flex flex-col gap-1.5">
          {rows.map(({ run, relationship }, idx) => {
            const active = isRunActive(run);
            const finishedLabel = run.finishedAt
              ? `Finished ${relativeTime(run.finishedAt)}`
              : run.startedAt
                ? `Started ${relativeTime(run.startedAt)}`
                : `Created ${relativeTime(run.createdAt)}`;
            return (
              <li key={run.id}>
                {idx > 0 && (
                  <div className="ml-1 flex items-center gap-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {relationship === "review" ? (
                      <CheckCircle2 className="h-3 w-3" />
                    ) : (
                      <ArrowDownRight className="h-3 w-3" />
                    )}
                    <span>{relationshipLabel(relationship)}</span>
                  </div>
                )}
                <Link
                  to={`/agents/${run.agentId}/runs/${run.id}`}
                  className={cn(
                    "group flex items-center justify-between gap-2 rounded-lg border px-2.5 py-2 transition-colors",
                    active
                      ? "border-cyan-500/40 bg-cyan-500/[0.06]"
                      : "border-border/60 bg-background/60 hover:border-border",
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    {active ? (
                      <span className="relative flex h-2 w-2 shrink-0">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-70" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-500" />
                      </span>
                    ) : (
                      <span className="inline-flex h-2 w-2 shrink-0 rounded-full bg-muted-foreground/35" />
                    )}
                    <div className="min-w-0">
                      <Identity
                        name={run.agentName}
                        size="sm"
                        className="[&>span:last-child]:!text-[11px]"
                      />
                      <div className="mt-0.5 text-[10px] text-muted-foreground">
                        {active ? "Live now" : finishedLabel}
                      </div>
                    </div>
                  </div>
                  <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground/60 group-hover:text-foreground" />
                </Link>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
});
