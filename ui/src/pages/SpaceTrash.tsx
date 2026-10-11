import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Library, Trash2 } from "lucide-react";
import type { SpaceTrashItem } from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { spacesApi } from "@/api/spaces";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useActiveCompanyId } from "@/hooks/useRouteCompany";
import { useSaveMutation } from "@/hooks/useSaveMutation";
import { canWriteCompany } from "@/lib/company-access";
import { queryKeys } from "@/lib/queryKeys";
import { useParams } from "@/lib/router";
import { spacePageTitle } from "@/lib/space-pages";
import { relativeTime } from "@/lib/utils";

/**
 * A Space's trash, /<company>/spaces/<space>/trash: each page that was
 * deleted, with how many subpages went with it. Restoring one brings its
 * subpages back with it.
 */
export function SpaceTrash() {
  const { spaceKey = "" } = useParams<{ spaceKey: string }>();
  const companyId = useActiveCompanyId();
  const queryClient = useQueryClient();
  const { setBreadcrumbs } = useBreadcrumbs();

  const accessQuery = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
  });
  const spaceQuery = useQuery({
    queryKey: queryKeys.spaces.detail(companyId ?? "", spaceKey),
    queryFn: () => spacesApi.get(companyId!, spaceKey),
    enabled: !!companyId && !!spaceKey,
  });
  const space = spaceQuery.data ?? null;
  // Nothing comes back into an archived Space until it is unarchived.
  const canRestore = !!companyId && canWriteCompany(companyId, accessQuery.data) && !!space && !space.archivedAt;

  const trashQuery = useQuery({
    queryKey: queryKeys.spaces.trash(space?.id ?? ""),
    queryFn: () => spacesApi.trash(space!.id),
    enabled: !!space,
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Spaces", href: "/spaces" },
      ...(space ? [{ label: space.name, href: `/spaces/${space.urlKey}` }] : []),
      { label: "Trash" },
    ]);
  }, [setBreadcrumbs, space]);

  const restore = useSaveMutation({
    mutationFn: (item: SpaceTrashItem) => spacesApi.restoreFromTrash(item.spaceId, item.id),
    successMessage: (_result, item) => `Restored ${spacePageTitle(item.title)}`,
    errorMessage: "Could not restore the page",
    onSuccess: async (_result, item) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.trash(item.spaceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.pageTree(item.spaceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.list(item.companyId) }),
      ]);
    },
  });

  if (!companyId) {
    return <EmptyState icon={Library} message="Select a company to see its Spaces." />;
  }
  if (spaceQuery.isLoading || accessQuery.isLoading) return <PageSkeleton variant="list" />;
  if (!space) {
    return <EmptyState icon={Library} message={spaceQuery.error ? spaceQuery.error.message : "This Space could not be found."} />;
  }

  const items = trashQuery.data ?? [];

  return (
    <div className="max-w-3xl space-y-4">
      <div className="min-w-0 space-y-1">
        <h1 className="text-xl font-bold">Trash</h1>
        <p className="text-sm text-muted-foreground">
          Pages deleted from {space.name}. A page comes back with the subpages that went with it.
          {space.archivedAt && " The Space is archived, so nothing can come back until it is unarchived."}
        </p>
      </div>

      {trashQuery.error ? (
        <p className="text-sm text-destructive">{trashQuery.error.message}</p>
      ) : trashQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading the trash…</p>
      ) : items.length === 0 ? (
        <EmptyState icon={Trash2} message="The trash is empty." />
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border bg-card">
          {items.map((item) => {
            const title = spacePageTitle(item.title);
            const restoring = restore.isPending && restore.variables?.id === item.id;
            return (
              <li key={item.id} className="flex items-center gap-3 px-4 py-3">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={title}>
                    {title}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {item.subpageCount === 1
                      ? "With 1 subpage · "
                      : item.subpageCount > 1
                        ? `With ${item.subpageCount} subpages · `
                        : ""}
                    Deleted {relativeTime(item.deletedAt)}
                  </p>
                </div>
                {canRestore && (
                  <Button size="sm" variant="outline" disabled={restore.isPending} onClick={() => restore.mutate(item)}>
                    {restoring ? "Restoring…" : "Restore"}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
