/**
 * Follows one pointer from a press on `handle` until it is let go, reporting
 * how far it has moved since the press: sideways by default, or up and down
 * with `axis: "y"` (the handle under a list that sits above the message).
 *
 * The pointer is captured, so the handle keeps receiving it wherever it goes.
 * Without that, a drag that crosses an iframe (the Email page draws the open
 * message in one) loses the pointer to the frame: the drag froze, and the
 * column went on following the pointer after the button was let go.
 *
 * Ends exactly once, on release, on cancel, or when the capture is lost some
 * other way, and stops listening when it does.
 */
export function followPointerDrag(
  handle: HTMLElement,
  press: { pointerId: number; clientX: number; clientY?: number },
  { onMove, onEnd }: { onMove: (delta: number) => void; onEnd: () => void },
  axis: "x" | "y" = "x",
): void {
  handle.setPointerCapture(press.pointerId);
  const start = axis === "x" ? press.clientX : (press.clientY ?? 0);
  let ended = false;
  const move = (ev: PointerEvent) => {
    if (!ended) onMove((axis === "x" ? ev.clientX : ev.clientY) - start);
  };
  const end = () => {
    if (ended) return;
    ended = true;
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", end);
    handle.removeEventListener("pointercancel", end);
    handle.removeEventListener("lostpointercapture", end);
    onEnd();
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  handle.addEventListener("lostpointercapture", end);
}
