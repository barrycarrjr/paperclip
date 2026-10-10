// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { buildFileTree, FileTree } from "./FileTree";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A nested file has to sit further in than the folder it is in.
 *
 * FileTree puts no padding on a row itself. It sets the row's depth as
 * --file-tree-depth and gives the row the class file-tree-row, and index.css
 * turns the two into an indent. The October 2026 port from upstream (PR #12)
 * brought the component without those rules, so in Skill Studio every file sat
 * flush with its folder. jsdom does no layout, so these tests check both halves
 * of that hand-off: what each row carries, and that the stylesheet has a rule
 * that reads it.
 */

// Under jsdom, `new URL(..., import.meta.url)` resolves against the test page
// rather than the disk, so the path is built from this file's own location.
const css = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../index.css"), "utf8");

type StyleRule = { selector: string; body: string; media: string | null };

/** The style rules in index.css, each with the @media condition around it. */
function styleRules(): StyleRule[] {
  const rules: StyleRule[] = [];
  const walk = (text: string, media: string | null) => {
    let index = 0;
    for (let open = text.indexOf("{", index); open !== -1; open = text.indexOf("{", index)) {
      let close = open + 1;
      for (let depth = 1; depth > 0 && close < text.length; close += 1) {
        if (text[close] === "{") depth += 1;
        else if (text[close] === "}") depth -= 1;
      }
      // Statements such as @import end in a semicolon before the next block.
      const prelude = text.slice(index, open).split(";").pop()!.trim();
      const body = text.slice(open + 1, close - 1);
      if (prelude.startsWith("@media")) walk(body, prelude.slice("@media".length).trim());
      else if (!prelude.startsWith("@")) rules.push({ selector: prelude, body, media });
      index = close;
    }
  };
  walk(css.replace(/\/\*[\s\S]*?\*\//g, ""), null);
  return rules;
}

const files = {
  "SKILL.md": "",
  "references/tone.md": "",
  "references/style/voice.md": "",
};

const mounted: Array<{ container: HTMLDivElement; root: Root }> = [];

function renderRows(layout: "default" | "explorer") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  act(() => {
    root.render(
      <FileTree
        nodes={buildFileTree(files)}
        selectedFile="SKILL.md"
        expandedDirs={new Set(["references", "references/style"])}
        onToggleDir={() => {}}
        onSelectFile={() => {}}
        showCheckboxes={false}
        layout={layout}
      />,
    );
  });
  return [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')];
}

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});

describe("FileTree indentation", () => {
  it("gives every row its depth and the class the stylesheet indents", () => {
    const rows = renderRows("default");

    expect(rows.map((row) => [row.dataset.fileTreePath, row.style.getPropertyValue("--file-tree-depth")])).toEqual([
      ["SKILL.md", "0"],
      ["references", "0"],
      ["references/tone.md", "1"],
      ["references/style", "1"],
      ["references/style/voice.md", "2"],
    ]);
    for (const row of rows) expect(row.classList.contains("file-tree-row")).toBe(true);
  });

  it("has a stylesheet rule for each file tree class a row carries, indenting by depth", () => {
    const rowClasses = new Set(
      [...renderRows("default"), ...renderRows("explorer")].flatMap((row) =>
        [...row.classList].filter((name) => name.startsWith("file-tree-")),
      ),
    );
    expect([...rowClasses].sort()).toEqual(["file-tree-row", "file-tree-row-explorer"]);

    const rules = styleRules();
    for (const name of rowClasses) {
      const rule = rules.find((candidate) => candidate.selector === `.${name}` && candidate.media === null);
      expect(rule, `expected index.css to style .${name}`).toBeDefined();
      // Each level adds one step, so a child always sits further in than its folder.
      expect(rule!.body).toMatch(
        /padding-inline-start:[^;]*var\(--file-tree-depth\)\s*\*\s*var\(--file-tree-indent-step\)/,
      );
    }
  });

  it("steps in by less on narrow screens, so deep paths keep room for their names", () => {
    const rules = styleRules();
    const narrow = rules.find((rule) => rule.selector === ".file-tree-row" && rule.media !== null);
    const defaults = rules.find(
      (rule) => rule.selector === ":root" && rule.media === null && rule.body.includes("--file-tree-indent-step:"),
    );
    /** How many spacing units one level steps in by. */
    const step = (body: string) =>
      Number(/--file-tree-indent-step:\s*calc\(var\(--spacing\)\s*\*\s*([\d.]+)\)/.exec(body)?.[1]);

    expect(narrow, "expected index.css to style .file-tree-row on narrow screens").toBeDefined();
    expect(defaults, "expected index.css to set the file tree indent defaults").toBeDefined();
    expect(narrow!.media).toMatch(/40rem/);
    expect(step(narrow!.body)).toBeLessThan(step(defaults!.body));
    expect(narrow!.body).toMatch(/--file-tree-indent-max:/);
  });
});
