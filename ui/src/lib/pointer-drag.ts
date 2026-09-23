/**
 * Follows one pointer from a press on `handle` until it is let go, reporting
 * how far it has moved sideways since the press.
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
  press: { pointerId: number; clientX: number },
  { onMove, onEnd }: { onMove: (deltaX: number) => void; onEnd: () => void },
): void {
  handle.setPointerCapture(press.pointerId);
  const startX = press.clientX;
  let ended = false;
  const move = (ev: PointerEvent) => {
    if (!ended) onMove(ev.clientX - startX);
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
