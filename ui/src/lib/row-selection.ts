/**
 * Selecting rows in a list: click, shift-click a range, select all, clear.
 *
 * Kept as plain functions over a Set rather than hidden inside a component,
 * because the fiddly parts (what shift-click does when the anchor has since
 * disappeared, what "select all" means when the list is filtered) are exactly
 * the parts worth testing.
 */

export interface RowSelection {
  selected: ReadonlySet<string>;
  /** The row a shift-click measures its range from. */
  anchorId: string | null;
}

export const EMPTY_SELECTION: RowSelection = { selected: new Set<string>(), anchorId: null };

export function isSelected(selection: RowSelection, id: string): boolean {
  return selection.selected.has(id);
}

/** A plain click: flip this row, and make it the anchor for a later shift-click. */
export function toggleRow(selection: RowSelection, id: string): RowSelection {
  const selected = new Set(selection.selected);
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  return { selected, anchorId: id };
}

/**
 * Shift-click: add everything between the anchor and this row.
 *
 * Ranges only ever add. Making a range subtract as well means a shift-click
 * that happens to start on a selected row silently unpicks work the operator
 * had already chosen, which is unrecoverable without redoing the whole
 * selection.
 */
export function selectRange(
  selection: RowSelection,
  orderedIds: readonly string[],
  targetId: string,
): RowSelection {
  const anchorIndex = selection.anchorId === null ? -1 : orderedIds.indexOf(selection.anchorId);
  const targetIndex = orderedIds.indexOf(targetId);
  if (targetIndex < 0) return selection;

  // No anchor, or the anchor has since left the list (someone else closed it,
  // or a filter moved on). Treat it as an ordinary click rather than guessing
  // at a range from a row that is no longer there.
  if (anchorIndex < 0) return toggleRow(selection, targetId);

  const from = Math.min(anchorIndex, targetIndex);
  const to = Math.max(anchorIndex, targetIndex);
  const selected = new Set(selection.selected);
  for (let index = from; index <= to; index += 1) selected.add(orderedIds[index]!);
  // The anchor stays put, so dragging a shift-click back and forth keeps
  // measuring from the same place.
  return { selected, anchorId: selection.anchorId };
}

/** Select every row currently on screen; "all" never means rows you cannot see. */
export function selectAll(orderedIds: readonly string[]): RowSelection {
  return { selected: new Set(orderedIds), anchorId: orderedIds[orderedIds.length - 1] ?? null };
}

export function clearSelection(): RowSelection {
  return { selected: new Set<string>(), anchorId: null };
}

/**
 * Drop anything no longer in the list. Rows disappear underneath you here: the
 * list refetches every 30 seconds, and triage actions remove rows. Without
 * this, the count says 12 while only 9 rows exist, and a bulk action fires at
 * conversations that are already closed.
 */
export function pruneSelection(selection: RowSelection, orderedIds: readonly string[]): RowSelection {
  const present = new Set(orderedIds);
  let changed = false;
  const selected = new Set<string>();
  for (const id of selection.selected) {
    if (present.has(id)) selected.add(id);
    else changed = true;
  }
  const anchorId = selection.anchorId !== null && present.has(selection.anchorId)
    ? selection.anchorId
    : null;
  if (!changed && anchorId === selection.anchorId) return selection;
  return { selected, anchorId };
}

/** Whether the header checkbox should read checked, indeterminate, or empty. */
export function selectAllState(
  selection: RowSelection,
  orderedIds: readonly string[],
): "none" | "some" | "all" {
  if (orderedIds.length === 0) return "none";
  let count = 0;
  for (const id of orderedIds) if (selection.selected.has(id)) count += 1;
  if (count === 0) return "none";
  return count === orderedIds.length ? "all" : "some";
}

/** The selected rows, in the order they appear on screen. */
export function selectedInOrder<T>(
  selection: RowSelection,
  rows: readonly T[],
  idOf: (row: T) => string,
): T[] {
  return rows.filter((row) => selection.selected.has(idOf(row)));
}
