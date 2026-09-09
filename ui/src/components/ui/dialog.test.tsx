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

  // NewGoalDialog/NewProjectDialog/NewIssueDialog open with `modal={false}`
  // so they can stay open while you switch company on the rail behind them
  // (see hooks/useDialogCompany.ts). Confirmed against Radix's own source
  // (@radix-ui/react-dialog): DialogOverlay renders `context.modal ? <.../> :
  // null`, so a non-modal dialog never puts the backdrop div in the DOM at
  // all — nothing is left to catch that click. No overlay-specific styling
  // needed on our side; `modal={false}` alone is the whole fix.
  it("renders no backdrop for a non-modal dialog, so the rail behind it stays clickable", async () => {
    await act(async () => {
      root.render(
        <Dialog open modal={false}>
          <DialogContent>
            <DialogTitle>Reminder</DialogTitle>
          </DialogContent>
        </Dialog>,
      );
    });

    expect(document.querySelector("[data-slot='dialog-overlay']")).toBeNull();
    // The panel itself is still there and still interactive.
    expect(document.querySelector("[data-slot='dialog-content']")).not.toBeNull();
  });

  it("keeps the blocking backdrop for an ordinary (modal) dialog", async () => {
    await act(async () => {
      root.render(
        <Dialog open>
          <DialogContent>
            <DialogTitle>Reminder</DialogTitle>
          </DialogContent>
        </Dialog>,
      );
    });

    expect(document.querySelector("[data-slot='dialog-overlay']")).not.toBeNull();
  });
});
