// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BULK_CONCURRENCY } from "../lib/bulk-run";
import { AUTO_NOISE_LABEL, KEEP_ALWAYS_LABEL, useBulkTriage } from "./useBulkTriage";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Hook = ReturnType<typeof useBulkTriage>;

function setup(overrides: Partial<Parameters<typeof useBulkTriage>[0]> = {}) {
  const addLabel = vi.fn(async () => ({}));
  const changeStatus = vi.fn(async () => ({}));
  const noteStatus = vi.fn();
  const clearStatus = vi.fn();
  const invalidateLists = vi.fn();

  const options = {
    api: { addLabel, changeStatus },
    accountKey: "acct",
    noteStatus,
    clearStatus,
    invalidateLists,
    ...overrides,
  };

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const ref: { current: Hook | null } = { current: null };

  function Probe() {
    ref.current = useBulkTriage(options as Parameters<typeof useBulkTriage>[0]);
    return null;
  }

  act(() => root.render(<Probe />));

  return {
    hook: () => ref.current!,
    addLabel: options.api.addLabel as typeof addLabel,
    changeStatus: options.api.changeStatus as typeof changeStatus,
    noteStatus,
    clearStatus,
    invalidateLists,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("useBulkTriage selection", () => {
  let harness: ReturnType<typeof setup>;
  beforeEach(() => {
    harness = setup();
  });
  afterEach(() => harness.cleanup());

  it("starts with nothing selected", () => {
    expect(harness.hook().selectedCount).toBe(0);
  });

  it("picks and unpicks a row", () => {
    act(() => harness.hook().onToggle("a", ["a", "b"], false));
    expect(harness.hook().isSelected("a")).toBe(true);
    act(() => harness.hook().onToggle("a", ["a", "b"], false));
    expect(harness.hook().selectedCount).toBe(0);
  });

  it("takes a range on shift-click", () => {
    const rows = ["a", "b", "c", "d"];
    act(() => harness.hook().onToggle("a", rows, false));
    act(() => harness.hook().onToggle("c", rows, true));
    expect(harness.hook().selectedCount).toBe(3);
    expect(harness.hook().isSelected("b")).toBe(true);
  });

  it("select-all toggles between all and none", () => {
    const rows = ["a", "b", "c"];
    act(() => harness.hook().onSelectAll(rows));
    expect(harness.hook().selectAllState(rows)).toBe("all");
    act(() => harness.hook().onSelectAll(rows));
    expect(harness.hook().selectedCount).toBe(0);
  });

  it("forgets rows that have left the list", () => {
    // The list refetches every 30 seconds and other people close things.
    act(() => harness.hook().onToggle("a", ["a", "b"], false));
    act(() => harness.hook().syncVisible(["b"]));
    expect(harness.hook().selectedCount).toBe(0);
  });
});

describe("useBulkTriage actions", () => {
  let harness: ReturnType<typeof setup>;
  beforeEach(() => {
    harness = setup();
  });
  afterEach(() => harness.cleanup());

  it("closes every selected conversation and refreshes once", async () => {
    await act(async () => {
      await harness.hook().runAction("close", ["c1", "c2", "c3"]);
    });

    expect(harness.changeStatus).toHaveBeenCalledTimes(3);
    expect(harness.changeStatus).toHaveBeenCalledWith("acct", "c1", "closed");
    // Once for the whole run, not once per conversation.
    expect(harness.invalidateLists).toHaveBeenCalledTimes(1);
  });

  it("marks pending with the status Help Scout expects", async () => {
    await act(async () => {
      await harness.hook().runAction("pending", ["c1"]);
    });
    expect(harness.changeStatus).toHaveBeenCalledWith("acct", "c1", "pending");
  });

  it("marks spam", async () => {
    await act(async () => {
      await harness.hook().runAction("spam", ["c1"]);
    });
    expect(harness.changeStatus).toHaveBeenCalledWith("acct", "c1", "spam");
  });

  it("tags keep-always without moving the conversation", async () => {
    await act(async () => {
      await harness.hook().runAction("keep-always", ["c1", "c2"]);
    });
    expect(harness.addLabel).toHaveBeenCalledWith("acct", "c1", [KEEP_ALWAYS_LABEL]);
    expect(harness.changeStatus).not.toHaveBeenCalled();
    // Nothing moved, so nothing should be shown as moved.
    expect(harness.noteStatus).not.toHaveBeenCalled();
  });

  it("tags auto-noise before closing, so nothing is closed unexplained", async () => {
    const order: string[] = [];
    const h = setup({
      api: {
        addLabel: vi.fn(async () => {
          order.push("tag");
          return {};
        }),
        changeStatus: vi.fn(async () => {
          order.push("close");
          return {};
        }),
      },
    });
    await act(async () => {
      await h.hook().runAction("auto-noise", ["c1"]);
    });
    expect(order).toEqual(["tag", "close"]);
    h.cleanup();
  });

  it("shows the row as moved straight away, and puts it back if the call fails", async () => {
    const h = setup({
      api: {
        addLabel: vi.fn(async () => ({})),
        changeStatus: vi.fn(async () => {
          throw new Error("[EINVALID_INPUT] nope");
        }),
      },
    });
    await act(async () => {
      await h.hook().runAction("close", ["c1"]);
    });
    expect(h.noteStatus).toHaveBeenCalledWith("c1", "closed");
    expect(h.clearStatus).toHaveBeenCalledWith("c1");
    h.cleanup();
  });

  it("keeps going past one failure and reports a partial result", async () => {
    let call = 0;
    const h = setup({
      api: {
        addLabel: vi.fn(async () => ({})),
        changeStatus: vi.fn(async () => {
          call += 1;
          if (call === 2) throw new Error("[EINVALID_INPUT] nope");
          return {};
        }),
      },
    });
    await act(async () => {
      await h.hook().runAction("close", ["c1", "c2", "c3"]);
    });
    expect(h.hook().outcome?.tone).toBe("warning");
    expect(h.hook().outcome?.message).toContain("1 failed");
    h.cleanup();
  });

  it("leaves only the unfinished ones selected, so a retry is one click", async () => {
    let call = 0;
    const h = setup({
      api: {
        addLabel: vi.fn(async () => ({})),
        changeStatus: vi.fn(async () => {
          call += 1;
          if (call === 2) throw new Error("[EINVALID_INPUT] nope");
          return {};
        }),
      },
    });
    act(() => h.hook().onSelectAll(["c1", "c2", "c3"]));
    await act(async () => {
      await h.hook().runAction("close", ["c1", "c2", "c3"]);
    });
    expect(h.hook().selectedCount).toBe(1);
    expect(h.hook().isSelected("c2")).toBe(true);
    h.cleanup();
  });

  it("clears the selection entirely when everything worked", async () => {
    act(() => harness.hook().onSelectAll(["c1", "c2"]));
    await act(async () => {
      await harness.hook().runAction("close", ["c1", "c2"]);
    });
    expect(harness.hook().selectedCount).toBe(0);
    expect(harness.hook().outcome?.tone).toBe("success");
  });

  it("stops after a rate limit instead of failing every remaining one", async () => {
    const h = setup({
      api: {
        addLabel: vi.fn(async () => ({})),
        changeStatus: vi.fn(async () => {
          throw new Error("[EHELP_SCOUT_RATE_LIMIT] retry after 12s");
        }),
      },
    });
    await act(async () => {
      await h.hook().runAction("close", ["c1", "c2", "c3", "c4", "c5"]);
    });
    // Whatever was already in flight finishes, but nothing new starts, so the
    // count is bounded by the concurrency cap rather than the selection size.
    expect(h.changeStatus.mock.calls.length).toBeLessThanOrEqual(DEFAULT_BULK_CONCURRENCY);
    expect(h.changeStatus.mock.calls.length).toBeLessThan(5);
    expect(h.hook().outcome?.message).toContain("slow down");
    h.cleanup();
  });

  it("does nothing on an empty selection", async () => {
    await act(async () => {
      await harness.hook().runAction("close", []);
    });
    expect(harness.changeStatus).not.toHaveBeenCalled();
    expect(harness.invalidateLists).not.toHaveBeenCalled();
  });

  it("refreshes the lists even when the run fails outright", async () => {
    const h = setup({
      api: {
        addLabel: vi.fn(async () => ({})),
        changeStatus: vi.fn(async () => {
          throw new Error("[EINVALID_INPUT] nope");
        }),
      },
    });
    await act(async () => {
      await h.hook().runAction("close", ["c1"]);
    });
    expect(h.invalidateLists).toHaveBeenCalledTimes(1);
    h.cleanup();
  });
});
