import { describe, expect, it } from "vitest";
import {
  reconcileClippyDrawerSession,
  resolveActiveClippySessionId,
  shouldReconcileClippyDrawerSession,
  INITIAL_CLIPPY_DRAWER_RECONCILE_GATE,
} from "./clippy-company-scope";

describe("resolveActiveClippySessionId", () => {
  it("clears a session that belongs to a company the operator switched away from", () => {
    // Regression: the Clippy page doesn't remount on a company switch, so
    // the previously-active session id (and its full transcript) otherwise
    // stayed selected under the newly-selected company.
    const resolved = resolveActiveClippySessionId({
      companyScope: "current",
      activeId: "session-under-company-a",
      sessionIds: ["session-under-company-b-1", "session-under-company-b-2"],
    });
    expect(resolved).toBe("session-under-company-b-1");
  });

  it("keeps the active session when it's still in the current company's list", () => {
    const resolved = resolveActiveClippySessionId({
      companyScope: "current",
      activeId: "session-1",
      sessionIds: ["session-1", "session-2"],
    });
    expect(resolved).toBe("session-1");
  });

  it("picks the first session when nothing is active yet", () => {
    const resolved = resolveActiveClippySessionId({
      companyScope: "current",
      activeId: null,
      sessionIds: ["session-1", "session-2"],
    });
    expect(resolved).toBe("session-1");
  });

  it("returns null when there is nothing to select", () => {
    const resolved = resolveActiveClippySessionId({
      companyScope: "current",
      activeId: null,
      sessionIds: [],
    });
    expect(resolved).toBeNull();
  });

  it("leaves a missing session id alone in 'all companies' scope (it's archived/deleted, not stale)", () => {
    const resolved = resolveActiveClippySessionId({
      companyScope: "all",
      activeId: "session-not-in-list",
      sessionIds: ["session-1", "session-2"],
    });
    expect(resolved).toBe("session-not-in-list");
  });
});

describe("reconcileClippyDrawerSession", () => {
  it("clears/replaces a session that belongs to a company the operator switched away from", () => {
    // Regression: the drawer is mounted once for the whole app and never
    // remounts on a company switch, so activeSessionId otherwise kept
    // pointing at Company A's chat (full transcript included) after
    // switching to Company B.
    const result = reconcileClippyDrawerSession({
      activeSessionId: "session-a",
      sessions: [
        { id: "session-a", companyId: "company-a" },
        { id: "session-b", companyId: "company-b" },
      ],
      selectedCompanyId: "company-b",
      isCreating: false,
    });
    expect(result).toEqual({ action: "select", id: "session-b" });
  });

  it("keeps the active session when it already belongs to the current company", () => {
    const result = reconcileClippyDrawerSession({
      activeSessionId: "session-b",
      sessions: [
        { id: "session-a", companyId: "company-a" },
        { id: "session-b", companyId: "company-b" },
      ],
      selectedCompanyId: "company-b",
      isCreating: false,
    });
    expect(result).toEqual({ action: "keep" });
  });

  it("keeps a null-companyId session under any company", () => {
    const result = reconcileClippyDrawerSession({
      activeSessionId: "session-global",
      sessions: [{ id: "session-global", companyId: null }],
      selectedCompanyId: "company-b",
      isCreating: false,
    });
    expect(result).toEqual({ action: "keep" });
  });

  it("requests creation when no session matches the current company and none is already being created", () => {
    const result = reconcileClippyDrawerSession({
      activeSessionId: "session-a",
      sessions: [{ id: "session-a", companyId: "company-a" }],
      selectedCompanyId: "company-b",
      isCreating: false,
    });
    expect(result).toEqual({ action: "create" });
  });

  it("clears rather than double-creating while a create is already in flight", () => {
    const result = reconcileClippyDrawerSession({
      activeSessionId: "session-a",
      sessions: [{ id: "session-a", companyId: "company-a" }],
      selectedCompanyId: "company-b",
      isCreating: true,
    });
    expect(result).toEqual({ action: "clear" });
  });
});

describe("shouldReconcileClippyDrawerSession", () => {
  it("runs on the very first evaluation, even if the company 'hasn't changed' yet", () => {
    // A session id restored from localStorage may belong to a different
    // company than a previous browser session left selected — the gate's
    // sentinel starting value must not read that as "no change needed".
    const { run, nextGate } = shouldReconcileClippyDrawerSession({
      gate: INITIAL_CLIPPY_DRAWER_RECONCILE_GATE,
      selectedCompanyId: "company-a",
      activeSessionId: "session-a",
      sessions: [{ id: "session-a" }],
    });
    expect(run).toBe(true);
    expect(nextGate).toEqual({ skip: false, reconciledForCompanyId: "company-a" });
  });

  it("does not run again on an incidental re-render once already reconciled for this company", () => {
    const { run } = shouldReconcileClippyDrawerSession({
      gate: { skip: false, reconciledForCompanyId: "company-a" },
      selectedCompanyId: "company-a",
      activeSessionId: "session-a",
      sessions: [{ id: "session-a" }],
    });
    expect(run).toBe(false);
  });

  it("runs again when the active session has disappeared, even with no company change", () => {
    const { run } = shouldReconcileClippyDrawerSession({
      gate: { skip: false, reconciledForCompanyId: "company-a" },
      selectedCompanyId: "company-a",
      activeSessionId: "session-deleted",
      sessions: [{ id: "session-a" }],
    });
    expect(run).toBe(true);
  });

  it("runs when the company actually changed", () => {
    const { run, nextGate } = shouldReconcileClippyDrawerSession({
      gate: { skip: false, reconciledForCompanyId: "company-a" },
      selectedCompanyId: "company-b",
      activeSessionId: "session-a",
      sessions: [{ id: "session-a" }],
    });
    expect(run).toBe(true);
    expect(nextGate.reconciledForCompanyId).toBe("company-b");
  });

  it("skips exactly once when a deliberate cross-company pick set the skip flag, then resumes normal gating", () => {
    // Regression: the "Recent chats" dropdown intentionally lists chats from
    // every company. Selecting one used to be immediately undone by this
    // same reconciliation effect forcing the session back to the current
    // company on the very next render.
    const picked = shouldReconcileClippyDrawerSession({
      gate: { skip: true, reconciledForCompanyId: "company-a" },
      selectedCompanyId: "company-a",
      activeSessionId: "session-under-company-b",
      sessions: [{ id: "session-under-company-b" }],
    });
    expect(picked.run).toBe(false);
    expect(picked.nextGate).toEqual({ skip: false, reconciledForCompanyId: "company-a" });

    // A later incidental re-render (no real company change) must not undo it.
    const later = shouldReconcileClippyDrawerSession({
      gate: picked.nextGate,
      selectedCompanyId: "company-a",
      activeSessionId: "session-under-company-b",
      sessions: [{ id: "session-under-company-b" }],
    });
    expect(later.run).toBe(false);
  });
});
