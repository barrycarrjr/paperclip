// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { followPointerDrag } from "./pointer-drag";

function makeHandle() {
  const handle = document.createElement("div");
  // jsdom has no pointer capture of its own.
  const setPointerCapture = vi.fn();
  handle.setPointerCapture = setPointerCapture;
  return { handle, setPointerCapture };
}

function fire(handle: HTMLElement, type: string, clientX = 0) {
  handle.dispatchEvent(new MouseEvent(type, { clientX }));
}

describe("followPointerDrag", () => {
  it("captures the pointer, so a drag over the message frame keeps going", () => {
    const { handle, setPointerCapture } = makeHandle();
    followPointerDrag(handle, { pointerId: 7, clientX: 100 }, { onMove: vi.fn(), onEnd: vi.fn() });
    expect(setPointerCapture).toHaveBeenCalledWith(7);
  });

  it("reports how far the pointer has moved since the press", () => {
    const { handle } = makeHandle();
    const onMove = vi.fn();
    followPointerDrag(handle, { pointerId: 1, clientX: 100 }, { onMove, onEnd: vi.fn() });
    fire(handle, "pointermove", 130);
    fire(handle, "pointermove", 60);
    expect(onMove.mock.calls).toEqual([[30], [-40]]);
  });

  it.each(["pointerup", "pointercancel", "lostpointercapture"])(
    "ends once on %s and stops following the pointer",
    (endEvent) => {
      const { handle } = makeHandle();
      const onMove = vi.fn();
      const onEnd = vi.fn();
      followPointerDrag(handle, { pointerId: 1, clientX: 0 }, { onMove, onEnd });
      fire(handle, endEvent);
      // A release is followed by a lost capture; that must not end it twice.
      fire(handle, "lostpointercapture");
      fire(handle, "pointerup");
      fire(handle, "pointermove", 50);
      expect(onEnd).toHaveBeenCalledTimes(1);
      expect(onMove).not.toHaveBeenCalled();
    },
  );
});
