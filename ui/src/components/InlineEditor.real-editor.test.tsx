// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InlineEditor } from "./InlineEditor";

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div data-testid="multiline-md-preview">{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function wait(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/**
 * Issue, goal and project descriptions, with the real rich editor (the other
 * InlineEditor tests stand in for it). The editor rewrote a description as it
 * opened it, and this editor saves changes by itself, so clicking into a
 * description used to save it in the editor's style.
 */
describe("InlineEditor with the real rich editor", () => {
  let container: HTMLDivElement;
  let outside: HTMLButtonElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    outside = document.createElement("button");
    document.body.append(container, outside);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    outside.remove();
  });

  it("does not save a description that was only clicked into", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      root.render(<InlineEditor value={"Steps:\n\n- Reproduce it.\n- Fix it."} multiline onSave={onSave} />);
    });

    const preview = container.querySelector<HTMLElement>('[role="textbox"]');
    await act(async () => {
      preview!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await wait(20);
    const editable = container.querySelector<HTMLElement>('[contenteditable="true"]');
    expect(editable, "the rich editor is on the page").not.toBeNull();
    // A browser focuses the editor on the click. jsdom only focuses elements
    // with a tabindex.
    await act(async () => {
      editable!.setAttribute("tabindex", "0");
      editable!.focus();
    });
    expect(editable!.contains(document.activeElement) || editable === document.activeElement).toBe(true);

    // Past the autosave pause, then click away.
    await wait(1200);
    await act(async () => {
      outside.focus();
    });
    await wait(50);

    expect(onSave).not.toHaveBeenCalled();
  });
});
