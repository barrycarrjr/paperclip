// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailHeader } from "../../api/emailTools";
import { useEmailBulkSelection } from "./useEmailBulkSelection";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Nothing in this file talks to a mailbox.
 *
 * The hook is handed the two "do this to one message" functions by the page,
 * and every test here hands it fakes, so no real message is ever marked,
 * moved or touched by running these. The one test named for it checks that
 * on purpose: with nothing ticked, the fakes are never called at all.
 */

function msg(uid: number, from = "someone@example.com"): MailHeader {
  return {
    uid,
    from,
    subject: `Message ${uid}`,
    date: `2026-09-0${uid}T09:00:00.000Z`,
    unseen: true,
    messageId: `<${uid}@example.com>`,
  } as MailHeader;
}

const ids = (...uids: number[]) => uids.map(String);

type Hook = ReturnType<typeof useEmailBulkSelection>;

function setup(overrides: Partial<Parameters<typeof useEmailBulkSelection>[0]> = {}) {
  const markRead = vi.fn(async (_msg: MailHeader) => {});
  const moveToFolder = vi.fn(async (_msg: MailHeader, _targetFolder: string) => {});
  const invalidateLists = vi.fn();
  const options = { markRead, moveToFolder, invalidateLists, ...overrides };

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const ref: { current: Hook | null } = { current: null };

  function Probe() {
    ref.current = useEmailBulkSelection(options as Parameters<typeof useEmailBulkSelection>[0]);
    return null;
  }

  act(() => root.render(<Probe />));

  return {
    hook: () => ref.current!,
    markRead: options.markRead as typeof markRead,
    moveToFolder: options.moveToFolder as typeof moveToFolder,
    invalidateLists: options.invalidateLists as typeof invalidateLists,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("ticking messages", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });
  afterEach(() => h.cleanup());

  it("starts with the checkboxes off and nothing ticked", () => {
    expect(h.hook().selectMode).toBe(false);
    expect(h.hook().selectedCount).toBe(0);
  });

  it("ticks and unticks one message at a time", () => {
    act(() => h.hook().startSelecting());
    expect(h.hook().selectMode).toBe(true);
    act(() => h.hook().toggle(2, ids(1, 2, 3), false));
    expect(h.hook().isSelected(2)).toBe(true);
    act(() => h.hook().toggle(2, ids(1, 2, 3), false));
    expect(h.hook().isSelected(2)).toBe(false);
  });

  it("ticks four unrelated messages, which is the whole point", () => {
    act(() => h.hook().startSelecting());
    for (const uid of [1, 4, 7, 9]) act(() => h.hook().toggle(uid, ids(1, 4, 7, 9, 11), false));
    expect(h.hook().selectedCount).toBe(4);
    expect(h.hook().isSelected(11)).toBe(false);
  });

  it("shift-click takes everything between", () => {
    act(() => h.hook().toggle(1, ids(1, 2, 3, 4), false));
    act(() => h.hook().toggle(3, ids(1, 2, 3, 4), true));
    expect(h.hook().selectedCount).toBe(3);
    expect(h.hook().isSelected(4)).toBe(false);
  });

  it("select visible takes the rows on screen, and a second press clears them", () => {
    act(() => h.hook().selectVisible(ids(1, 2, 3)));
    expect(h.hook().selectedCount).toBe(3);
    expect(h.hook().selectAllState(ids(1, 2, 3))).toBe("all");
    act(() => h.hook().selectVisible(ids(1, 2, 3)));
    expect(h.hook().selectedCount).toBe(0);
  });

  it("drops ticks for rows that have left the list", () => {
    act(() => h.hook().selectVisible(ids(1, 2, 3)));
    act(() => h.hook().syncVisible(ids(1, 3)));
    expect(h.hook().selectedCount).toBe(2);
    expect(h.hook().isSelected(2)).toBe(false);
  });

  it("forgets everything when the checkboxes are put away", () => {
    act(() => h.hook().startSelecting());
    act(() => h.hook().selectVisible(ids(1, 2)));
    act(() => h.hook().stopSelecting());
    expect(h.hook().selectMode).toBe(false);
    expect(h.hook().selectedCount).toBe(0);
  });
});

describe("what a change underneath does to the ticks", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
    act(() => h.hook().startSelecting());
    act(() => h.hook().selectVisible(ids(1, 2, 3)));
  });
  afterEach(() => h.cleanup());

  it("clears the ticks when the tab changes, and keeps the checkboxes on", () => {
    act(() => h.hook().resetFor("tab", "all"));
    expect(h.hook().selectedCount).toBe(0);
    expect(h.hook().selectMode).toBe(true);
  });

  it("puts the checkboxes away when the tab becomes the handover list", () => {
    act(() => h.hook().resetFor("tab", "agents"));
    expect(h.hook().selectedCount).toBe(0);
    expect(h.hook().selectMode).toBe(false);
  });

  it("clears the ticks on a folder or mailbox change, because a uid means nothing outside its folder", () => {
    act(() => h.hook().resetFor("folder"));
    expect(h.hook().selectedCount).toBe(0);
    act(() => h.hook().selectVisible(ids(4, 5)));
    act(() => h.hook().resetFor("mailbox"));
    expect(h.hook().selectedCount).toBe(0);
  });

  it("leaves nothing behind when the company changes", () => {
    act(() => h.hook().resetFor("company"));
    expect(h.hook().selectedCount).toBe(0);
    expect(h.hook().selectMode).toBe(false);
    expect(h.hook().outcome).toBeNull();
  });
});

describe("acting on the ticked messages", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });
  afterEach(() => h.cleanup());

  it("touches nothing when nothing is ticked", async () => {
    await act(async () => {
      await h.hook().run("read", []);
      await h.hook().run("move", [], "Archive");
    });
    expect(h.markRead).not.toHaveBeenCalled();
    expect(h.moveToFolder).not.toHaveBeenCalled();
  });

  it("will not move without somewhere to move to", async () => {
    await act(async () => {
      await h.hook().run("move", [msg(1)]);
    });
    expect(h.moveToFolder).not.toHaveBeenCalled();
  });

  it("marks every ticked message read, one call each, then refreshes once", async () => {
    await act(async () => {
      await h.hook().run("read", [msg(1), msg(2), msg(3)]);
    });
    expect(h.markRead).toHaveBeenCalledTimes(3);
    expect(h.moveToFolder).not.toHaveBeenCalled();
    expect(h.invalidateLists).toHaveBeenCalledTimes(1);
    expect(h.hook().outcome).toEqual({ tone: "success", message: "Marked read 3 messages." });
    expect(h.hook().selectedCount).toBe(0);
  });

  it("moves every ticked message to the folder that was picked", async () => {
    await act(async () => {
      await h.hook().run("move", [msg(1), msg(2)], "Archive");
    });
    expect(h.moveToFolder.mock.calls.map((c) => c[1])).toEqual(["Archive", "Archive"]);
    expect(h.hook().outcome?.message).toBe("Moved 2 messages.");
  });

  it("reports a part-finished run as a part-finished run, and keeps the failures ticked", async () => {
    const failing = setup({
      moveToFolder: vi.fn(async (m: MailHeader) => {
        if (m.uid === 2) throw new Error("Mailbox is read only");
      }),
    });
    await act(async () => {
      await failing.hook().run("move", [msg(1), msg(2), msg(3)], "Archive");
    });
    const outcome = failing.hook().outcome!;
    expect(outcome.tone).toBe("warning");
    expect(outcome.message).toBe("Moved 2. 1 failed.");
    // The one that failed stays ticked so trying again cannot touch the two
    // that already moved.
    expect(failing.hook().selectedCount).toBe(1);
    expect(failing.hook().isSelected(2)).toBe(true);
    failing.cleanup();
  });

  it("says outright when none of them worked", async () => {
    const failing = setup({
      markRead: vi.fn(async () => {
        throw new Error("Connection lost");
      }),
    });
    await act(async () => {
      await failing.hook().run("read", [msg(1), msg(2)]);
    });
    expect(failing.hook().outcome).toEqual({
      tone: "error",
      message: "None of the 2 selected could be marked read.",
    });
    failing.cleanup();
  });

  it("refreshes the lists even when every message failed", async () => {
    const failing = setup({
      markRead: vi.fn(async () => {
        throw new Error("nope");
      }),
    });
    await act(async () => {
      await failing.hook().run("read", [msg(1)]);
    });
    expect(failing.invalidateLists).toHaveBeenCalledTimes(1);
    failing.cleanup();
  });

  it("will not start a second run on top of one already going", async () => {
    let release: (() => void) | null = null;
    const slow = setup({
      markRead: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      ),
    });
    let first: Promise<void> | null = null;
    act(() => {
      first = slow.hook().run("read", [msg(1)]);
    });
    expect(slow.hook().running).toBe(true);
    expect(slow.hook().progress).toEqual({ action: "read", done: 0, total: 1 });
    await act(async () => {
      await slow.hook().run("read", [msg(2)]);
    });
    expect(slow.markRead).toHaveBeenCalledTimes(1);
    await act(async () => {
      release?.();
      await first;
    });
    expect(slow.hook().running).toBe(false);
    slow.cleanup();
  });
});
