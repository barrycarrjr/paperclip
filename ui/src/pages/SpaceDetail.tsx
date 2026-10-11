import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, FileText, Library, Plus, Settings, Trash2 } from "lucide-react";
import type { Space, SpacePageTreeNode } from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { spacesApi } from "@/api/spaces";
import { EmptyState } from "@/components/EmptyState";
import { InlineBanner } from "@/components/InlineBanner";
import { PageSkeleton } from "@/components/PageSkeleton";
import { NEW_SPACE_PAGE_TITLE, SpacePageEditor } from "@/components/SpacePageEditor";
import { SpacePageMenu } from "@/components/SpacePageMenu";
import { SpaceSettingsDialog, useUpdateSpace } from "@/components/SpaceSettingsDialog";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs, type Breadcrumb } from "@/context/BreadcrumbContext";
import { useActiveCompanyId } from "@/hooks/useRouteCompany";
import { useSaveMutation } from "@/hooks/useSaveMutation";
import { canWriteCompany } from "@/lib/company-access";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useNavigate, useParams } from "@/lib/router";
import { findSpacePage, spacePageHref, spacePageIndentPx, spacePageSubtreeIds, spacePageTitle } from "@/lib/space-pages";
import { cn } from "@/lib/utils";

/** What a page's menu does to the page that is open, when it moves or goes to the trash with it. */
interface PageMenuActions {
  onMoved: (page: SpacePageTreeNode, to: Pick<Space, "id" | "urlKey">) => void;
  onDeleted: (page: SpacePageTreeNode) => void;
}

/**
 * A Space and its pages: /<company>/spaces/<space> lists the nested pages,
 * and /<company>/spaces/<space>/<page> opens one, with the pages beside it
 * where the page area is wide enough.
 */
export function SpaceDetail() {
  const { spaceKey = "", pageId } = useParams<{ spaceKey: string; pageId?: string }>();
  const companyId = useActiveCompanyId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);

  const accessQuery = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
  });
  const canWrite = companyId ? canWriteCompany(companyId, accessQuery.data) : false;

  const spaceQuery = useQuery({
    queryKey: queryKeys.spaces.detail(companyId ?? "", spaceKey),
    queryFn: () => spacesApi.get(companyId!, spaceKey),
    enabled: !!companyId && !!spaceKey,
  });
  const space = spaceQuery.data ?? null;
  // An archived Space is read only until it is unarchived.
  const canEdit = canWrite && !!space && !space.archivedAt;

  const treeQuery = useQuery({
    queryKey: queryKeys.spaces.pageTree(space?.id ?? ""),
    queryFn: () => spacesApi.pageTree(space!.id),
    enabled: !!space,
  });
  const tree = useMemo(() => treeQuery.data ?? [], [treeQuery.data]);
  const currentPage = useMemo(() => (pageId ? findSpacePage(tree, pageId) : null), [tree, pageId]);

  // An address names the page's Space, so a page moved to another Space is
  // not found at its old address (a saved link, an activity row). Ask where
  // it is now and go there.
  const pageNotHere = !!pageId && (spaceQuery.isError || (!!space && treeQuery.isSuccess && !currentPage));
  const locationQuery = useQuery({
    queryKey: queryKeys.spaces.pageLocation(companyId ?? "", pageId ?? ""),
    queryFn: () => spacesApi.locatePage(companyId!, pageId!),
    enabled: !!companyId && pageNotHere,
    retry: false,
  });
  const location = locationQuery.data;
  useEffect(() => {
    if (!pageId || !location || location.pageId !== pageId || location.spaceId === space?.id) return;
    navigate(spacePageHref({ urlKey: location.spaceUrlKey }, pageId), { replace: true });
  }, [location, navigate, pageId, space?.id]);

  useEffect(() => {
    const crumbs: Breadcrumb[] = [{ label: "Spaces", href: "/spaces" }];
    if (space && pageId) {
      // The Space and the page, not every page between them: a longer trail
      // leaves no room for the page's own name on a phone. The pages above it
      // are in the Space's list of pages.
      crumbs.push({ label: space.name, href: `/spaces/${space.urlKey}` });
      crumbs.push({ label: currentPage ? spacePageTitle(currentPage.title) : "Page" });
    } else if (space) {
      crumbs.push({ label: space.name });
    }
    setBreadcrumbs(crumbs);
  }, [currentPage, pageId, setBreadcrumbs, space]);

  const createPage = useSaveMutation({
    mutationFn: (input: { space: Space; parentPageId: string | null }) =>
      spacesApi.createPage(input.space.id, { title: NEW_SPACE_PAGE_TITLE, parentPageId: input.parentPageId }),
    // The new page opens, which says it worked.
    successMessage: () => null,
    errorMessage: "Could not add the page",
    onSuccess: async (page, input) => {
      if (input.parentPageId) {
        const parentPageId = input.parentPageId;
        setCollapsed((current) => {
          if (!current.has(parentPageId)) return current;
          const next = new Set(current);
          next.delete(parentPageId);
          return next;
        });
      }
      queryClient.setQueryData(queryKeys.spaces.page(page.spaceId, page.id), page);
      await queryClient.invalidateQueries({ queryKey: queryKeys.spaces.pageTree(page.spaceId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.spaces.list(page.companyId) });
      navigate(spacePageHref(input.space, page.id));
    },
  });

  const unarchive = useUpdateSpace(space ?? { id: "", companyId: companyId ?? "" });

  if (!companyId) {
    return <EmptyState icon={Library} message="Select a company to see its Spaces." />;
  }
  if (spaceQuery.isLoading || accessQuery.isLoading) return <PageSkeleton variant="detail" />;
  if (!space) {
    if (pageNotHere && (locationQuery.isLoading || location)) return <PageSkeleton variant="detail" />;
    return (
      <EmptyState
        icon={Library}
        message={spaceQuery.error ? spaceQuery.error.message : "This Space could not be found."}
      />
    );
  }

  const addPage = (parentPageId: string | null) => {
    if (!createPage.isPending) createPage.mutate({ space, parentPageId });
  };
  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // The open page is followed where it went, with its own move or with a
  // page above it, and left when it went to the trash.
  const menuActions: PageMenuActions = {
    onMoved: (moved, to) => {
      if (pageId && to.id !== space.id && spacePageSubtreeIds(moved).has(pageId)) navigate(spacePageHref(to, pageId));
    },
    onDeleted: (deleted) => {
      if (pageId && spacePageSubtreeIds(deleted).has(pageId)) navigate(`/spaces/${space.urlKey}`);
    },
  };
  const findingPage = pageNotHere && (locationQuery.isLoading || (!!location && location.spaceId !== space.id));

  const archivedNotice = space.archivedAt ? (
    <InlineBanner
      tone="info"
      title="This Space is archived"
      actions={
        canWrite ? (
          <Button
            size="sm"
            variant="outline"
            disabled={unarchive.isPending}
            onClick={() => unarchive.mutate({ archived: false })}
          >
            {unarchive.isPending ? "Unarchiving…" : "Unarchive"}
          </Button>
        ) : undefined
      }
    >
      <p>It is read only until it is unarchived, and it is not in the list of Spaces.</p>
      {unarchive.isError && <p className="text-destructive">Could not unarchive it. {unarchive.error.message}</p>}
    </InlineBanner>
  ) : null;

  const pageTree = treeQuery.error ? (
    <p className="px-2 py-3 text-sm text-destructive">{treeQuery.error.message}</p>
  ) : treeQuery.isLoading ? (
    <p className="px-2 py-3 text-sm text-muted-foreground">Loading the pages…</p>
  ) : (
    <SpacePageTree
      space={space}
      tree={tree}
      nodes={tree}
      currentPageId={pageId ?? null}
      collapsed={collapsed}
      onToggle={toggle}
      canEdit={canEdit}
      onAddSubpage={addPage}
      adding={createPage.isPending}
      menuActions={menuActions}
    />
  );

  if (!pageId) {
    return (
      <div className="max-w-3xl space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h1 className="text-xl font-bold">{space.name}</h1>
            {space.description && <p className="text-sm text-muted-foreground">{space.description}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm" variant="ghost">
              {/* Not a task, even in a Space whose address is "issues". */}
              <Link to={`/spaces/${space.urlKey}/trash`} disableIssueQuicklook>
                <Trash2 className="h-3.5 w-3.5" />
                Trash
              </Link>
            </Button>
            {canWrite && (
              <Button size="sm" variant="ghost" onClick={() => setSettingsOpen(true)}>
                <Settings className="h-3.5 w-3.5" />
                Settings
              </Button>
            )}
            {canEdit && (
              <Button size="sm" onClick={() => addPage(null)} disabled={createPage.isPending}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                {createPage.isPending ? "Adding…" : "New page"}
              </Button>
            )}
          </div>
        </div>
        {archivedNotice}
        {tree.length === 0 && !treeQuery.isLoading && !treeQuery.error ? (
          <EmptyState
            icon={FileText}
            message={canEdit ? "No pages yet. Add the first one, then give it subpages as it grows." : "No pages yet."}
            action={canEdit ? "New page" : undefined}
            onAction={canEdit ? () => addPage(null) : undefined}
          />
        ) : (
          <div className="rounded-md border border-border bg-card p-1">{pageTree}</div>
        )}
        {canWrite && <SpaceSettingsDialog space={space} open={settingsOpen} onOpenChange={setSettingsOpen} />}
      </div>
    );
  }

  return (
    <div className="grid gap-6 @4xl:grid-cols-[16rem_minmax(0,1fr)]">
      {/* Beside the page only where the page area is wide enough. Narrower,
          the Space's own address lists the pages, a step back up the trail. */}
      <nav aria-label={`Pages in ${space.name}`} className="hidden min-w-0 @4xl:block">
        <div className="mb-1 flex items-center justify-between gap-2 pl-2">
          <Link
            to={`/spaces/${space.urlKey}`}
            className="truncate text-sm font-semibold text-foreground no-underline hover:underline"
            title={space.name}
          >
            {space.name}
          </Link>
          {canEdit && (
            <button
              type="button"
              aria-label={`Add a page to ${space.name}`}
              title="New page"
              onClick={() => addPage(null)}
              disabled={createPage.isPending}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {pageTree}
      </nav>
      <div className="min-w-0 space-y-3">
        {archivedNotice}
        {findingPage ? (
          <p className="text-sm text-muted-foreground">Finding the page…</p>
        ) : (
          <SpacePageEditor
            key={pageId}
            space={space}
            pageId={pageId}
            canWrite={canEdit}
            currentUserId={accessQuery.data?.userId ?? null}
            onAddSubpage={canEdit ? () => addPage(pageId) : undefined}
            addingSubpage={createPage.isPending}
            pageMenu={
              canEdit && currentPage ? (
                <SpacePageMenu space={space} tree={tree} page={currentPage} {...menuActions} />
              ) : undefined
            }
          />
        )}
      </div>
    </div>
  );
}

function SpacePageTree({
  space,
  tree,
  nodes,
  currentPageId,
  collapsed,
  onToggle,
  canEdit,
  onAddSubpage,
  adding,
  menuActions,
  depth = 0,
}: {
  space: Space;
  /** The whole tree, for each page's menu. */
  tree: SpacePageTreeNode[];
  nodes: SpacePageTreeNode[];
  currentPageId: string | null;
  collapsed: Set<string>;
  onToggle: (pageId: string) => void;
  canEdit: boolean;
  onAddSubpage: (parentPageId: string) => void;
  adding: boolean;
  menuActions: PageMenuActions;
  depth?: number;
}): ReactNode {
  return (
    <ul className="space-y-px">
      {nodes.map((node) => {
        const title = spacePageTitle(node.title);
        const hasChildren = node.children.length > 0;
        const expanded = hasChildren && !collapsed.has(node.id);
        const current = node.id === currentPageId;
        return (
          <li key={node.id}>
            <div
              className={cn(
                "group grid items-center rounded-md transition-colors hover:bg-accent/50",
                canEdit ? "grid-cols-[1.75rem_minmax(0,1fr)_2.25rem_2.25rem]" : "grid-cols-[1.75rem_minmax(0,1fr)]",
                current && "bg-accent hover:bg-accent",
              )}
              style={{ paddingInlineStart: `${spacePageIndentPx(depth)}px` }}
            >
              {hasChildren ? (
                <button
                  type="button"
                  onClick={() => onToggle(node.id)}
                  aria-expanded={expanded}
                  aria-label={expanded ? `Hide the subpages of ${title}` : `Show the subpages of ${title}`}
                  className="flex h-9 w-7 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                >
                  {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
              ) : (
                <span className="flex h-9 w-7 items-center justify-center text-muted-foreground" aria-hidden>
                  <FileText className="h-3.5 w-3.5" />
                </span>
              )}
              {/* Not a task, even in a Space whose address is "issues": a
                  path with "issues" in it is otherwise read as a task link. */}
              <Link
                to={spacePageHref(space, node.id)}
                disableIssueQuicklook
                aria-current={current ? "page" : undefined}
                title={title}
                className={cn(
                  "truncate py-2 pr-1 text-sm no-underline",
                  current ? "font-medium text-accent-foreground" : "text-foreground",
                )}
              >
                {title}
              </Link>
              {canEdit && (
                <>
                  <button
                    type="button"
                    onClick={() => onAddSubpage(node.id)}
                    disabled={adding}
                    aria-label={`Add a subpage to ${title}`}
                    title="Add a subpage"
                    className="flex h-9 w-9 items-center justify-center rounded-sm text-muted-foreground opacity-60 transition-[background-color,color,opacity] hover:bg-accent hover:text-foreground hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-30"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                  <SpacePageMenu
                    space={space}
                    tree={tree}
                    page={node}
                    {...menuActions}
                    className="opacity-60 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                  />
                </>
              )}
            </div>
            {expanded && (
              <SpacePageTree
                space={space}
                tree={tree}
                nodes={node.children}
                currentPageId={currentPageId}
                collapsed={collapsed}
                onToggle={onToggle}
                canEdit={canEdit}
                onAddSubpage={onAddSubpage}
                adding={adding}
                menuActions={menuActions}
                depth={depth + 1}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
