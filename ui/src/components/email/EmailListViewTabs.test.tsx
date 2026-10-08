// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailListViewTabs } from "./EmailListViewTabs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function tab(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (el) => el.textContent?.startsWith(label),
  );
  if (!found) throw new Error(`no tab ${label}`);
  return found;
}

describe("EmailListViewTabs", () => {
  it("does not change the view when a tab only receives focus", () => {
    const onChange = vi.fn();
    act(() => root.render(<EmailListViewTabs value="unread" onChange={onChange} agentHoldCount={0} />));

    act(() => tab("All mail").focus());

    expect(document.activeElement).toBe(tab("All mail"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("changes the view on a click", () => {
    const onChange = vi.fn();
    act(() => root.render(<EmailListViewTabs value="unread" onChange={onChange} agentHoldCount={0} />));

    act(() => {
      tab("All mail").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });

    expect(onChange).toHaveBeenCalledWith("all");
  });

  it("shows the count of messages with agents", () => {
    act(() => root.render(<EmailListViewTabs value="unread" onChange={vi.fn()} agentHoldCount={2} />));

    expect(tab("With agents").textContent).toBe("With agents2");
  });
});
