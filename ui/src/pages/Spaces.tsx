import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Library, Plus } from "lucide-react";
import { SPACE_DESCRIPTION_MAX, SPACE_NAME_MAX, type SpaceListItem } from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { spacesApi } from "@/api/spaces";
import { EmptyState } from "@/components/EmptyState";
import { InfoPopoverButton } from "@/components/InfoPopoverButton";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useOptionalToastActions } from "@/context/ToastContext";
import { useDialogOpening, type DialogOpening } from "@/hooks/useDialogOpening";
import { useActiveCompanyId } from "@/hooks/useRouteCompany";
import { canWriteCompany } from "@/lib/company-access";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useNavigate } from "@/lib/router";
import { cn } from "@/lib/utils";

function pageCountLabel(count: number) {
  return count === 1 ? "1 page" : `${count} pages`;
}

export function Spaces() {
  // From the address, not the selection, since this page writes (see useActiveCompanyId).
  const companyId = useActiveCompanyId();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [createOpen, setCreateOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Spaces" }]);
  }, [setBreadcrumbs]);

  const { data: boardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
  });
  const canWrite = companyId ? canWriteCompany(companyId, boardAccess) : false;

  const spacesQuery = useQuery({
    queryKey: queryKeys.spaces.list(companyId ?? ""),
    queryFn: () => spacesApi.list(companyId!),
    enabled: !!companyId,
  });
  // Archived Spaces leave the list; they are asked for only when shown.
  const archivedQuery = useQuery({
    queryKey: queryKeys.spaces.archived(companyId ?? ""),
    queryFn: () => spacesApi.list(companyId!, { archived: true }),
    enabled: !!companyId && showArchived,
  });

  if (!companyId) {
    return <EmptyState icon={Library} message="Select a company to see its Spaces." />;
  }
  if (spacesQuery.isLoading) return <PageSkeleton variant="list" />;

  const spaces = spacesQuery.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold">Spaces</h1>
            <InfoPopoverButton
              title="Spaces"
              info={
                <>
                  <p>
                    A Space holds pages for this company that are not tasks: handbooks,
                    standing rules, reference notes. A page can hold subpages, like the
                    chapters and sections of a book.
                  </p>
                  <p>Pages save as you type, and every saved version is kept.</p>
                  <p>
                    Not here yet: searching Spaces, and letting agents read them. Agents
                    cannot see Spaces for now.
                  </p>
                </>
              }
            />
          </div>
          <p className="text-sm text-muted-foreground">
            Pages for this company that are not tasks, such as handbooks and standing rules.
          </p>
        </div>
        {canWrite && (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            New Space
          </Button>
        )}
      </div>

      {spacesQuery.error && <p className="text-sm text-destructive">{spacesQuery.error.message}</p>}

      {/* An empty list is only "no Spaces yet" when the list loaded: a failed
          load offering to make the first one led to duplicate Spaces. */}
      {spaces.length === 0 && spacesQuery.error ? null : spaces.length === 0 ? (
        <EmptyState
          icon={Library}
          message="No Spaces yet. A Space holds pages and subpages, like the chapters and sections of a handbook."
          action={canWrite ? "New Space" : undefined}
          onAction={canWrite ? () => setCreateOpen(true) : undefined}
        />
      ) : (
        <SpaceList spaces={spaces} />
      )}

      {!spacesQuery.error && (
        <div>
          <Button size="sm" variant="ghost" aria-expanded={showArchived} onClick={() => setShowArchived((shown) => !shown)}>
            <Archive className="h-3.5 w-3.5" />
            {showArchived ? "Hide archived Spaces" : "Show archived Spaces"}
          </Button>
        </div>
      )}
      {showArchived && (
        <section aria-label="Archived Spaces" className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">Archived</h2>
          {archivedQuery.error ? (
            <p className="text-sm text-destructive">{archivedQuery.error.message}</p>
          ) : archivedQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading the archived Spaces…</p>
          ) : (archivedQuery.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No archived Spaces.</p>
          ) : (
            <SpaceList spaces={archivedQuery.data ?? []} />
          )}
        </section>
      )}

      <NewSpaceDialog companyId={companyId} open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function SpaceList({ spaces }: { spaces: SpaceListItem[] }) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-card">
      {spaces.map((space) => (
        <li key={space.id}>
          <Link
            to={`/spaces/${space.urlKey}`}
            className="flex items-start gap-3 px-4 py-3 text-foreground no-underline transition-colors hover:bg-accent/50"
          >
            <Library className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{space.name}</span>
              {space.description && (
                <span className="mt-0.5 text-sm text-muted-foreground line-clamp-2">
                  {space.description}
                </span>
              )}
            </span>
            <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">
              {space.archivedAt ? "Archived" : pageCountLabel(space.pageCount)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function NewSpaceDialog({
  companyId,
  open,
  onOpenChange,
}: {
  companyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useOptionalToastActions();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // Which opening of the dialog a create was sent from (hooks/useDialogOpening.ts).
  const opening = useDialogOpening(open);

  const create = useMutation({
    mutationFn: (sent: { name: string; description: string; opening: DialogOpening | null }) =>
      spacesApi.create(companyId, { name: sent.name, description: sent.description || null }),
    onSuccess: async (space, sent) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.spaces.list(companyId) });
      // Made after the dialog it came from had gone: change nothing the
      // person has moved on to.
      if (!opening.isShowing(sent.opening)) return;
      reset();
      onOpenChange(false);
      navigate(`/spaces/${space.urlKey}`);
    },
    // The dialog says a failure itself. Once it has gone, a toast is the only
    // place left to say it.
    onError: (error, sent) => {
      if (opening.isShowing(sent.opening)) return;
      toast?.pushToast({
        tone: "error",
        title: "Could not create the Space",
        body: error instanceof Error && error.message ? error.message : "Please try again.",
      });
    },
  });

  function reset() {
    setName("");
    setDescription("");
    create.reset();
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!name.trim() || create.isPending) return;
    create.mutate({ name: name.trim(), description: description.trim(), opening: opening.current() });
  }

  const failure = create.isError
    ? `Could not create the Space. ${create.error instanceof Error && create.error.message ? create.error.message : "Please try again."}`
    : null;
  const message = create.isPending ? "Creating the Space…" : failure;

  return (
    <Dialog
      open={open}
      // Held open until the Space is made or fails, so a failure always has
      // the dialog it came from to be said in.
      onOpenChange={(next) => {
        if (create.isPending) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent showCloseButton={!create.isPending}>
        <DialogHeader>
          <DialogTitle>New Space</DialogTitle>
          <DialogDescription>A shelf of pages for this company. Add its pages once it is made.</DialogDescription>
        </DialogHeader>
        <form id="new-space-form" onSubmit={submit}>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="new-space-name">Name</Label>
              <Input
                id="new-space-name"
                value={name}
                maxLength={SPACE_NAME_MAX}
                onChange={(event) => setName(event.target.value)}
                placeholder="Sales handbook"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-space-description">Short description (optional)</Label>
              <Textarea
                id="new-space-description"
                value={description}
                maxLength={SPACE_DESCRIPTION_MAX}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
                placeholder="What belongs here"
              />
            </div>
          </div>
          {/* On the page even while empty, so a screen reader hears a failure
              when it appears. Its margin only comes with its text. */}
          <p
            role="status"
            className={cn("text-xs", message && "mt-3", failure ? "text-destructive" : "text-muted-foreground")}
          >
            {message}
          </p>
        </form>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={create.isPending}
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button type="submit" form="new-space-form" disabled={!name.trim() || create.isPending}>
            {create.isPending ? "Creating…" : "Create Space"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
