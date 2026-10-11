import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SPACE_DESCRIPTION_MAX, SPACE_NAME_MAX, type Space, type UpdateSpace } from "@paperclipai/shared";
import { spacesApi } from "../api/spaces";
import { queryKeys } from "../lib/queryKeys";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/** Changes a Space, then brings the company's lists of Spaces and this one up to date. */
export function useUpdateSpace(space: Pick<Space, "id" | "companyId">) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (change: UpdateSpace) => spacesApi.update(space.id, change),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.spaces.list(space.companyId) }),
  });
}

/**
 * A Space's name and description, and archiving it. An archived Space leaves
 * the list of Spaces and is read only until it is unarchived; its address
 * still opens it.
 */
export function SpaceSettingsDialog({
  space,
  open,
  onOpenChange,
}: {
  space: Space;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const update = useUpdateSpace(space);
  const [name, setName] = useState(space.name);
  const [description, setDescription] = useState(space.description ?? "");
  const archived = Boolean(space.archivedAt);

  useEffect(() => {
    if (!open) return;
    setName(space.name);
    setDescription(space.description ?? "");
    update.reset();
    // Starts from the Space as it is, each time the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const changed = name.trim() !== space.name || description.trim() !== (space.description ?? "");
  const close = () => onOpenChange(false);

  function save(event?: FormEvent) {
    event?.preventDefault();
    if (archived || !changed || !name.trim() || update.isPending) return;
    update.mutate({ name: name.trim(), description: description.trim() || null }, { onSuccess: close });
  }

  const failure = update.isError
    ? `Could not change the Space. ${update.error instanceof Error && update.error.message ? update.error.message : "Please try again."}`
    : null;
  const message = update.isPending ? "Saving…" : failure;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (update.isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent showCloseButton={!update.isPending}>
        <DialogHeader>
          <DialogTitle>Space settings</DialogTitle>
          <DialogDescription>
            {archived ? "This Space is archived. Unarchive it to change it." : "Its address stays the same when you rename it."}
          </DialogDescription>
        </DialogHeader>
        <div>
          <form id="space-settings-form" onSubmit={save} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="space-settings-name">Name</Label>
              <Input
                id="space-settings-name"
                value={name}
                maxLength={SPACE_NAME_MAX}
                disabled={archived || update.isPending}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="space-settings-description">Short description (optional)</Label>
              <Textarea
                id="space-settings-description"
                value={description}
                maxLength={SPACE_DESCRIPTION_MAX}
                disabled={archived || update.isPending}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
              />
            </div>
          </form>
          <section className="mt-4 space-y-2 rounded-md border border-border p-3">
            <h3 className="text-sm font-medium">{archived ? "Archived" : "Archive"}</h3>
            <p className="text-xs text-muted-foreground">
              {archived
                ? "It is not in the list of Spaces, and its pages are read only. Unarchive it to change them again."
                : "An archived Space leaves the list of Spaces and its pages become read only. Its address still opens it, and you can unarchive it at any time."}
            </p>
            {/* Archiving sends nothing else, and an archived Space cannot be
                renamed, so changes typed above would be lost without a word. */}
            {!archived && changed && (
              <p className="text-xs text-muted-foreground">Save or cancel the changes above first.</p>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={update.isPending || (!archived && changed)}
              onClick={() => update.mutate({ archived: !archived }, { onSuccess: close })}
            >
              {archived ? "Unarchive" : "Archive"}
            </Button>
          </section>
          {/* On the page even while empty, so a screen reader hears a failure.
              Its margin only comes with its text. */}
          <p role="status" className={cn("text-xs", message && "mt-3", failure ? "text-destructive" : "text-muted-foreground")}>
            {message}
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={update.isPending} onClick={close}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="space-settings-form"
            disabled={archived || !changed || !name.trim() || update.isPending}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
