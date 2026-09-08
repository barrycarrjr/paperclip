// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ToastProvider,
  useToastActions,
  useToastState,
  type ToastInput,
  type ToastItem,
} from "./ToastContext";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("ToastContext", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not rerender action-only consumers when toast state changes", () => {
    const root = createRoot(container);
    let actionOnlyRenderCount = 0;
    let pushToastRef: ((input: { title: string }) => string | null) | null = null;
    let clearToastsRef: (() => void) | null = null;

    function ActionOnlyConsumer() {
      actionOnlyRenderCount += 1;
      const { pushToast, clearToasts } = useToastActions();
      pushToastRef = pushToast;
      clearToastsRef = clearToasts;
      return null;
    }

    function ToastCount() {
      const toasts = useToastState();
      return <div data-testid="toast-count">{String(toasts.length)}</div>;
    }

    act(() => {
      root.render(
        <ToastProvider>
          <ActionOnlyConsumer />
          <ToastCount />
        </ToastProvider>,
      );
    });

    expect(actionOnlyRenderCount).toBe(1);
    expect(container.querySelector('[data-testid="toast-count"]')?.textContent).toBe("0");

    act(() => {
      pushToastRef?.({ title: "Saved" });
    });

    expect(actionOnlyRenderCount).toBe(1);
    expect(container.querySelector('[data-testid="toast-count"]')?.textContent).toBe("1");

    act(() => {
      clearToastsRef?.();
    });

    expect(actionOnlyRenderCount).toBe(1);
    expect(container.querySelector('[data-testid="toast-count"]')?.textContent).toBe("0");

    act(() => {
      root.unmount();
    });
  });
});

/**
 * How long a message lasts.
 *
 * A message saying something worked can be missed without cost, because the
 * thing it reports already happened and the screen shows it. A message saying
 * something failed cannot: nothing happened, there is still something for you
 * to do, and the reason the server gave is carried in that message and nowhere
 * else in the app.
 */
describe("ToastContext, how long a message lasts", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let push: ((input: ToastInput) => string | null) | null = null;
  let dismiss: ((id: string) => void) | null = null;
  let latest: ToastItem[] = [];

  function Harness() {
    const actions = useToastActions();
    push = actions.pushToast;
    dismiss = actions.dismissToast;
    latest = useToastState();
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <ToastProvider>
          <Harness />
        </ToastProvider>,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    push = null;
    dismiss = null;
    latest = [];
  });

  function titles() {
    return latest.map((toast) => toast.title);
  }

  it("keeps a failure on screen until the person closes it", () => {
    let id: string | null = null;
    act(() => {
      id = push?.({ title: "Save failed", body: "Company is read only", tone: "error" }) ?? null;
    });
    expect(titles()).toEqual(["Save failed"]);

    // Well past the longest time limit the old code allowed.
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(titles()).toEqual(["Save failed"]);

    act(() => {
      if (id) dismiss?.(id);
    });
    expect(titles()).toEqual([]);
  });

  it("still lets a report that something worked fade on its own", () => {
    act(() => {
      push?.({ title: "Invite revoked", tone: "success" });
    });
    expect(titles()).toEqual(["Invite revoked"]);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(titles()).toEqual([]);
  });

  it("lets the caller put a time limit on a failure after all", () => {
    // LiveUpdatesProvider does this for an agent run that failed on its own,
    // because that run and its error are kept on the run's own page.
    act(() => {
      push?.({ title: "Agent run failed", tone: "error", ttlMs: 7000 });
    });
    expect(titles()).toEqual(["Agent run failed"]);

    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(titles()).toEqual([]);
  });

  it("does not let later messages push a failure off the list", () => {
    act(() => {
      push?.({ title: "Delete failed", tone: "error" });
    });

    // Enough to overflow the five-message cap on its own.
    for (const title of ["Saved 1", "Saved 2", "Saved 3", "Saved 4", "Saved 5"]) {
      act(() => {
        push?.({ title, tone: "success" });
      });
    }

    expect(latest.length).toBe(5);
    expect(titles()).toContain("Delete failed");
    // The oldest one that was going to fade anyway is the one that went.
    expect(titles()).not.toContain("Saved 1");
  });

  it("drops the oldest failure when every message on screen is a failure", () => {
    for (const title of ["Fail 1", "Fail 2", "Fail 3", "Fail 4", "Fail 5", "Fail 6"]) {
      act(() => {
        push?.({ title, tone: "error" });
      });
    }

    expect(latest.length).toBe(5);
    expect(titles()).not.toContain("Fail 1");
    expect(titles()).toContain("Fail 6");
  });
});
