/**
 * Both the full Clippy page and the Clippy window keep their "which chat is
 * open" state in something that never remounts on a company switch (same
 * route/component instance for the page; the window's state lives in
 * ClippyContext, mounted once for the whole app in Layout.tsx). Left alone, a
 * chat opened under one company stays selected (and its full transcript
 * keeps rendering) after switching to a different company. These pure
 * functions decide what the open chat should become after a switch; the two
 * components apply the decision.
 *
 * A null session id is a new chat that has not been sent yet. Nothing is
 * created on the server until its first message goes (lib/clippy-new-chat.ts).
 */

/** Clippy.tsx: which session id (if any) should be active right now. */
export function resolveActiveClippySessionId(params: {
  companyScope: "current" | "all";
  activeId: string | null;
  sessionIds: string[];
  /** The person started a new chat: stay on it rather than opening the latest one. */
  drafting?: boolean;
}): string | null {
  const { companyScope, activeId, sessionIds, drafting = false } = params;
  if (drafting) return null;
  if (activeId !== null) {
    // "All companies" scope intentionally spans companies (see Clippy.tsx's
    // apiFilters) — a session id missing from this list means it was
    // archived/deleted elsewhere, not that it's stale for scope reasons.
    // Leave it as-is, matching this scope's original behavior.
    if (companyScope === "all") return activeId;
    if (sessionIds.includes(activeId)) return activeId;
  }
  return sessionIds[0] ?? null;
}

export type ClippyDrawerSessionReconciliation =
  | { action: "keep" }
  | { action: "select"; id: string }
  // Show a new chat. It is created on its first send, not here: creating
  // one on open is what filled the chat list with empty "New chat" entries.
  | { action: "draft" };

/**
 * Tracks enough state across renders to decide whether the drawer's
 * reconciliation effect (below) should actually run this time, or leave the
 * active session alone.
 */
export interface ClippyDrawerReconcileGate {
  /** Set true right before a deliberate user pick changes activeSessionId. */
  skip: boolean;
  /** The company reconciliation last actually ran for. `undefined` means "never yet". */
  reconciledForCompanyId: string | null | undefined;
}

export const INITIAL_CLIPPY_DRAWER_RECONCILE_GATE: ClippyDrawerReconcileGate = {
  skip: false,
  reconciledForCompanyId: undefined,
};

/**
 * ClippyContext.tsx: should the reconciliation effect run this render?
 *
 * The window's chat list deliberately lists sessions from every company
 * (F10's "company... filters" requirement), so picking one for a company
 * other than the current selection is a legitimate action, not a stale
 * session. Naively re-running `reconcileClippyDrawerSession` on every
 * `activeSessionId` change (the original bullet-7 fix) undid that pick
 * immediately, since it always forces the session back to the current
 * company. This gate makes reconciliation fire only for its real purpose (a
 * genuine company change, or an open chat that no longer exists), not for a
 * deliberate pick or an incidental re-render (e.g. a background sessions
 * refetch).
 *
 * A null session id with no company change is a new chat the person chose
 * to start ("New chat"), so it is left alone too. Treating it as "nothing
 * selected yet" put the latest chat straight back on screen.
 */
export function shouldReconcileClippyDrawerSession(params: {
  gate: ClippyDrawerReconcileGate;
  selectedCompanyId: string | null;
  activeSessionId: string | null;
  sessions: Array<{ id: string }>;
}): { run: boolean; nextGate: ClippyDrawerReconcileGate } {
  const { gate, selectedCompanyId, activeSessionId, sessions } = params;
  const nextGate: ClippyDrawerReconcileGate = { skip: false, reconciledForCompanyId: selectedCompanyId };

  if (gate.skip) {
    return { run: false, nextGate };
  }

  const companyChanged = gate.reconciledForCompanyId !== selectedCompanyId;
  if (!companyChanged) {
    if (activeSessionId === null) return { run: false, nextGate };
    const activeStillExists = sessions.some((s) => s.id === activeSessionId);
    if (activeStillExists) return { run: false, nextGate };
  }

  return { run: true, nextGate };
}

/** ClippyContext.tsx: what to do with the window's active session on open. */
export function reconcileClippyDrawerSession(params: {
  activeSessionId: string | null;
  sessions: Array<{ id: string; companyId: string | null }>;
  selectedCompanyId: string | null;
}): ClippyDrawerSessionReconciliation {
  const { activeSessionId, sessions, selectedCompanyId } = params;
  const current = activeSessionId ? sessions.find((s) => s.id === activeSessionId) : undefined;
  // A null-companyId session (not bound to any company) is fine to keep or
  // pick under any company.
  if (current && (current.companyId === null || current.companyId === selectedCompanyId)) {
    return { action: "keep" };
  }
  const replacement = sessions.find((s) => s.companyId === null || s.companyId === selectedCompanyId);
  if (replacement) return { action: "select", id: replacement.id };
  return { action: "draft" };
}
