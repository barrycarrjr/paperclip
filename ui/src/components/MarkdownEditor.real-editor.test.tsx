// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { $getRoot, $isTextNode, type LexicalEditor } from "lexical";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditor } from "./MarkdownEditor";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function settle() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/**
 * These use the real rich editor (the other MarkdownEditor tests stand in for
 * it), because what matters here is how it writes markdown back out.
 */
describe("MarkdownEditor with the real rich editor", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalRangeRects: typeof Range.prototype.getClientRects;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // Code blocks measure text, which jsdom cannot do.
    originalRangeRects = Range.prototype.getClientRects;
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    Range.prototype.getClientRects = originalRangeRects;
  });

  /** Opens the markdown in a new editor, as opening a file does. */
  async function open(markdown: string) {
    const onChange = vi.fn();
    await act(async () => {
      root.render(<MarkdownEditor key={markdown} value={markdown} onChange={onChange} />);
    });
    await settle();
    expect(container.querySelector("textarea"), "the rich editor loaded").toBeNull();
    return onChange;
  }

  /** Adds a word to the end of the first text in the editor, as typing it there would. */
  async function typeIntoFirstText(word: string) {
    const editable = container.querySelector('[contenteditable="true"]') as
      | (HTMLElement & { __lexicalEditor?: LexicalEditor })
      | null;
    const editor = editable?.__lexicalEditor;
    expect(editor, "the rich editor is on the page").toBeDefined();
    await act(async () => {
      editor!.update(() => {
        const text = $getRoot().getAllTextNodes()[0];
        if (!$isTextNode(text)) throw new Error("no text to type into");
        const content = text.getTextContent();
        const trailingSpace = content.slice(content.trimEnd().length);
        text.setTextContent(`${content.trimEnd()} ${word}${trailingSpace}`);
      });
    });
    await settle();
  }

  it.each([
    {
      name: '"-" lists',
      markdown: "# Rules\n\n- Run the tests.\n- Ask first.\n  - Even for small changes.",
      edited: "# Rules now\n\n- Run the tests.\n- Ask first.\n  - Even for small changes.",
    },
    {
      name: '"+" lists',
      markdown: "# Rules\n\n+ Run the tests.\n+ Ask first.",
      edited: "# Rules now\n\n+ Run the tests.\n+ Ask first.",
    },
    {
      name: 'numbered lists with ")"',
      markdown: "# Steps\n\n1) Read the issue.\n2) Fix it.",
      edited: "# Steps now\n\n1) Read the issue.\n2) Fix it.",
    },
    {
      name: "numbered lists that repeat their number",
      markdown: "# Steps\n\n1. Read the issue.\n1. Fix it.\n1. Test it.",
      edited: "# Steps now\n\n1. Read the issue.\n1. Fix it.\n1. Test it.",
    },
    {
      name: 'emphasis with "_"',
      markdown: "Be _careful_ and __thorough__.",
      edited: "Be now _careful_ and __thorough__.",
    },
    {
      name: 'headings closed with "#"',
      markdown: "# Rules #\n\n## Tests ##\n\nRun them.",
      edited: "# Rules now #\n\n## Tests ##\n\nRun them.",
    },
    {
      name: "underlined headings",
      markdown: "Rules\n=====\n\nRun the tests.",
      edited: "Rules now\n=========\n\nRun the tests.",
    },
    {
      name: '"---" rules',
      markdown: "Before\n\n---\n\nAfter",
      edited: "Before now\n\n---\n\nAfter",
    },
    {
      name: '"~~~" code fences',
      markdown: "# Code\n\n~~~js\nconst a = 1;\n~~~",
      edited: "# Code now\n\n~~~js\nconst a = 1;\n~~~",
    },
  ])("opens $name without a change, and an edit keeps them", async ({ markdown, edited }) => {
    const onChange = await open(markdown);
    expect(onChange).not.toHaveBeenCalled();

    await typeIntoFirstText("now");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(edited);
  });

  it("opens markdown it cannot write back the same way without a change", async () => {
    // Tables get padded and two-space line breaks are dropped, whatever the
    // settings, so opening these used to count as an edit.
    for (const markdown of ["| a | b |\n|---|---|\n| 1 | 2 |", "First line  \nsecond line"]) {
      const onChange = await open(markdown);
      expect(onChange, markdown).not.toHaveBeenCalled();
    }
  });
});
