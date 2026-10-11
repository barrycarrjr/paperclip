// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { $getRoot, SKIP_SCROLL_INTO_VIEW_TAG, type LexicalEditor } from "lexical";
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

  /** Clicks into the description, as a person does. Gives back the rich text. */
  async function clickIn() {
    const preview = container.querySelector<HTMLElement>('[role="textbox"]');
    await act(async () => {
      preview!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await wait(20);
    const editable = container.querySelector<HTMLElement & { __lexicalEditor?: LexicalEditor }>('[contenteditable="true"]');
    expect(editable, "the rich editor is on the page").not.toBeNull();
    // A browser focuses the editor on the click. jsdom only focuses elements
    // with a tabindex.
    await act(async () => {
      editable!.setAttribute("tabindex", "0");
      editable!.focus();
    });
    expect(editable!.contains(document.activeElement) || editable === document.activeElement).toBe(true);
    return editable!;
  }

  it.each([
    { name: "a description", value: "Steps:\n\n- Reproduce it.\n- Fix it." },
    // Saving trims the text, and text written outside the editor (by an agent,
    // say) often ends in a newline. Clicking into it saved it again, trimmed.
    { name: "a description that ends in a newline", value: "Steps:\n\n- Reproduce it.\n- Fix it.\n" },
  ])("does not save $name that was only clicked into", async ({ value }) => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      root.render(<InlineEditor value={value} multiline onSave={onSave} />);
    });
    await clickIn();

    // Past the autosave pause, then click away.
    await wait(1200);
    await act(async () => {
      outside.focus();
    });
    await wait(50);

    expect(onSave).not.toHaveBeenCalled();
  });

  it("saves an edit to a description that ends in a newline as the editor shows it", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      root.render(<InlineEditor value={"Steps:\n\n- Reproduce it.\n- Fix it.\n"} multiline onSave={onSave} />);
    });
    const editable = await clickIn();

    await act(async () => {
      // jsdom cannot measure where to scroll to.
      editable.__lexicalEditor!.update(
        () => {
          const text = $getRoot().getAllTextNodes()[0]!;
          text.setTextContent(`${text.getTextContent()} now`);
        },
        { tag: SKIP_SCROLL_INTO_VIEW_TAG },
      );
    });
    await wait(1200);

    // The newline at the end shows nowhere, and the editor does not write one.
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("Steps: now\n\n- Reproduce it.\n- Fix it.");
  });
});
