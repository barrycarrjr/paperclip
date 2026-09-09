// @vitest-environment jsdom

import { useState, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A tooltip opened by keyboard focus used to stay on screen when a dialog or a
 * drawer opened over the page, floating above the dimmed backdrop and still
 * labelling a control you could no longer use. It also held on to the first
 * Escape press, so the dialog under it needed a second one.
 *
 * The fix closes the tooltip rather than moving it down a layer, because a
 * dialog can hold tooltips of its own and those have to stay above it.
 *
 * These tests use a tooltip the app owns the open state of, which is how the
 * company rail's tooltips work, and they lean on Radix's own "a tooltip
 * opened, everyone else close" event. That event name is Radix's, not ours, so
 * if a future version of Radix renames it these tests are what says so.
 */

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function ControlledTooltip({ children }: { children: React.ReactNode }) {
  const [tooltipOpen, setTooltipOpen] = useState(true);
  return (
    <TooltipProvider>
      <Tooltip open={tooltipOpen} onOpenChange={setTooltipOpen}>
        <TooltipTrigger>Acme</TooltipTrigger>
        <TooltipContent>Acme Industries</TooltipContent>
      </Tooltip>
      {children}
    </TooltipProvider>
  );
}

function tooltipIsShowing(): boolean {
  return document.querySelector('[data-slot="tooltip-content"]') !== null;
}

describe("a tooltip left over from the page behind", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("goes when a dialog opens", async () => {
    function Harness({ dialogOpen }: { dialogOpen: boolean }) {
      return (
        <ControlledTooltip>
          <Dialog open={dialogOpen}>
            <DialogContent aria-describedby={undefined}>
              <DialogTitle>Search</DialogTitle>
            </DialogContent>
          </Dialog>
        </ControlledTooltip>
      );
    }

    await act(async () => {
      root.render(<Harness dialogOpen={false} />);
    });
    expect(tooltipIsShowing()).toBe(true);

    await act(async () => {
      root.render(<Harness dialogOpen />);
    });
    expect(tooltipIsShowing()).toBe(false);
  });

  it("goes when a drawer opens", async () => {
    function Harness({ sheetOpen }: { sheetOpen: boolean }) {
      return (
        <ControlledTooltip>
          <Sheet open={sheetOpen}>
            <SheetContent aria-describedby={undefined}>
              <SheetTitle>Clippy</SheetTitle>
            </SheetContent>
          </Sheet>
        </ControlledTooltip>
      );
    }

    await act(async () => {
      root.render(<Harness sheetOpen={false} />);
    });
    expect(tooltipIsShowing()).toBe(true);

    await act(async () => {
      root.render(<Harness sheetOpen />);
    });
    expect(tooltipIsShowing()).toBe(false);
  });

  it("leaves a tooltip that belongs to the dialog alone", async () => {
    // Only what was already on screen goes. A dialog is allowed to have
    // tooltips of its own, and a person hovering one inside an open dialog
    // must still see it.
    function Harness() {
      return (
        <TooltipProvider>
          <Dialog open>
            <DialogContent aria-describedby={undefined}>
              <DialogTitle>Search</DialogTitle>
              <Tooltip open>
                <TooltipTrigger>Filter</TooltipTrigger>
                <TooltipContent>Narrow the results</TooltipContent>
              </Tooltip>
            </DialogContent>
          </Dialog>
        </TooltipProvider>
      );
    }

    await act(async () => {
      root.render(<Harness />);
    });
    expect(document.body.textContent).toContain("Narrow the results");
  });
});
