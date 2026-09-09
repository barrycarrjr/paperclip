// "shortcut" (B01, docs/plans/2026-09-02-ux-control-center-preservation.md):
// a hover-flyout/company-rail shortcut that both switches company and
// navigates to an explicit destination (SidebarNavItem.tsx's peek path) used
// to have to reuse "manual", the same source a plain "just switch company,
// restore wherever I was" rail click uses. useCompanyPageMemory couldn't
// tell the two apart and overwrote the shortcut's explicit destination with
// the remembered path (replace: true), reproducing the audit's
// "/PER/PER/notepad"/"/IND/IND/clippy" double-prefix symptom.
//
// Fixing this needed more than "skip the memory replay for 'shortcut'" —
// Layout.tsx documents a prior incident (PortfolioBrief's email-row link
// landing on the wrong company) caused by a sticky non-"route_sync" source
// blocking its own URL->company reconciliation once a switch has settled,
// and PortfolioBrief.tsx works around the same class of bug a second way
// (pre-flipping to "route_sync" before navigating). "shortcut" is threaded
// through every place "manual" already was for exactly that reason: it gets
// the same "let this finish navigating first" treatment in
// shouldSyncCompanySelectionFromRoute below and the same "flip back to
// route_sync once the URL has caught up" cleanup in Layout.tsx, so it can't
// go sticky and break a later cross-company <Link> click the way a
// once-off single-file fix already did for "manual". The one place it
// differs from "manual" is useCompanyPageMemory.ts's replay effect, which
// treats it like "route_sync" (the caller already knows where it's going —
// don't override that with a remembered path).
export type CompanySelectionSource = "manual" | "shortcut" | "route_sync" | "bootstrap";

export function shouldSyncCompanySelectionFromRoute(params: {
  selectionSource: CompanySelectionSource;
  selectedCompanyId: string | null;
  routeCompanyId: string;
}): boolean {
  const { selectionSource, selectedCompanyId, routeCompanyId } = params;

  if (selectedCompanyId === routeCompanyId) return false;

  // Let manual/shortcut company switches finish their own navigation first —
  // the same "manual"/"shortcut" pair shouldClearTransientSelectionSource
  // below names as transient, reused here (not re-listed) so a future third
  // transient source only needs updating in one place.
  if (shouldClearTransientSelectionSource(selectionSource) && selectedCompanyId) {
    return false;
  }

  return true;
}

/**
 * Whether useCompanyPageMemory.ts should navigate to the remembered path for
 * the newly-selected company. False for "route_sync" and "shortcut": both
 * mean the caller already navigated (or is about to) to a specific
 * destination, so restoring a remembered path would silently overwrite it.
 */
export function shouldRestoreRememberedPath(selectionSource: CompanySelectionSource): boolean {
  return selectionSource !== "route_sync" && selectionSource !== "shortcut";
}

/**
 * Whether Layout.tsx's URL-reconciliation effect should flip a transient
 * selection source back to "route_sync" once the route has caught up to the
 * selected company. True for "manual" and "shortcut": both are temporary —
 * needed only for the brief window before their own navigation settles — and
 * going sticky beyond that window blocks future URL-driven company changes
 * (the PortfolioBrief email-row regression documented above
 * CompanySelectionSource).
 */
export function shouldClearTransientSelectionSource(selectionSource: CompanySelectionSource): boolean {
  return selectionSource === "manual" || selectionSource === "shortcut";
}
