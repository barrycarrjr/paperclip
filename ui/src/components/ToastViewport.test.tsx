// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToastActions, type ToastInput } from "../context/ToastContext";
import { ToastViewport } from "./ToastViewport";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A message that will not go away on its own has to look closeable, or the
 * person is left with something stuck on their screen and no obvious way to
 * clear it. The close button is already there for every message; on one that
 * stays it is shown at full strength instead of faded until you hover.
 */
describe("ToastViewport", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let push: ((input: ToastInput) => string | null) | null = null;

  function Harness() {
    push = useToastActions().pushToast;
    return null;
  }

  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <ToastProvider>
          <Harness />
          <ToastViewport />
        </ToastProvider>,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    push = null;
    vi.unstubAllGlobals();
  });

  function closeButton() {
    return container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss notification"]');
  }

  it("shows the reason a failure gives, not just that it failed", () => {
    act(() => {
      push?.({ title: "Save failed", body: "Company is read only", tone: "error" });
    });
    expect(container.textContent).toContain("Save failed");
    expect(container.textContent).toContain("Company is read only");
  });

  it("shows the close button at full strength on a message that stays", () => {
    act(() => {
      push?.({ title: "Delete failed", tone: "error" });
    });
    const button = closeButton();
    expect(button).not.toBeNull();
    expect(button?.dataset.stays).toBe("true");
    expect(button?.className).toContain("opacity-100");
  });

  it("leaves the close button faded on a message that fades on its own", () => {
    act(() => {
      push?.({ title: "Invite revoked", tone: "success" });
    });
    const button = closeButton();
    expect(button).not.toBeNull();
    expect(button?.dataset.stays).toBeUndefined();
    expect(button?.className).toContain("opacity-50");
  });

  it("keeps a pile of failures inside the window instead of letting it grow off the top", () => {
    // Failures stay until they are closed, and the app holds five at once. On
    // a short window five of them were taller than the screen, so the oldest
    // one, the only place the server's reason is written down, sat above the
    // top edge with its close button out of reach. The list now stops at the
    // height of the window and scrolls inside itself.
    act(() => {
      for (let i = 0; i < 5; i += 1) {
        push?.({ title: `Save failed ${i}`, body: "The server refused it", tone: "error" });
      }
    });
    const stack = container.querySelector<HTMLElement>('[data-testid="toast-stack"]');
    expect(stack).not.toBeNull();
    expect(stack?.className).toContain("max-h-[calc(100dvh-1.5rem)]");
    expect(stack?.className).toContain("overflow-y-auto");
    // Scrolling a list needs pointer events, and the list is the only part
    // that takes them: the box around it stays see-through to clicks.
    expect(stack?.className).toContain("pointer-events-auto");
    expect(stack?.parentElement?.className).toContain("pointer-events-none");
  });

  it("holds the messages in from both sides so a phone does not cut them off", () => {
    // It used to be `left-3 w-full`, and on a phone `w-full` is the width of
    // the whole page, so the right hand side of every message, close button
    // included, was off the screen.
    act(() => {
      push?.({ title: "Save failed", tone: "error" });
    });
    const box = container.querySelector<HTMLElement>('[data-testid="toast-stack"]')?.parentElement;
    expect(box?.className).toContain("inset-x-3");
    expect(box?.className).not.toContain("w-full");
    expect(box?.className).toContain("max-w-sm");
  });

  it("keeps an empty live region on the page before anything is said", () => {
    // A screen reader listens for changes to a region it already knows about,
    // so a region that appears together with its first message is often not
    // read out. Empty, the region takes no space and no clicks.
    const region = container.querySelector<HTMLElement>('[aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region?.textContent).toBe("");
    expect(region?.className).toContain("pointer-events-none");
    expect(container.querySelector('[data-testid="toast-stack"]')).toBeNull();

    act(() => {
      push?.({ title: "Profile saved", tone: "success" });
    });
    expect(container.querySelector('[aria-live="polite"]')).toBe(region);
    expect(region?.textContent).toContain("Profile saved");
  });

  it("shows a message pushed again with the same id as a new message", () => {
    // Left as the same item, a repeat changed nothing on screen and gave a
    // screen reader nothing to read: only its timer restarted.
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(1_000);
      act(() => {
        push?.({ id: "saved:Profile saved", title: "Profile saved", tone: "success" });
      });
      const first = container.querySelector('[data-testid="toast-stack"] > li');

      now.mockReturnValue(2_000);
      act(() => {
        push?.({ id: "saved:Profile saved", title: "Profile saved", tone: "success" });
      });

      const items = container.querySelectorAll('[data-testid="toast-stack"] > li');
      expect(items).toHaveLength(1);
      expect(items[0]).not.toBe(first);
    } finally {
      now.mockRestore();
    }
  });

  it("closes a failure when the close button is pressed", () => {
    act(() => {
      push?.({ title: "Delete failed", tone: "error" });
    });
    expect(container.textContent).toContain("Delete failed");

    act(() => {
      closeButton()?.click();
    });
    expect(container.textContent).not.toContain("Delete failed");
  });
});
