/**
 * Pure reordering math for dragging an item in the pinned workspaces list
 * (SidebarMenu.tsx's "Your workspaces" section).
 *
 * Split out from usePinnedWorkspaces.ts so this merge logic can be unit
 * tested without mounting the hook's react-query plumbing.
 *
 * `visibleIds` is the subset of `pinned` a caller is actually showing right
 * now — a pin the current company cannot open is filtered out before
 * rendering (see resolvePinnedWorkspaceItems in workspace-catalog.ts), so a
 * drag can only ever reference ids from that subset. Ids outside it — pinned,
 * but not shown in this company — must keep their exact position; only the
 * visible ones move among themselves. Returns the same `pinned` reference,
 * unchanged, when there is nothing to do, so a caller can skip writing on a
 * no-op drag with a simple identity check.
 */
export function reorderPinnedIds(
  pinned: string[],
  activeId: string,
  overId: string,
  visibleIds: string[],
): string[] {
  if (activeId === overId) return pinned;
  const oldIndex = visibleIds.indexOf(activeId);
  const newIndex = visibleIds.indexOf(overId);
  if (oldIndex === -1 || newIndex === -1) return pinned;

  const reorderedVisible = visibleIds.slice();
  const [moved] = reorderedVisible.splice(oldIndex, 1);
  reorderedVisible.splice(newIndex, 0, moved);

  const visibleSet = new Set(visibleIds);
  let cursor = 0;
  return pinned.map((id) => (visibleSet.has(id) ? reorderedVisible[cursor++] : id));
}
