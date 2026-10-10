// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useDialogOpening, type DialogOpening } from "./useDialogOpening";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("useDialogOpening", () => {
  let container: HTMLDivElement;
  let root: Root;
  let opening: ReturnType<typeof useDialogOpening> | null = null;
  let setOpen: (open: boolean) => void = () => {};

  function Harness() {
    const [open, setOpenState] = useState(true);
    setOpen = setOpenState;
    opening = useDialogOpening(open);
    return null;
  }

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    opening = null;
  });

  it("knows a request's dialog is still showing until it closes, and a later opening is not it", async () => {
    const sentFrom: DialogOpening | null = opening!.current();
    expect(sentFrom).not.toBeNull();
    expect(opening!.isShowing(sentFrom)).toBe(true);

    await act(async () => {
      setOpen(false);
    });
    expect(opening!.current()).toBeNull();
    expect(opening!.isShowing(sentFrom)).toBe(false);

    await act(async () => {
      setOpen(true);
    });
    expect(opening!.current()).not.toBeNull();
    expect(opening!.isShowing(sentFrom)).toBe(false);
  });

  it("knows the dialog has gone once its component unmounts", async () => {
    const check = opening!;
    const sentFrom = check.current();

    await act(async () => {
      root.unmount();
    });

    expect(check.isShowing(sentFrom)).toBe(false);
    // Unmounted already, so afterEach has nothing left to unmount.
    root = createRoot(container);
  });

  it("knows nothing was sent from a closed dialog", () => {
    expect(opening!.isShowing(null)).toBe(false);
    expect(opening!.isShowing(undefined)).toBe(false);
  });
});
