// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { LIST_PANE_MAX_WIDTH, startListPaneResize } from "./email-pane-layout";

/**
 * A list on screen at `listWidth` in a page `pageWidth` wide, and the handle
 * that drags it. jsdom does no layout, so both widths are set by hand.
 */
function setUp(listWidth: number, pageWidth: number) {
  const page = document.createElement("div");
  Object.defineProperty(page, "clientWidth", { value: pageWidth });
  const list = document.createElement("div");
  list.getBoundingClientRect = () => ({ width: listWidth }) as DOMRect;
  page.appendChild(list);
  const handle = document.createElement("div");
  handle.setPointerCapture = vi.fn();
  page.appendChild(handle);
  const onResize = vi.fn();
  const onDone = vi.fn();
  return {
    press(mailboxColumnWidth: number) {
      startListPaneResize(list, handle, { pointerId: 1, clientX: 500 }, mailboxColumnWidth, {
        onResize,
        onDone,
      });
    },
    moveTo(clientX: number) {
      handle.dispatchEvent(new MouseEvent("pointermove", { clientX }));
    },
    release() {
      handle.dispatchEvent(new MouseEvent("pointerup"));
    },
    onResize,
    onDone,
  };
}

describe("dragging the list beside an open message", () => {
  it("starts from the width on screen", () => {
    // Stored 640 but shown at the cap, 462 = (1100 - 176) / 2. Ten pixels
    // left is 452; starting from the stored width left the edge still and
    // then trailing the pointer.
    const drag = setUp(462, 1100);
    drag.press(176);
    drag.moveTo(490);
    expect(drag.onResize).toHaveBeenLastCalledWith(452);
  });

  it("stops at half of what the mailbox column leaves", () => {
    const drag = setUp(300, 1100);
    drag.press(176);
    drag.moveTo(900);
    expect(drag.onResize).toHaveBeenLastCalledWith(462);
    // With the column collapsed to its 44 pixel rail there is more room.
    const collapsed = setUp(300, 1100);
    collapsed.press(44);
    collapsed.moveTo(900);
    expect(collapsed.onResize).toHaveBeenLastCalledWith(528);
  });

  it("stops at the largest width on a page with room to spare", () => {
    const drag = setUp(300, 3000);
    drag.press(176);
    drag.moveTo(2000);
    expect(drag.onResize).toHaveBeenLastCalledWith(LIST_PANE_MAX_WIDTH);
  });

  it("treats a click with a wobble as a click, and saves nothing", () => {
    // Shown at a cap of 462.5 on a page with an odd width to share; a
    // wobble used to save 462 over the width chosen on a wider screen.
    const drag = setUp(462.5, 1101);
    drag.press(176);
    drag.moveTo(501);
    drag.moveTo(498);
    drag.moveTo(500);
    drag.release();
    expect(drag.onResize).not.toHaveBeenCalled();
    expect(drag.onDone).not.toHaveBeenCalled();
  });

  it("saves the width it ended on after a real drag", () => {
    const drag = setUp(300, 1100);
    drag.press(176);
    drag.moveTo(540);
    drag.moveTo(520);
    drag.release();
    expect(drag.onDone).toHaveBeenCalledTimes(1);
    expect(drag.onDone).toHaveBeenCalledWith(320);
  });
});
