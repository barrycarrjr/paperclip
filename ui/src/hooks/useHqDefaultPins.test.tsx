// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHqDefaultPins } from "./useHqDefaultPins";
import {
  HQ_DEFAULT_PINNED_WORKSPACE_IDS,
  hasSeededHqDefaultPins,
  hqDefaultPinsSeededStorageKey,
  markHqDefaultPinsSeeded,
} from "../lib/hq-default-pins";

// The pin store, stubbed so a test can hold a write open and watch what the
// hook does while it is still travelling.
const pinState = vi.hoisted(() => ({
  pinned: [] as string[],
  canPin: true,
  pinsLoaded: true,
  ownerId: "user-1" as string | null,
  replaceAll: vi.fn(async (_ids: string[]) => {}),
}));

vi.mock("./usePinnedWorkspaces", () => ({
  usePinnedWorkspaces: () => ({
    pinned: pinState.pinned,
    isPinned: (id: string) => pinState.pinned.includes(id),
    toggle: () => {},
    replaceAll: pinState.replaceAll,
    canPin: pinState.canPin,
    ownerId: pinState.ownerId,
    isLoading: false,
    pinsLoaded: pinState.pinsLoaded,
    isSaving: false,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ isPortfolioRoot }: { isPortfolioRoot: boolean }) {
  useHqDefaultPins(isPortfolioRoot);
  return null;
}

describe("useHqDefaultPins", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    window.localStorage.clear();
    pinState.pinned = [];
    pinState.canPin = true;
    pinState.pinsLoaded = true;
    pinState.ownerId = "user-1";
    pinState.replaceAll = vi.fn(async () => {});
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render(isPortfolioRoot = true) {
    const root = createRoot(container);
    await act(async () => {
      root.render(<Probe isPortfolioRoot={isPortfolioRoot} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    return root;
  }

  it("pins the starting pages the first time someone opens HQ", async () => {
    const root = await render();

    expect(pinState.replaceAll).toHaveBeenCalledTimes(1);
    expect(pinState.replaceAll).toHaveBeenCalledWith([...HQ_DEFAULT_PINNED_WORKSPACE_IDS]);
    expect(hasSeededHqDefaultPins("user-1")).toBe(true);

    await act(async () => root.unmount());
  });

  it("does nothing on a second visit, so an unpinned page stays unpinned", async () => {
    const first = await render();
    await act(async () => first.unmount());

    // What the server would send back after the person unpinned one of them.
    pinState.pinned = HQ_DEFAULT_PINNED_WORKSPACE_IDS.filter((id) => id !== "portfolio-costs");
    pinState.replaceAll = vi.fn(async () => {});

    const second = await render();

    expect(pinState.replaceAll).not.toHaveBeenCalled();

    await act(async () => second.unmount());
  });

  it("writes once even while the first write is still travelling", async () => {
    let settle: (() => void) | undefined;
    pinState.replaceAll = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );

    const root = await render();
    expect(pinState.replaceAll).toHaveBeenCalledTimes(1);

    // The optimistic update lands: the pin list changes while the request is
    // still open, which re-runs the effect. It must not start a second write,
    // and nothing is marked until the server has taken it.
    await act(async () => {
      pinState.pinned = [...HQ_DEFAULT_PINNED_WORKSPACE_IDS];
      root.render(<Probe isPortfolioRoot />);
    });
    expect(pinState.replaceAll).toHaveBeenCalledTimes(1);
    expect(hasSeededHqDefaultPins("user-1")).toBe(false);

    await act(async () => {
      settle?.();
      await Promise.resolve();
    });
    expect(hasSeededHqDefaultPins("user-1")).toBe(true);

    await act(async () => root.unmount());
  });

  it("leaves it unmarked when the write fails, so the next visit can try again", async () => {
    pinState.replaceAll = vi.fn(async () => {
      throw new Error("network");
    });

    const root = await render();

    expect(pinState.replaceAll).toHaveBeenCalledTimes(1);
    expect(hasSeededHqDefaultPins("user-1")).toBe(false);

    await act(async () => root.unmount());
  });

  it("does nothing in an ordinary company", async () => {
    const root = await render(false);

    expect(pinState.replaceAll).not.toHaveBeenCalled();
    expect(hasSeededHqDefaultPins("user-1")).toBe(false);

    await act(async () => root.unmount());
  });

  it("does not write, and does not mark, for someone who cannot store pins", async () => {
    pinState.canPin = false;
    pinState.ownerId = null;
    const root = await render();

    expect(pinState.replaceAll).not.toHaveBeenCalled();
    // Nothing marked, so signing in later still gets them the defaults once.
    expect(hasSeededHqDefaultPins("user-1")).toBe(false);
    expect(window.localStorage.getItem(hqDefaultPinsSeededStorageKey("null"))).toBeNull();

    await act(async () => root.unmount());
  });

  it("waits for the saved pins to arrive", async () => {
    pinState.pinsLoaded = false;
    const root = await render();

    expect(pinState.replaceAll).not.toHaveBeenCalled();

    // They arrive, with something the person already pinned.
    await act(async () => {
      pinState.pinsLoaded = true;
      pinState.pinned = ["goals"];
      root.render(<Probe isPortfolioRoot />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(pinState.replaceAll).toHaveBeenCalledWith([
      "goals",
      ...HQ_DEFAULT_PINNED_WORKSPACE_IDS,
    ]);

    await act(async () => root.unmount());
  });

  it("marks without writing when the person already has all of them", async () => {
    pinState.pinned = [...HQ_DEFAULT_PINNED_WORKSPACE_IDS];
    const root = await render();

    expect(pinState.replaceAll).not.toHaveBeenCalled();
    expect(hasSeededHqDefaultPins("user-1")).toBe(true);

    await act(async () => root.unmount());
  });

  it("respects a mark left by an earlier session", async () => {
    markHqDefaultPinsSeeded("user-1");
    const root = await render();

    expect(pinState.replaceAll).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });
});
