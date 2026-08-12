import { NotebookPen } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { heartbeatsApi, type RunDocumentRevision } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";

/**
 * "Notes updated by this run": document revisions (handoff summaries,
 * plans) a run wrote, linking to the document on the issue page via the
 * #document- anchor IssueDocumentsSection already scrolls to. The
 * created_by_run_id column always existed; nothing surfaced it per run.
 */
export function RunDocumentsCard({
  runId,
  isLive,
  className,
}: {
  runId: string;
  isLive?: boolean;
  className?: string;
}) {
  const { data: revisions } = useQuery({
    queryKey: queryKeys.runDocumentRevisions(runId),
    queryFn: () => heartbeatsApi.listRunDocumentRevisions(runId),
    refetchInterval: isLive ? 10_000 : false,
  });
  if (!revisions || revisions.length === 0) return null;
  // One row per document: a run may save several revisions of the same
  // notes; the reader cares that the document changed, not how many times.
  const byDocument = new Map<string, RunDocumentRevision>();
  for (const revision of revisions) {
    if (!byDocument.has(revision.documentId)) byDocument.set(revision.documentId, revision);
  }
  const rows = [...byDocument.values()];
  return (
    <div className={cn("rounded-lg border border-border", className)}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs font-semibold">
        <NotebookPen className="h-3.5 w-3.5 text-muted-foreground" />
        Notes updated by this run
        <span className="ml-auto font-normal text-muted-foreground">{rows.length}</span>
      </div>
      <div className="divide-y divide-border">
        {rows.map((revision) => (
          <Link
            key={revision.documentId}
            to={`/issues/${revision.issueIdentifier ?? revision.issueId}#document-${encodeURIComponent(revision.key)}`}
            className="block px-3 py-2 no-underline hover:bg-accent/40"
          >
            <div className="truncate text-xs font-medium">
              {documentLabel(revision)}
            </div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {revision.issueIdentifier ?? "issue"} · {revision.issueTitle} · saved{" "}
              {relativeTime(revision.createdAt)}
            </div>
            {revision.changeSummary && (
              <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                {revision.changeSummary}
              </div>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}

/** Friendly names for the well-known system document keys. */
const KNOWN_DOCUMENT_LABELS: Record<string, string> = {
  "continuation-summary": "Handoff notes",
  plan: "Plan",
  // Retired: rules live in the email-tools database, the cursor in plugin
  // state. Existing issues still carry the document as history.
  "email-triage-rules": "Email triage rules (retired)",
};

function documentLabel(revision: RunDocumentRevision): string {
  if (revision.title?.trim()) return revision.title;
  const known = KNOWN_DOCUMENT_LABELS[revision.key];
  if (known) return known;
  const words = revision.key.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
