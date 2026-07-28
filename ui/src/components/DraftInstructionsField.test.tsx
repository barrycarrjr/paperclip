// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftInstructionsField } from "./DraftInstructionsField";

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

function render(props: Partial<Parameters<typeof DraftInstructionsField>[0]> = {}) {
  act(() => {
    root.render(
      <DraftInstructionsField
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        {...props}
      />,
    );
  });
  return container.querySelector("input")!;
}

function pressEnter(input: HTMLInputElement, shiftKey = false) {
  act(() => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey, bubbles: true }),
    );
  });
}

describe("DraftInstructionsField", () => {
  it("is discoverable — the field is visible and labelled without hovering anything", () => {
    const input = render();
    expect(input.getAttribute("aria-label")).toBe("Instructions for the AI draft");
    expect(input.placeholder).toContain("Tell the AI what to say");
  });

  it("switches to revise copy once there is a draft to change", () => {
    const input = render({ refining: true });
    expect(input.placeholder).toBe("Tell the AI what to change, then press Enter");
  });

  it("submits on Enter", () => {
    const onSubmit = vi.fn();
    pressEnter(render({ onSubmit, value: "keep it short" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does not submit on Shift+Enter", () => {
    const onSubmit = vi.fn();
    pressEnter(render({ onSubmit }), true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit while a draft is already running", () => {
    const onSubmit = vi.fn();
    const input = render({ onSubmit, disabled: true });
    pressEnter(input);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(input.disabled).toBe(true);
  });

  it("reports typed instructions to the parent", () => {
    const onChange = vi.fn();
    const input = render({ onChange });
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "mention Q3");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("mention Q3");
  });
});
