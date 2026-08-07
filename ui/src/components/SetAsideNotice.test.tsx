// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetAsideNotice } from "./SetAsideNotice";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("SetAsideNotice", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(node: ReactNode) {
    act(() => root.render(node));
  }

  it("says nothing when nothing is held back", () => {
    // The ordinary case. A queue with no sediment should not carry a line
    // explaining that it has none.
    render(<SetAsideNotice count={0} showing={false} onToggle={() => {}} />);
    expect(container.textContent).toBe("");
  });

  it("states the count rather than quietly showing fewer rows", () => {
    // The whole point: a list that holds rows back without saying so is the
    // same trap as a control that only appears on hover.
    render(<SetAsideNotice count={3} showing={false} onToggle={() => {}} />);
    expect(container.textContent).toContain("3 older failures have gone quiet");
  });

  it("reads correctly for a single row", () => {
    render(<SetAsideNotice count={1} showing={false} onToggle={() => {}} />);
    expect(container.textContent).toContain("1 older failure has gone quiet");
    expect(container.textContent).toContain("show it");
    expect(container.textContent).not.toContain("failures");
  });

  it("offers the way back once they are showing", () => {
    render(<SetAsideNotice count={3} showing onToggle={() => {}} />);
    expect(container.textContent).toContain("Hide the older ones");
  });

  it("hands the toggle back", () => {
    const onToggle = vi.fn();
    render(<SetAsideNotice count={2} showing={false} onToggle={onToggle} />);

    act(() => container.querySelector("button")!.click());

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("is a real control, not a decorative line", () => {
    // It has to be reachable by keyboard like anything else that changes what
    // the list shows.
    render(<SetAsideNotice count={2} showing={false} onToggle={() => {}} />);
    const button = container.querySelector("button");
    expect(button?.getAttribute("type")).toBe("button");
  });
});
