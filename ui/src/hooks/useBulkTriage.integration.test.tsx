// @vitest-environment jsdom

import { useEffect, useMemo } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BulkTriageBar } from "../components/BulkTriageBar";
import {
  applyHelpScoutOverrides,
  helpScoutMailboxScope,
  helpScoutOverrideStore,
} from "../lib/mailboxTriageOverrides";
import { useHelpScoutTriageOverrides } from "./useTriageOverrides";
import { useBulkTriage } from "./useBulkTriage";

/**
 * The hook wired up the way the two triage views actually wire it: against the
 * real optimistic-override store, with the real list filtering and the real
 * bar.
 *
 * The unit tests alongside this file mock noteStatus, and that hid a real
 * defect. Each item is shown as moved the moment it starts, which takes its
 * row off the list; with the store mocked, the list never shrank, so the tests
 * never saw the selection empty itself mid-run and take the progress readout,
 * the Stop control and the result message down with it.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SCOPE = helpScoutMailboxScope("plugin-1", "company-1", "acct", "mailbox-1");

/**
 * Yield to a real task the way a network call does. Without this the fake
 * calls settle within a microtask, React never re-renders between items, and
 * the mid-run behaviour under test never happens.
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Conv {
  id: string;
  status: string;
}

function conv(id: string): Conv {
  return { id, status: "active" };
}

function setup(options: {
  all: Conv[];
  changeStatus: (accountKey: string, id: string, status: string) => Promise<unknown>;
}) {
  const invalidateLists = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const ref: { current: ReturnType<typeof useBulkTriage> | null } = { current: null };
  const visibleTrail: string[][] = [];

  function Panel() {
    const overrides = useHelpScoutTriageOverrides(SCOPE);
    // Exactly what both views do.
    const conversations = applyHelpScoutOverrides(options.all, overrides, { filter: "active" });

    const bulk = useBulkTriage({
      api: {
        addLabel: async () => ({}),
        changeStatus: options.changeStatus as never,
      },
      accountKey: "acct",
      noteStatus: (id, status) => helpScoutOverrideStore.set(SCOPE, id, status),
      clearStatus: (id) => helpScoutOverrideStore.clear(SCOPE, id),
      invalidateLists,
    });
    ref.current = bulk;

    const visibleIds = useMemo(() => conversations.map((c) => c.id), [conversations]);
    visibleTrail.push(visibleIds);
    const { syncVisible } = bulk;
    useEffect(() => {
      syncVisible(visibleIds);
    }, [syncVisible, visibleIds]);

    return (
      <BulkTriageBar
        count={bulk.selectedCount}
        progress={bulk.progress}
        outcome={bulk.outcome}
        onAction={(action) => {
          void bulk.runAction(action, visibleIds.filter((id) => bulk.isSelected(id)));
        }}
        onCancel={bulk.cancel}
        onClear={bulk.onClear}
      />
    );
  }

  act(() => root.render(<Panel />));

  return {
    hook: () => ref.current!,
    text: () => container.textContent ?? "",
    visibleTrail,
    invalidateLists,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("useBulkTriage against the real override store", () => {
  beforeEach(() => {
    for (const id of ["c1", "c2", "c3", "c4", "c5", "c6"]) helpScoutOverrideStore.clear(SCOPE, id);
  });
  afterEach(() => {
    for (const id of ["c1", "c2", "c3", "c4", "c5", "c6"]) helpScoutOverrideStore.clear(SCOPE, id);
  });

  it("still reports the result after every row has vanished from the list", async () => {
    // Closing them all empties the list, which used to empty the selection,
    // which unmounted the bar before it could say anything.
    const all = ["c1", "c2", "c3"].map(conv);
    const h = setup({ all, changeStatus: async () => { await tick(); return {}; } });

    act(() => h.hook().onSelectAll(["c1", "c2", "c3"]));
    await act(async () => {
      await h.hook().runAction("close", ["c1", "c2", "c3"]);
    });

    expect(h.hook().outcome?.message).toBe("Closed 3 conversations.");
    expect(h.text()).toContain("Closed 3 conversations.");
    h.cleanup();
  });

  it("keeps the failures selected so a retry is one click", async () => {
    const all = ["c1", "c2", "c3"].map(conv);
    const h = setup({
      all,
      changeStatus: async (_account, id) => {
        await tick();
        if (id === "c2") throw new Error("[EINVALID_INPUT] nope");
        return {};
      },
    });

    act(() => h.hook().onSelectAll(["c1", "c2", "c3"]));
    await act(async () => {
      await h.hook().runAction("close", ["c1", "c2", "c3"]);
    });

    expect(h.hook().selectedCount).toBe(1);
    expect(h.hook().isSelected("c2")).toBe(true);
    expect(h.text()).toContain("1 failed");
    h.cleanup();
  });

  it("does not let the disappearing rows shrink the run's own selection", async () => {
    // Hold the calls open so the assertions land while the run is genuinely
    // in flight. Every row is hidden by its own optimistic note at this
    // point, so a selection pruned to what is visible would be empty, and the
    // bar would unmount and take the progress, the Stop and the eventual
    // result with it.
    const gates: Array<() => void> = [];
    const all = ["c1", "c2", "c3"].map(conv);
    const h = setup({
      all,
      changeStatus: () => new Promise<unknown>((resolve) => gates.push(() => resolve({}))),
    });

    act(() => h.hook().onSelectAll(["c1", "c2", "c3"]));
    let run!: Promise<void>;
    act(() => {
      run = h.hook().runAction("close", ["c1", "c2", "c3"]);
    });
    await act(async () => {
      await tick();
    });

    // Precondition: every row really is off the list while the calls are open.
    expect(h.visibleTrail[h.visibleTrail.length - 1]).toEqual([]);
    expect(h.hook().running).toBe(true);
    expect(h.hook().selectedCount).toBe(3);
    const midRunText = h.text();
    expect(midRunText).toContain("3 selected");
    expect(midRunText).toContain("done");
    expect(midRunText).toContain("Stop");

    await act(async () => {
      for (const open of gates) open();
      await run;
    });
    expect(h.text()).toContain("Closed 3 conversations.");
    h.cleanup();
  });

  it("puts a failed row back on the list", async () => {
    const all = ["c1"].map(conv);
    const h = setup({
      all,
      changeStatus: async () => {
        await tick();
        throw new Error("[EINVALID_INPUT] nope");
      },
    });

    act(() => h.hook().onSelectAll(["c1"]));
    await act(async () => {
      await h.hook().runAction("close", ["c1"]);
    });

    // The optimistic note is undone, so the row is visible again and still
    // ticked.
    expect(h.visibleTrail[h.visibleTrail.length - 1]).toEqual(["c1"]);
    expect(h.hook().isSelected("c1")).toBe(true);
    h.cleanup();
  });

  it("refreshes the lists exactly once for the whole run", async () => {
    const all = ["c1", "c2", "c3"].map(conv);
    const h = setup({ all, changeStatus: async () => { await tick(); return {}; } });

    act(() => h.hook().onSelectAll(["c1", "c2", "c3"]));
    await act(async () => {
      await h.hook().runAction("close", ["c1", "c2", "c3"]);
    });

    expect(h.invalidateLists).toHaveBeenCalledTimes(1);
    h.cleanup();
  });

  it("goes back to pruning stale rows once the run is over", async () => {
    // The guard is only for the duration of a run; a row that genuinely leaves
    // afterwards must still drop out of the selection.
    const all = ["c1", "c2"].map(conv);
    const h = setup({ all, changeStatus: async () => { await tick(); return {}; } });

    act(() => h.hook().onToggle("c1", ["c1", "c2"], false));
    act(() => h.hook().syncVisible(["c2"]));
    expect(h.hook().selectedCount).toBe(0);
    h.cleanup();
  });
});
