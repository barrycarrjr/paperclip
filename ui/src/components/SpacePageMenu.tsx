import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, FolderInput, MoreHorizontal, Trash2 } from "lucide-react";
import type { Space, SpacePageTreeNode, SpaceTrashChange } from "@paperclipai/shared";
import { spacesApi } from "../api/spaces";
import { useOptionalToastActions } from "../context/ToastContext";
import { useDialogOpening, type DialogOpening } from "../hooks/useDialogOpening";
import { useSaveMutation } from "../hooks/useSaveMutation";
import { queryKeys } from "../lib/queryKeys";
import {
  flattenSpacePageTree,
  spacePageIndentPx,
  spacePageSiblings,
  spacePageSubtreeIds,
  spacePageTitle,
} from "../lib/space-pages";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";

function reasonOf(error: unknown) {
  return error instanceof Error && error.message ? error.message : "Please try again.";
}

function subpagesLabel(count: number) {
  return count === 1 ? "1 subpage" : `${count} subpages`;
}

interface SpacePageMenuProps {
  space: Space;
  /** The Space's whole tree, for the page's neighbours and its subpages. */
  tree: SpacePageTreeNode[];
  page: SpacePageTreeNode;
  /** After a move: the page as it was, with its subpages, and the Space it is in now. */
  onMoved?: (page: SpacePageTreeNode, to: Pick<Space, "id" | "urlKey">) => void;
  /** After the page went to the trash with its subpages. */
  onDeleted?: (page: SpacePageTreeNode) => void;
  className?: string;
}

/**
 * A page's menu: put it in order among its neighbours, move it with its
 * subpages elsewhere, or send them to the trash. No dragging, so it works the
 * same on a phone.
 */
export function SpacePageMenu({ space, tree, page, onMoved, onDeleted, className }: SpacePageMenuProps) {
  const queryClient = useQueryClient();
  const [moveOpen, setMoveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const title = spacePageTitle(page.title);
  const siblings = spacePageSiblings(tree, page);
  const index = siblings.findIndex((sibling) => sibling.id === page.id);

  const reorder = useSaveMutation({
    mutationFn: (to: number) => spacesApi.movePage(space.id, page.id, { parentPageId: page.parentPageId, index: to }),
    // The list shows the new order.
    successMessage: () => null,
    errorMessage: "Could not move the page",
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.spaces.pageTree(space.id) }),
  });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Page options for ${title}`}
            title="Page options"
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              className,
            )}
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={index <= 0 || reorder.isPending} onSelect={() => reorder.mutate(index - 1)}>
            <ArrowUp />
            Move up
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={index === -1 || index >= siblings.length - 1 || reorder.isPending}
            onSelect={() => reorder.mutate(index + 1)}
          >
            <ArrowDown />
            Move down
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setMoveOpen(true)}>
            <FolderInput />
            Move to…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
            <Trash2 />
            Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <MovePageDialog space={space} page={page} open={moveOpen} onOpenChange={setMoveOpen} onMoved={onMoved} />
      <DeletePageDialog space={space} page={page} open={deleteOpen} onOpenChange={setDeleteOpen} onDeleted={onDeleted} />
    </>
  );
}

interface PageDialogProps {
  space: Space;
  page: SpacePageTreeNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Where a page goes: a Space of the company, and the top level or a page there. */
export function MovePageDialog({
  space,
  page,
  open,
  onOpenChange,
  onMoved,
}: PageDialogProps & Pick<SpacePageMenuProps, "onMoved">) {
  const queryClient = useQueryClient();
  const toast = useOptionalToastActions();
  // Which opening of the dialog a move was sent from (hooks/useDialogOpening.ts).
  const opening = useDialogOpening(open);
  const [targetSpaceId, setTargetSpaceId] = useState(space.id);
  const [parentPageId, setParentPageId] = useState<string | null>(page.parentPageId);
  const title = spacePageTitle(page.title);

  const spacesQuery = useQuery({
    queryKey: queryKeys.spaces.list(space.companyId),
    queryFn: () => spacesApi.list(space.companyId),
    enabled: open,
  });
  const treeQuery = useQuery({
    queryKey: queryKeys.spaces.pageTree(targetSpaceId),
    queryFn: () => spacesApi.pageTree(targetSpaceId),
    enabled: open,
  });
  // The page cannot go under itself or its own subpages.
  const own = useMemo(() => spacePageSubtreeIds(page), [page]);
  const places = flattenSpacePageTree(treeQuery.data ?? []);
  const targets = spacesQuery.data ?? [];
  const target = targets.find((candidate) => candidate.id === targetSpaceId) ?? (targetSpaceId === space.id ? space : null);

  const move = useMutation({
    mutationFn: (sent: { target: Pick<Space, "id" | "urlKey">; parentPageId: string | null; opening: DialogOpening | null }) =>
      spacesApi.movePage(space.id, page.id, {
        ...(sent.target.id !== space.id ? { spaceId: sent.target.id } : {}),
        parentPageId: sent.parentPageId,
      }),
    onSuccess: async (_moved, sent) => {
      if (opening.isShowing(sent.opening)) onOpenChange(false);
      // First, so an open page that moved is followed before its old Space's
      // list of pages, without it, comes back.
      onMoved?.(page, sent.target);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.pageTree(space.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.pageTree(sent.target.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.list(space.companyId) }),
      ]);
    },
    // The dialog says a failure itself. Once it has gone, a toast is the only
    // place left to say it.
    onError: (error, sent) => {
      if (opening.isShowing(sent.opening)) return;
      toast?.pushToast({ tone: "error", title: "Could not move the page", body: reasonOf(error) });
    },
  });

  useEffect(() => {
    if (!open) return;
    setTargetSpaceId(space.id);
    setParentPageId(page.parentPageId);
    move.reset();
    // Starts from where the page is each time the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const stays = targetSpaceId === space.id && parentPageId === page.parentPageId;
  const failure = move.isError ? `Could not move the page. ${reasonOf(move.error)}` : null;
  const message = move.isPending ? "Moving the page…" : failure;

  const place = (key: string, label: string, depth: number, value: string | null, disabled = false) => {
    const chosen = parentPageId === value;
    return (
      <button
        key={key}
        type="button"
        role="radio"
        aria-checked={chosen}
        disabled={disabled || move.isPending}
        onClick={() => setParentPageId(value)}
        title={label}
        className={cn(
          "block w-full truncate rounded-sm py-2 pr-2 text-left text-sm transition-colors hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-50",
          chosen && "bg-accent font-medium hover:bg-accent",
        )}
        style={{ paddingInlineStart: `${8 + spacePageIndentPx(depth)}px` }}
      >
        {label}
      </button>
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (move.isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent showCloseButton={!move.isPending}>
        <DialogHeader>
          <DialogTitle>Move {title}</DialogTitle>
          <DialogDescription>Its subpages go with it.</DialogDescription>
        </DialogHeader>
        <div>
          <div className="space-y-1.5">
            <Label htmlFor="move-page-space">Space</Label>
            <select
              id="move-page-space"
              value={targetSpaceId}
              disabled={move.isPending}
              onChange={(event) => {
                setTargetSpaceId(event.target.value);
                setParentPageId(null);
              }}
              className="h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 text-sm"
            >
              {!targets.some((candidate) => candidate.id === space.id) && <option value={space.id}>{space.name}</option>}
              {targets.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </div>
          <div className="mt-3 space-y-1.5">
            <p id="move-page-place" className="text-sm font-medium">
              Put it under
            </p>
            <div
              role="radiogroup"
              aria-labelledby="move-page-place"
              className="max-h-[40dvh] space-y-px overflow-y-auto rounded-md border border-border p-1"
            >
              {place("top", `The top level of ${target?.name ?? "this Space"}`, 0, null)}
              {treeQuery.error ? (
                <p className="px-2 py-2 text-sm text-destructive">{treeQuery.error.message}</p>
              ) : treeQuery.isLoading ? (
                <p className="px-2 py-2 text-sm text-muted-foreground">Loading the pages…</p>
              ) : (
                places.map(({ node, depth }) => place(node.id, spacePageTitle(node.title), depth + 1, node.id, own.has(node.id)))
              )}
            </div>
          </div>
          {/* On the page even while empty, so a screen reader hears a failure.
              Its margin only comes with its text. */}
          <p role="status" className={cn("text-xs", message && "mt-3", failure ? "text-destructive" : "text-muted-foreground")}>
            {message}
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={move.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={stays || !target || move.isPending}
            onClick={() =>
              target && move.mutate({ target, parentPageId, opening: opening.current() })
            }
          >
            {move.isPending ? "Moving…" : "Move here"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Asks before a page and its subpages go to the trash. */
export function DeletePageDialog({
  space,
  page,
  open,
  onOpenChange,
  onDeleted,
}: PageDialogProps & Pick<SpacePageMenuProps, "onDeleted">) {
  const queryClient = useQueryClient();
  const toast = useOptionalToastActions();
  const opening = useDialogOpening(open);
  const title = spacePageTitle(page.title);
  const subpageCount = spacePageSubtreeIds(page).size - 1;

  const remove = useMutation({
    mutationFn: (_sent: { opening: DialogOpening | null }): Promise<SpaceTrashChange> => spacesApi.deletePage(space.id, page.id),
    onSuccess: async (_result, sent) => {
      if (opening.isShowing(sent.opening)) onOpenChange(false);
      // First, so an open page that went is left before the list of pages comes back without it.
      onDeleted?.(page);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.pageTree(space.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.trash(space.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.list(space.companyId) }),
      ]);
    },
    onError: (error, sent) => {
      if (opening.isShowing(sent.opening)) return;
      toast?.pushToast({ tone: "error", title: "Could not delete the page", body: reasonOf(error) });
    },
  });

  useEffect(() => {
    if (open) remove.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const failure = remove.isError ? `Could not delete the page. ${reasonOf(remove.error)}` : null;
  const message = remove.isPending ? "Deleting the page…" : failure;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (remove.isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent showCloseButton={!remove.isPending}>
        <div>
          <DialogHeader>
            <DialogTitle>Delete {title}?</DialogTitle>
            <DialogDescription>
              {subpageCount > 0
                ? `It goes to the trash of ${space.name} with its ${subpagesLabel(subpageCount)}. You can restore them from there.`
                : `It goes to the trash of ${space.name}. You can restore it from there.`}
            </DialogDescription>
          </DialogHeader>
          {/* On the page even while empty, so a screen reader hears a failure.
              Its margin only comes with its text. */}
          <p role="status" className={cn("text-xs", message && "mt-3", failure ? "text-destructive" : "text-muted-foreground")}>
            {message}
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={remove.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate({ opening: opening.current() })}
          >
            {remove.isPending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
