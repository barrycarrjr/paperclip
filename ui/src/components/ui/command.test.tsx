// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandDialog, CommandInput, CommandList } from "./command";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The search box has no Radix Trigger of its own: the Search button in the top
 * bar opens it by firing a Ctrl+K key event rather than owning the dialog. So
 * Radix has nothing to hand focus back to when it closes, and whoever opens it
 * has to say where focus should go. This checks the box actually passes that
 * instruction down to the dialog panel, which is where Radix reads it.
 */
describe("CommandDialog", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let opener: HTMLButtonElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    opener = document.createElement("button");
    opener.textContent = "Search";
    document.body.append(opener);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    opener.remove();
  });

  it("hands the caller's put-focus-back instruction to the dialog panel", async () => {
    function Harness({ open }: { open: boolean }) {
      return (
        <CommandDialog
          open={open}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            opener.focus();
          }}
        >
          <CommandInput placeholder="Search" />
          <CommandList />
        </CommandDialog>
      );
    }

    await act(async () => {
      root.render(<Harness open />);
    });
    expect(document.querySelector('[data-slot="dialog-content"]')).not.toBeNull();
    expect(document.activeElement).not.toBe(opener);

    await act(async () => {
      root.render(<Harness open={false} />);
    });
    // Radix hands focus back a beat after the box has gone, not in the same
    // turn, so give it that beat before looking. Without this wait the check
    // passes or fails depending on timing.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
