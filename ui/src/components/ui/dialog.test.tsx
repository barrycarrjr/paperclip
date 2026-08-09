// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "./dialog";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

describe("DialogContent", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // DialogContent is a grid, and grid items default to `min-width:auto`. Without
  // this guard a single unbreakable string (a URL, a token, an id) grows the
  // column past the panel's max-width and the dialog's own rows and buttons get
  // painted outside its visible background.
  it("stops children from widening the panel past its max-width", async () => {
    await act(async () => {
      root.render(
        <Dialog open>
          <DialogContent>
            <DialogTitle>Reminder</DialogTitle>
          </DialogContent>
        </Dialog>,
      );
    });

    const content = document.querySelector("[data-slot='dialog-content']");
    expect(content?.className).toContain("[&>*]:min-w-0");
  });
});
