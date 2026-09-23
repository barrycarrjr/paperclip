// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { EmailStateIcons } from "./EmailStateIcons";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(node: React.ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

describe("EmailStateIcons", () => {
  it("draws nothing for a message nobody has replied to or forwarded", () => {
    const el = render(<EmailStateIcons answered={false} forwarded={false} />);
    expect(el.innerHTML).toBe("");
    // Older plugin builds send neither field; that must read as "neither".
    const older = render(<EmailStateIcons />);
    expect(older.innerHTML).toBe("");
  });

  it("names each mark for screen readers and on hover, even with no visible words", () => {
    const el = render(<EmailStateIcons answered forwarded />);
    const marks = [...el.querySelectorAll("[title]")].map((n) => n.getAttribute("title"));
    expect(marks).toEqual(["Replied", "Forwarded"]);
    const hidden = [...el.querySelectorAll(".sr-only")].map((n) => n.textContent);
    expect(hidden).toEqual(["Replied", "Forwarded"]);
  });

  it("shows only the mark that applies", () => {
    const el = render(<EmailStateIcons forwarded />);
    expect(el.textContent).toBe("Forwarded");
    expect(el.querySelector('[title="Replied"]')).toBeNull();
  });

  it("puts the words on screen for an open message", () => {
    const el = render(<EmailStateIcons answered showLabels />);
    const label = el.querySelector('[title="Replied"] span');
    expect(label?.textContent).toBe("Replied");
    expect(label?.className).not.toContain("sr-only");
  });
});
