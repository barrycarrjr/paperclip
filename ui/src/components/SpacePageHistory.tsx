import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, History } from "lucide-react";
import type { Space, SpacePage, SpacePageRevision } from "@paperclipai/shared";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { spacesApi } from "../api/spaces";
import { useDialogOpening, type DialogOpening } from "../hooks/useDialogOpening";
import { buildCompanyUserProfileMap, type CompanyUserProfile } from "../lib/company-members";
import { queryKeys } from "../lib/queryKeys";
import { Link } from "../lib/router";
import { cn, relativeTime } from "../lib/utils";
import { EmptyState } from "./EmptyState";
import { MarkdownBody } from "./MarkdownBody";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

/** Who made a version: a person, or an agent and the run it was in. */
function spaceVersionAuthor(
  version: Pick<SpacePageRevision, "createdByAgentId" | "createdByUserId" | "createdByRunId">,
  people: Map<string, CompanyUserProfile>,
  agentNames: Map<string, string>,
): { name: string; agentId: string | null; runId: string | null } {
  if (version.createdByAgentId) {
    return {
      name: agentNames.get(version.createdByAgentId) ?? "An agent",
      agentId: version.createdByAgentId,
      runId: version.createdByRunId,
    };
  }
  const userId = version.createdByUserId;
  const name = userId ? (people.get(userId)?.label ?? (userId === "local-board" ? "Board" : "Someone")) : "Someone";
  return { name, agentId: null, runId: null };
}

function restoreFailure(error: unknown, version: SpacePageRevision) {
  // The editor has taken the newer version by now, so a second try is written on it.
  if (error instanceof ApiError && error.status === 409) {
    return `The page changed after you opened its history. It now shows the newest version. Restore again if you still want version ${version.revisionNumber}.`;
  }
  const reason = error instanceof Error && error.message ? error.message : "Please try again.";
  return `Could not restore the version. ${reason}`;
}

interface SpacePageHistoryProps {
  space: Space;
  pageId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The version the page is on now. */
  currentRevisionId: string | null;
  canRestore: boolean;
  /** Writes the version as the page's newest, after any save on its way. */
  onRestore: (version: SpacePageRevision) => Promise<SpacePage>;
}

/**
 * A page's history: every version, newest first, with who made it. Any
 * version opens to be read, and a person who can edit the page can restore
 * it as the newest version. A panel beside the page on a desktop, the whole
 * screen on a phone.
 */
export function SpacePageHistory({
  space,
  pageId,
  open,
  onOpenChange,
  currentRevisionId,
  canRestore,
  onRestore,
}: SpacePageHistoryProps) {
  const queryClient = useQueryClient();
  const [readingId, setReadingId] = useState<string | null>(null);
  // What the last restore did, said inside the sheet: a toast would sit
  // under it, and a click on one closes the sheet.
  const [outcome, setOutcome] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const opening = useDialogOpening(open);

  useEffect(() => {
    if (open) return;
    setReadingId(null);
    setOutcome(null);
  }, [open]);

  const versionsKey = queryKeys.spaces.revisions(space.id, pageId);
  const versionsQuery = useQuery({
    queryKey: versionsKey,
    queryFn: () => spacesApi.revisions(space.id, pageId),
    enabled: open,
  });
  const versions = useMemo(() => versionsQuery.data ?? [], [versionsQuery.data]);
  const peopleQuery = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(space.companyId),
    queryFn: () => accessApi.listUserDirectory(space.companyId),
    enabled: open,
  });
  const byAnAgent = versions.some((version) => version.createdByAgentId);
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(space.companyId),
    queryFn: () => agentsApi.list(space.companyId),
    enabled: open && byAnAgent,
  });
  const people = useMemo(() => buildCompanyUserProfileMap(peopleQuery.data?.users), [peopleQuery.data?.users]);
  const agentNames = useMemo(
    () => new Map((agentsQuery.data ?? []).map((agent) => [agent.id, agent.name])),
    [agentsQuery.data],
  );

  const reading = versions.find((version) => version.id === readingId) ?? null;
  const readingQuery = useQuery({
    queryKey: queryKeys.spaces.revision(space.id, pageId, readingId ?? ""),
    queryFn: () => spacesApi.revision(space.id, pageId, readingId!),
    enabled: open && !!readingId,
  });

  const restore = useMutation({
    mutationFn: (sent: { version: SpacePageRevision; opening: DialogOpening | null }) => onRestore(sent.version),
    onMutate: () => setOutcome(null),
    onSuccess: async (page, sent) => {
      await queryClient.invalidateQueries({ queryKey: versionsKey });
      if (!opening.isShowing(sent.opening)) return;
      setReadingId(null);
      setOutcome({
        tone: "success",
        text: `Version ${sent.version.revisionNumber} is back, as version ${page.latestRevisionNumber}.`,
      });
    },
    onError: (error, sent) => {
      void queryClient.invalidateQueries({ queryKey: versionsKey });
      if (opening.isShowing(sent.opening)) setOutcome({ tone: "error", text: restoreFailure(error, sent.version) });
    },
  });

  const authorOf = (version: SpacePageRevision) => spaceVersionAuthor(version, people, agentNames);

  let body;
  if (versionsQuery.error) {
    body = <p className="text-sm text-destructive">{versionsQuery.error.message}</p>;
  } else if (versionsQuery.isLoading) {
    body = <p className="text-sm text-muted-foreground">Loading the versions…</p>;
  } else if (reading) {
    const author = authorOf(reading);
    const isCurrent = reading.id === currentRevisionId;
    const detail = readingQuery.data;
    body = (
      <div className="space-y-3">
        <button
          type="button"
          onClick={() => setReadingId(null)}
          className="inline-flex items-center gap-1 rounded-sm py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
          All versions
        </button>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-0.5">
            <h3 className="text-sm font-semibold">
              Version {reading.revisionNumber}
              {isCurrent && " (the current one)"}
            </h3>
            <p className="text-xs text-muted-foreground">
              {author.name}
              {author.agentId && author.runId && (
                <>
                  {", in "}
                  <Link to={`/agents/${author.agentId}/runs/${author.runId}`} className="underline underline-offset-2">
                    run {author.runId.slice(0, 8)}
                  </Link>
                </>
              )}
              {` · ${relativeTime(reading.createdAt)}`}
            </p>
            {reading.changeSummary && <p className="text-xs text-muted-foreground">{reading.changeSummary}</p>}
          </div>
          {canRestore && !isCurrent && (
            <Button
              size="sm"
              disabled={restore.isPending || !detail}
              onClick={() => restore.mutate({ version: reading, opening: opening.current() })}
            >
              {restore.isPending ? "Restoring…" : "Restore this version"}
            </Button>
          )}
        </div>
        {readingQuery.error ? (
          <p className="text-sm text-destructive">{readingQuery.error.message}</p>
        ) : !detail ? (
          <p className="text-sm text-muted-foreground">Loading this version…</p>
        ) : (
          <article aria-label={`Version ${reading.revisionNumber}`} className="rounded-md border border-border p-3">
            <p className="mb-2 text-base font-semibold">{detail.title}</p>
            {detail.body.trim() ? (
              <MarkdownBody className="paperclip-edit-in-place-content" softBreaks={false}>
                {detail.body}
              </MarkdownBody>
            ) : (
              <p className="text-sm text-muted-foreground">This version is empty.</p>
            )}
          </article>
        )}
      </div>
    );
  } else if (versions.length === 0) {
    body = <EmptyState icon={History} message="No versions to show." />;
  } else {
    body = (
      <ul className="space-y-px">
        {versions.map((version) => {
          const author = authorOf(version);
          return (
            <li key={version.id}>
              <button
                type="button"
                onClick={() => setReadingId(version.id)}
                className="flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent/50"
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  Version {version.revisionNumber}
                  {version.id === currentRevisionId && (
                    <span className="rounded-full border border-border px-2 text-[11px] font-normal text-muted-foreground">
                      Current
                    </span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  {author.agentId ? `${author.name}, in a run` : author.name} · {relativeTime(version.createdAt)}
                </span>
                {version.changeSummary && <span className="text-xs text-muted-foreground">{version.changeSummary}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <Sheet
      open={open}
      // Held open until its restore is done, so its outcome has a place to be said.
      onOpenChange={(next) => {
        if (!next && restore.isPending) return;
        onOpenChange(next);
      }}
    >
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-xl" showCloseButton={!restore.isPending}>
        {/* Room for the close button beside the title only, so a message
            below runs the full width, level with the version below it. */}
        <SheetHeader className="border-b border-border">
          <SheetTitle className="pr-8">History</SheetTitle>
          <SheetDescription>Every saved version of this page, newest first. Open one to read it.</SheetDescription>
          {/* On the page even while empty, so a screen reader hears each outcome. */}
          <div
            role="status"
            className={cn(
              "text-sm",
              outcome && "rounded-md border px-3 py-2",
              outcome?.tone === "success" && "border-border text-foreground",
              outcome?.tone === "error" && "border-destructive/40 bg-destructive/5 text-destructive",
            )}
          >
            {outcome?.text}
          </div>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{body}</div>
      </SheetContent>
    </Sheet>
  );
}
