// @vitest-environment jsdom

import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  COMMAND_PRIORITY_CRITICAL,
  PASTE_COMMAND,
  UNDO_COMMAND,
  type LexicalEditor,
} from "lexical";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  let opened = 0;

  // jsdom has no ClipboardEvent or DragEvent. The editor's own paste handling
  // checks events against them, so a paste that reached it would throw.
  const missingEvents = {
    ClipboardEvent: class ClipboardEvent extends Event {},
    DragEvent: class DragEvent extends Event {},
  };
  const addedEvents = Object.keys(missingEvents).filter((name) => !(name in globalThis));
  beforeAll(() => {
    for (const name of addedEvents) Object.assign(globalThis, { [name]: missingEvents[name as keyof typeof missingEvents] });
  });
  afterAll(() => {
    for (const name of addedEvents) Reflect.deleteProperty(globalThis, name);
  });

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
  async function open(markdown: string, props: Partial<ComponentProps<typeof MarkdownEditor>> = {}) {
    const onChange = vi.fn();
    await act(async () => {
      root.render(<MarkdownEditor key={opened++} value={markdown} onChange={onChange} {...props} />);
    });
    await settle();
    expect(container.querySelector("textarea"), "the rich editor loaded").toBeNull();
    return onChange;
  }

  function editable() {
    return container.querySelector<HTMLElement>('[contenteditable="true"]')!;
  }

  function lexical() {
    const editor = (editable() as HTMLElement & { __lexicalEditor?: LexicalEditor }).__lexicalEditor;
    expect(editor, "the rich editor is on the page").toBeDefined();
    return editor!;
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

  /** A paste of plain text, as the clipboard gives it. */
  function pasteEvent(text: string) {
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { types: ["text/plain"], getData: (type: string) => (type === "text/plain" ? text : "") },
    });
    return paste;
  }

  /** Pastes into the rich text, at its end. Gives back whether the editor's own paste handling saw the paste. */
  async function pasteAtEnd(paste: Event) {
    await act(async () => {
      lexical().update(() => {
        $getRoot().selectEnd();
      });
    });
    // Seeing it, that handling puts the plain text in, a second time.
    const editorSawPaste = vi.fn(() => false);
    const stopWatching = lexical().registerCommand(PASTE_COMMAND, editorSawPaste, COMMAND_PRIORITY_CRITICAL);
    await act(async () => {
      editable().dispatchEvent(paste);
    });
    await settle();
    stopWatching();
    return editorSawPaste;
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

  it("pastes markdown once", async () => {
    const onChange = await open("Before.");
    const paste = pasteEvent("- Run the tests.\n- Ask first.");
    const editorSawPaste = await pasteAtEnd(paste);

    expect(paste.defaultPrevented).toBe(true);
    // It went on to the editor's own paste handling, which pasted the plain
    // text in a second time.
    expect(editorSawPaste).not.toHaveBeenCalled();
    expect(onChange.mock.lastCall?.[0]).toContain("Run the tests.");
  });

  describe("front matter", () => {
    // The YAML block at the top of agent instructions and skills. The editor
    // used to write the first "---" as "***", the YAML as a paragraph with
    // escapes ("tags: \[printing") and the closing "---" as a heading underline.
    const FRONT_MATTER = "---\nname: Acme Printing\ndescription: Printing and design\ntags: [printing, design, mailing]\n---\n";
    const BOM = String.fromCharCode(0xfeff);
    const asFile = { frontMatter: true };

    /**
     * Opens a whole file in an editor whose value follows its changes, as the
     * page holding a file does. Gives back every value the editor sends.
     */
    async function openFile(markdown: string) {
      const sent: string[] = [];
      function Page() {
        const [value, setValue] = useState(markdown);
        return (
          <MarkdownEditor
            value={value}
            onChange={(next) => {
              sent.push(next);
              setValue(next);
            }}
            frontMatter
          />
        );
      }
      await act(async () => {
        root.render(<Page key={opened++} />);
      });
      await settle();
      return sent;
    }

    function frontMatterBox() {
      return container.querySelector<HTMLElement>('[data-testid="front-matter"]');
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
        markdown: `${BOM}${FRONT_MATTER}\n## Identity\n\nPrints things.`,
        edited: `${BOM}${FRONT_MATTER}\n## Identity now\n\nPrints things.`,
      },
    ])("opens $name without a change, and an edit keeps it byte for byte", async ({ markdown, edited }) => {
      const onChange = await open(markdown, asFile);
      expect(onChange).not.toHaveBeenCalled();

      await typeIntoFirstText("now");
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenLastCalledWith(edited);
      // Shown above the editor, as written, rather than in it.
      expect(frontMatterBox()?.textContent).toContain("tags: [printing, design, mailing]");
      expect(editable().textContent).not.toContain("Acme Printing");
    });

    it("is plain markdown where the editor is not given whole files", async () => {
      // Comments, descriptions and documents read a block like this as markdown.
      const onChange = await open(`${FRONT_MATTER}\n## Identity`);
      expect(onChange).not.toHaveBeenCalled();
      expect(frontMatterBox()).toBeNull();
      expect(editable().textContent).toContain("Acme Printing");
    });

    it("keeps a file that is only front matter, and starts text written after it on a new line", async () => {
      for (const markdown of [FRONT_MATTER, FRONT_MATTER.slice(0, -1)]) {
        const onChange = await open(markdown, asFile);
        expect(onChange, JSON.stringify(markdown)).not.toHaveBeenCalled();

        // Writing into the empty editor.
        await act(async () => {
          lexical().update(() => {
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
      const onChange = await open("---\nname: Acme Printing\n\n## Identity\n\nPrints things.", asFile);
      expect(onChange).not.toHaveBeenCalled();
      expect(frontMatterBox()).toBeNull();
      expect(editable().textContent).toContain("name: Acme Printing");
      expect(editable().textContent).toContain("Prints things.");
    });

    it("reads a divider with ordinary text under it as markdown, not as front matter", async () => {
      const onChange = await open("---\n\nIntro text.\n\n---\n\nMore.", asFile);
      expect(frontMatterBox()).toBeNull();

      await typeIntoFirstText("now");
      expect(onChange).toHaveBeenLastCalledWith("---\n\nIntro text. now\n\n---\n\nMore.");
    });

    it("never reads a fenced code block as front matter", async () => {
      // The only other "---" line is inside the code block.
      const onChange = await open("---\nname: Acme Printing\n\n```yaml\nkey: 1\n---\n```\n\nText.", asFile);
      expect(frontMatterBox()).toBeNull();

      await typeIntoFirstText("now");
      expect(onChange).toHaveBeenLastCalledWith("---\n\nname: Acme Printing now\n\n```yaml\nkey: 1\n---\n```\n\nText.");
    });

    it("keeps a divider at the start of the markdown after the front matter", async () => {
      // A divider, then a line that looks like a YAML key. Every divider used
      // to be written as "***".
      const onChange = await open(`${FRONT_MATTER}\n---\n\nOwner: the team\n\n---\n\nMore.`, asFile);
      await typeIntoFirstText("now");
      expect(onChange).toHaveBeenLastCalledWith(`${FRONT_MATTER}\n---\n\nOwner: the team now\n\n---\n\nMore.`);
    });

    it.each([
      { name: "Section A", section: "Section A" },
      // Looks like a YAML key, so read again it would be front matter.
      { name: "a line like a YAML key", section: "Owner: the team" },
    ])("keeps $name in the editor when an edit puts it between dividers at the top, and Undo puts back what was there", async ({ section }) => {
      const file = `Intro\n\n---\n\n${section}\n\n---\n\nSection B`;
      const sent = await openFile(file);

      // Deleting the intro.
      await act(async () => {
        lexical().update(() => {
          $getRoot().getFirstChild()?.remove();
        });
      });
      await settle();
      expect(sent.at(-1)).toBe(`---\n\n${section}\n\n---\n\nSection B`);
      // It used to jump into a frontmatter box.
      expect(frontMatterBox()).toBeNull();
      expect(editable().textContent).toContain(section);

      await act(async () => {
        lexical().dispatchCommand(UNDO_COMMAND, undefined);
      });
      await settle();
      // It used to come back twice, with the dividers as "***".
      expect(sent.at(-1)).toBe(file);
    });

    it("takes the front matter of a whole file pasted into the rich text as the file's, and pastes only the rest", async () => {
      const sent = await openFile("---\nname: Old name\n---\n\nOld text.");
      const paste = pasteEvent("---\nname: Acme Printing\ntags: [printing, design]\n---\n\n## Identity\n\nPrints things.");
      const editorSawPaste = await pasteAtEnd(paste);

      expect(paste.defaultPrevented).toBe(true);
      expect(editorSawPaste).not.toHaveBeenCalled();
      const file = sent.at(-1)!;
      // The pasted front matter as pasted. It used to go into the rich text,
      // to come out as "***" and escaped text.
      expect(file.startsWith("---\nname: Acme Printing\ntags: [printing, design]\n---\n\n")).toBe(true);
      expect(file).toContain("Old text.");
      expect(file).toContain("Identity");
      expect(file).toContain("Prints things.");
      expect(file).not.toContain("***");
      expect(frontMatterBox()?.textContent).toContain("tags: [printing, design]");
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
      const onChange = await open(`${FRONT_MATTER}${body}`, asFile);

      const yaml = await editFrontMatter();
      expect(yaml.value).toBe("name: Acme Printing\ndescription: Printing and design\ntags: [printing, design, mailing]");

      await act(async () => {
        setTextareaValue(yaml, "name: Acme Printing\ndescription: Printing\ntags: [printing]");
      });
      expect(onChange).toHaveBeenLastCalledWith(
        `---\nname: Acme Printing\ndescription: Printing\ntags: [printing]\n---\n${body}`,
      );
    });

    it("keeps what is typed in the front matter box while it cannot be saved, and says why", async () => {
      const body = "\n## Identity\n";
      const onChange = await open(`${FRONT_MATTER}${body}`, asFile);
      const yaml = await editFrontMatter();

      for (const { typed, reason } of [
        // A line of only "---" would end the front matter there.
        { typed: "name: Acme Printing\n---\ntags: [printing]", reason: "a line of only --- or ... would end the frontmatter" },
        { typed: "Acme Printing", reason: "has to start with a line like name: value" },
      ]) {
        await act(async () => {
          setTextareaValue(yaml, typed);
        });
        expect(onChange, typed).not.toHaveBeenCalled();
        // It used to be thrown away, with the cursor sent to the end.
        expect(yaml.value).toBe(typed);
        expect(frontMatterBox()!.textContent).toContain(reason);
      }

      await act(async () => {
        setTextareaValue(yaml, "name: Acme");
      });
      expect(onChange).toHaveBeenLastCalledWith(`---\nname: Acme\n---\n${body}`);
      expect(frontMatterBox()!.textContent).not.toContain("Not saved");
    });

    it("leaves a paste into the front matter's text box to that box", async () => {
      const onChange = await open(`${FRONT_MATTER}\n## Identity`, asFile);
      const yaml = await editFrontMatter();

      // A YAML list looks like a markdown list, and the editor takes markdown
      // pastes over to put them in the rich text.
      const paste = pasteEvent("skills:\n- printing\n- design");
      await act(async () => {
        yaml.dispatchEvent(paste);
      });
      await settle();

      expect(paste.defaultPrevented).toBe(false);
      expect(onChange).not.toHaveBeenCalled();
    });

    it("does not let a file dropped beside the rich text open in place of the page", async () => {
      async function dropFileOn(target: Element) {
        const drop = new Event("drop", { bubbles: true, cancelable: true });
        Object.defineProperty(drop, "dataTransfer", {
          value: { types: ["Files"], files: [new File(["x"], "photo.png", { type: "image/png" })] },
        });
        await act(async () => {
          target.dispatchEvent(drop);
        });
        return drop.defaultPrevented;
      }

      for (const props of [{ imageUploadHandler: async () => "/image.png" }, {}, { readOnly: true }]) {
        await open(`${FRONT_MATTER}\n## Identity`, { ...asFile, ...props });
        expect(await dropFileOn(frontMatterBox()!), `on the front matter, with ${JSON.stringify(Object.keys(props))}`).toBe(true);
      }
      // The editor's own edge, where it takes dropped files.
      await open("## Identity", { imageUploadHandler: async () => "/image.png" });
      expect(await dropFileOn(container.firstElementChild!), "on the editor's edge").toBe(true);
    });
  });
});
