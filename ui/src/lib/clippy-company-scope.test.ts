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

  it("stays on a new chat the person started instead of opening the latest one", () => {
    // "New" on the full page no longer creates a chat; it shows an unsent
    // one. Picking the first chat in the list here would undo the click.
    const resolved = resolveActiveClippySessionId({
      companyScope: "current",
      activeId: null,
      sessionIds: ["session-1", "session-2"],
      drafting: true,
    });
    expect(resolved).toBeNull();
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
    });
    expect(result).toEqual({ action: "keep" });
  });

  it("keeps a null-companyId session under any company", () => {
    const result = reconcileClippyDrawerSession({
      activeSessionId: "session-global",
      sessions: [{ id: "session-global", companyId: null }],
      selectedCompanyId: "company-b",
    });
    expect(result).toEqual({ action: "keep" });
  });

  it("shows a new, unsent chat when no session matches the current company", () => {
    // It used to create a chat on the server right here, before anything was
    // typed. Most of those were never used, and each one stayed in the list
    // titled "New chat". Now the chat is created on its first send.
    const result = reconcileClippyDrawerSession({
      activeSessionId: "session-a",
      sessions: [{ id: "session-a", companyId: "company-a" }],
      selectedCompanyId: "company-b",
    });
    expect(result).toEqual({ action: "draft" });
  });

  it("shows a new chat for a company with no chats at all", () => {
    const result = reconcileClippyDrawerSession({
      activeSessionId: null,
      sessions: [],
      selectedCompanyId: "company-b",
    });
    expect(result).toEqual({ action: "draft" });
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

  it("leaves a new chat alone when the company has not changed", () => {
    // "New chat" sets no session id. Reading that as "nothing selected yet"
    // put the latest chat straight back on screen the moment it was pressed.
    const { run } = shouldReconcileClippyDrawerSession({
      gate: { skip: false, reconciledForCompanyId: "company-a" },
      selectedCompanyId: "company-a",
      activeSessionId: null,
      sessions: [{ id: "session-a" }],
    });
    expect(run).toBe(false);
  });

  it("still settles a new chat when the company changes", () => {
    const { run } = shouldReconcileClippyDrawerSession({
      gate: { skip: false, reconciledForCompanyId: "company-a" },
      selectedCompanyId: "company-b",
      activeSessionId: null,
      sessions: [{ id: "session-b" }],
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
