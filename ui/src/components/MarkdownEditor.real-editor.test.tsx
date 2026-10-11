// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { $createParagraphNode, $createTextNode, $getRoot, $isTextNode, type LexicalEditor } from "lexical";
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

  describe("front matter", () => {
    // The YAML block at the top of agent instructions and skills. The editor
    // used to write the first "---" as "***", the YAML as a paragraph with
    // escapes ("tags: \[printing") and the closing "---" as a heading underline.
    const FRONT_MATTER = "---\nname: Acme Printing\ndescription: Printing and design\ntags: [printing, design, mailing]\n---\n";

    function frontMatterBox() {
      return container.querySelector<HTMLElement>('[data-testid="front-matter"]');
    }

    function editable() {
      return container.querySelector<HTMLElement>('[contenteditable="true"]')!;
    }

    function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, value);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }

    it.each([
      {
        name: "front matter",
        markdown: `${FRONT_MATTER}\n## Identity\n\nPrints things.`,
        edited: `${FRONT_MATTER}\n## Identity now\n\nPrints things.`,
      },
      {
        name: "front matter followed by no blank line",
        markdown: `${FRONT_MATTER}## Identity\n\nPrints things.`,
        edited: `${FRONT_MATTER}## Identity now\n\nPrints things.`,
      },
      {
        name: 'front matter and "---" used as a rule later',
        markdown: `${FRONT_MATTER}\n## Identity\n\nPrints things.\n\n---\n\nMore.`,
        edited: `${FRONT_MATTER}\n## Identity now\n\nPrints things.\n\n---\n\nMore.`,
      },
      {
        name: "front matter with Windows line endings",
        markdown: `${FRONT_MATTER}\n## Identity\n\nPrints things.`.replace(/\n/g, "\r\n"),
        edited: `${FRONT_MATTER}\n## Identity now\n\nPrints things.`.replace(/\n/g, "\r\n"),
      },
      {
        name: "front matter after a byte order mark",
        markdown: `\uFEFF${FRONT_MATTER}\n## Identity\n\nPrints things.`,
        edited: `\uFEFF${FRONT_MATTER}\n## Identity now\n\nPrints things.`,
      },
    ])("opens $name without a change, and an edit keeps it byte for byte", async ({ markdown, edited }) => {
      const onChange = await open(markdown);
      expect(onChange).not.toHaveBeenCalled();

      await typeIntoFirstText("now");
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenLastCalledWith(edited);
      // Shown above the editor, as written, rather than in it.
      expect(frontMatterBox()?.textContent).toContain("tags: [printing, design, mailing]");
      expect(editable().textContent).not.toContain("Acme Printing");
    });

    it("keeps a file that is only front matter, and starts text written after it on a new line", async () => {
      for (const markdown of [FRONT_MATTER, FRONT_MATTER.slice(0, -1)]) {
        const onChange = await open(markdown);
        expect(onChange, JSON.stringify(markdown)).not.toHaveBeenCalled();

        // Writing into the empty editor.
        const editor = (editable() as HTMLElement & { __lexicalEditor?: LexicalEditor }).__lexicalEditor!;
        await act(async () => {
          editor.update(() => {
            const paragraph = $createParagraphNode();
            paragraph.append($createTextNode("Prints things."));
            $getRoot().clear().append(paragraph);
          });
        });
        await settle();
        expect(onChange).toHaveBeenLastCalledWith(`${FRONT_MATTER}Prints things.`);
        expect(frontMatterBox()?.textContent).toContain("name: Acme Printing");
      }
    });

    it("leaves a block that is never closed in the editor as text", async () => {
      const onChange = await open("---\nname: Acme Printing\n\n## Identity\n\nPrints things.");
      expect(onChange).not.toHaveBeenCalled();
      expect(frontMatterBox()).toBeNull();
      expect(editable().textContent).toContain("name: Acme Printing");
      expect(editable().textContent).toContain("Prints things.");
    });

    /** Presses the front matter's Edit button and gives back its text box. */
    async function editFrontMatter() {
      const edit = Array.from(frontMatterBox()!.querySelectorAll("button")).find((button) => button.textContent === "Edit");
      expect(edit, "an Edit button for the front matter").toBeDefined();
      await act(async () => {
        edit!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      const yaml = frontMatterBox()!.querySelector<HTMLTextAreaElement>("textarea");
      expect(yaml, "the front matter's text box").not.toBeNull();
      return yaml!;
    }

    it("edits the front matter as plain text and keeps the rest as it was", async () => {
      const body = "\n## Identity\n\n* Prints things.\n";
      const onChange = await open(`${FRONT_MATTER}${body}`);

      const yaml = await editFrontMatter();
      expect(yaml.value).toBe("name: Acme Printing\ndescription: Printing and design\ntags: [printing, design, mailing]");

      await act(async () => {
        setTextareaValue(yaml, "name: Acme Printing\ndescription: Printing\ntags: [printing]");
      });
      expect(onChange).toHaveBeenLastCalledWith(
        `---\nname: Acme Printing\ndescription: Printing\ntags: [printing]\n---\n${body}`,
      );

      // A line of only "---" would end the front matter there, so it is not taken.
      onChange.mockClear();
      await act(async () => {
        setTextareaValue(yaml, "name: Acme Printing\n---\ntags: [printing]");
      });
      expect(onChange).not.toHaveBeenCalled();
      expect(frontMatterBox()!.textContent).toContain("ends the frontmatter");
    });

    it("leaves a paste into the front matter's text box to that box", async () => {
      const onChange = await open(`${FRONT_MATTER}\n## Identity`);
      const yaml = await editFrontMatter();

      // A YAML list looks like a markdown list, and the editor takes markdown
      // pastes over to put them in the rich text.
      const paste = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", {
        value: { types: ["text/plain"], getData: () => "skills:\n- printing\n- design" },
      });
      await act(async () => {
        yaml.dispatchEvent(paste);
      });
      await settle();

      expect(paste.defaultPrevented).toBe(false);
      expect(onChange).not.toHaveBeenCalled();
    });
  });
});
