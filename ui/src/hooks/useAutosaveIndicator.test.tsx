// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutosaveIndicator, type AutosaveState } from "./useAutosaveIndicator";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Indicator = ReturnType<typeof useAutosaveIndicator>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("useAutosaveIndicator", () => {
  let container: HTMLDivElement;
  let root: Root;
  let indicator: Indicator;
  let shown: AutosaveState;

  function Probe() {
    indicator = useAutosaveIndicator();
    shown = indicator.state;
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Probe />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("says Saving while a save is on its way, then Saved", async () => {
    const save = deferred();
    let done!: Promise<void>;
    act(() => {
      done = indicator.runSave(() => save.promise);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(shown).toBe("saving");

    await act(async () => {
      save.resolve();
      await done;
    });
    expect(shown).toBe("saved");
  });

  it("does not say Saved for a save answered after newer typing", async () => {
    const save = deferred();
    let done!: Promise<void>;
    act(() => {
      done = indicator.runSave(() => save.promise);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    // More typing while the first save is on its way.
    act(() => indicator.markDirty());

    await act(async () => {
      save.resolve();
      await done;
    });
    expect(shown).toBe("idle");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(shown).toBe("idle");
  });
});
