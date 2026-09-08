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
