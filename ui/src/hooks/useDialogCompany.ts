import { useEffect, useState } from "react";
import { useActiveCompanyId } from "./useRouteCompany";

/**
 * The company a dialog is filling a form in, fixed at the moment it opened.
 *
 * Dialogs are mounted once for the whole app (see Layout.tsx), so they stay
 * open and keep their typed text when you change company. Reading the live
 * company selection while one is open means the Create button files the
 * record in whichever company you happen to be in when you press it, using
 * ids (a parent goal, a linked goal) that belong to the company you started
 * in. The scope document
 * (docs/plans/2026-09-02-ux-control-center-scope.md) rules that out: "Decide
 * explicitly what happens to unsaved forms; preserve them with their
 * original scope or prompt, never silently retarget."
 *
 * So the form keeps its original company. This is the same choice
 * NewIssueDialog.tsx already makes with its `dialogCompanyId` state, written
 * once here so the other dialogs do not each invent their own version of it.
 *
 * The company is read from the web address rather than from the context
 * selection, for the reason hooks/useRouteCompany.ts sets out: the selection
 * is synced from the route by an effect, so it is one render behind on the
 * first render after a cross-company move.
 *
 * Returns the live company while the dialog is closed, so a closed dialog's
 * queries stay pointed at the company you are actually in.
 */
export function useDialogCompanyId(open: boolean): string | null {
  const activeCompanyId = useActiveCompanyId();
  const [pinnedCompanyId, setPinnedCompanyId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setPinnedCompanyId(null);
      return;
    }
    setPinnedCompanyId((current) => current ?? activeCompanyId);
  }, [open, activeCompanyId]);

  return pinnedCompanyId ?? activeCompanyId;
}
