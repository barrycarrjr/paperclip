// @vitest-environment jsdom

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { Checkbox } from "./components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs";

/**
 * Controls drawn smaller than a finger keep their own size on a touch screen,
 * with a 44 pixel target around them.
 *
 * On a touch screen index.css makes every button at least 44 pixels tall, so
 * a finger can hit it. Some controls cannot be that tall where they sit.
 * Stretched, a checkbox (Radix draws it as a button) was drawn as a tall thin
 * bar, and on portfolio issues every row had one; the company name over the
 * page name in the phone top bar pushed the page name down through the bar's
 * bottom line; a tab stuck out of the bar it sits in. So the rule lets those
 * keep their size and gives each a 44 pixel area around it that is not drawn:
 * the shared Checkbox and tab by name, any other control by
 * data-touch-target="around".
 *
 * This reads the touch rules in index.css, checks the shared components are
 * the elements they name, and checks the buttons drawn at most 20 pixels each
 * way opt in.
 */

// Under jsdom, `new URL(..., import.meta.url)` resolves against the test page
// rather than the disk, so the path is built from this file's own location.
const srcDir = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(srcDir, "index.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The rules inside the first block whose header matches, as selector lists and declarations. */
function rulesInside(stylesheet: string, header: RegExp): Array<{ selectors: string[]; body: string }> {
  const match = header.exec(stylesheet);
  if (!match) return [];
  let depth = 0;
  let index = stylesheet.indexOf("{", match.index);
  const start = index + 1;
  for (; index < stylesheet.length; index += 1) {
    if (stylesheet[index] === "{") depth += 1;
    else if (stylesheet[index] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return [...stylesheet.slice(start, index).matchAll(/([^{}]+)\{([^}]*)\}/g)].map((rule) => ({
    selectors: rule[1]!.split(",").map((selector) => selector.trim()),
    body: rule[2]!,
  }));
}

/** The value a rule for this exact selector gives the property, the last one winning. */
function declared(rules: ReturnType<typeof rulesInside>, selector: string, property: string): string | null {
  let value: string | null = null;
  for (const rule of rules) {
    if (!rule.selectors.includes(selector)) continue;
    const found = new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*([^;]+)`).exec(rule.body);
    if (found) value = found[1]!.trim();
  }
  return value;
}

/** The fewest pixels a length can come to: `44px`, or the pixel part of `max(100%, 44px)`. */
function leastPixels(value: string | null): number {
  if (!value) return 0;
  const pixels = /^max\(\s*100%\s*,\s*([\d.]+)px\s*\)$/.exec(value) ?? /^([\d.]+)px$/.exec(value);
  return pixels ? Number(pixels[1]) : 0;
}

const touch = rulesInside(css, /@media\s*\(pointer:\s*coarse\)/);
const SMALL_CONTROLS = ['[data-slot="checkbox"]', '[data-slot="tabs-trigger"]', '[data-touch-target="around"]'];

function rendered(element: ReturnType<typeof createElement>, selector: string): HTMLElement | null {
  const holder = document.createElement("div");
  holder.innerHTML = renderToStaticMarkup(element);
  return holder.querySelector<HTMLElement>(selector);
}

describe("a control drawn smaller than a finger, on a touch screen", () => {
  it("is let off the 44 pixel stretch every button gets, so it keeps its own size", () => {
    expect(declared(touch, "button", "min-height")).toBe("44px");
    for (const selector of SMALL_CONTROLS) {
      expect(declared(touch, selector, "min-height"), selector).toBe("0");
    }
  });

  it("still has a target of at least 44 pixels each way, in an area around it that is not drawn", () => {
    for (const selector of SMALL_CONTROLS) {
      expect(declared(touch, selector, "position"), selector).toBe("relative");
      const area = `${selector}::before`;
      expect(declared(touch, area, "content"), area).toBe('""');
      expect(declared(touch, area, "position"), area).toBe("absolute");
      for (const size of ["width", "height"]) {
        expect(leastPixels(declared(touch, area, size)), `${area} ${size}`).toBeGreaterThanOrEqual(44);
      }
      // Centred on the control.
      expect(declared(touch, area, "left"), area).toBe("50%");
      expect(declared(touch, area, "top"), area).toBe("50%");
      expect(declared(touch, area, "transform"), area).toBe("translate(-50%, -50%)");
    }
  });

  it("is the shared Checkbox and tab the rule names, and neither draws with ::before itself", () => {
    const checkbox = rendered(createElement(Checkbox, { "aria-label": "Select" }), 'button[data-slot="checkbox"]');
    expect(checkbox).not.toBeNull();
    const tab = rendered(
      createElement(Tabs, { defaultValue: "one" }, createElement(TabsList, null, createElement(TabsTrigger, { value: "one" }, "One"))),
      'button[data-slot="tabs-trigger"]',
    );
    expect(tab).not.toBeNull();
    // The tab draws its underline with ::after, which is why the area is ::before.
    for (const control of [checkbox!, tab!]) {
      expect(control.className).not.toMatch(/(^|\s)before:/);
    }
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    if (!/\.tsx$/.test(entry.name)) return [];
    if (/\.(test|spec|stories)\.tsx$/.test(entry.name)) return [];
    return [file];
  });
}

/** Every string literal under a node, joined: a className and the strings handed to cn() in it. */
function stringsIn(node: ts.Node): string {
  const found: string[] = [];
  const collect = (child: ts.Node) => {
    if (ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child)) found.push(child.text);
    ts.forEachChild(child, collect);
  };
  collect(node);
  return found.join(" ");
}

interface MarkedElement {
  line: number;
  tag: string;
  classes: string;
  touchTarget: string | null;
}

/** Each JSX element's line, tag, classes and data-touch-target value. */
function elementsIn(fileName: string, text: string): MarkedElement[] {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: MarkedElement[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      let classes = "";
      let touchTarget: string | null = null;
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute) || !attribute.initializer) continue;
        const name = attribute.name.getText(sourceFile);
        if (name === "className") classes = stringsIn(attribute.initializer);
        if (name === "data-touch-target") touchTarget = stringsIn(attribute.initializer);
      }
      out.push({
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        tag: node.tagName.getText(sourceFile),
        classes,
        touchTarget,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

/** Whether these classes draw the element at most 20 pixels along an axis (`h` or `w`). */
function drawnSmall(classes: string, axis: "h" | "w"): boolean {
  return new RegExp(String.raw`(^|\s)(${axis}|size)-(3|3\.5|4|5)(\s|$)`).test(classes);
}

/** The buttons in a file drawn at most 20 pixels each way, and whether each opts in. */
function tinyButtons(fileName: string, text: string): Array<{ line: number; optedIn: boolean }> {
  return elementsIn(fileName, text)
    .filter((element) => /^(button|Button)$/.test(element.tag))
    .filter((element) => drawnSmall(element.classes, "h") && drawnSmall(element.classes, "w"))
    .map((element) => ({ line: element.line, optedIn: element.touchTarget === "around" }));
}

const files = sourceFiles(srcDir).map((file) => ({
  relative: path.relative(srcDir, file).split(path.sep).join("/"),
  text: readFileSync(file, "utf8"),
}));

/**
 * Buttons drawn at most 20 pixels each way that are still stretched into a
 * tall bar on a touch screen, by file. Not yet looked at one by one: some sit
 * close to others like them (rows of the file tree, a run transcript, colour
 * swatches), where a 44 pixel area around each would take its neighbours'
 * taps, so each needs a look before it opts in. A count may only go down.
 */
const WAITING: Record<string, number> = {
  "components/attachments/AttachmentComposer.tsx": 1,
  "components/calendar/MonthGrid.tsx": 1,
  "components/ClippyEmptyState.tsx": 1,
  "components/ClippyToolCallCard.tsx": 1,
  "components/DocumentFrameHeader.tsx": 1,
  "components/FileTree.tsx": 1,
  "components/InfoPopoverButton.tsx": 1,
  "components/IssueDocumentsSection.tsx": 1,
  "components/LabelsPicker.tsx": 1,
  "components/ProjectProperties.tsx": 2,
  "components/transcript/RunTranscriptView.tsx": 4,
  "pages/Cases.tsx": 1,
  "pages/PortfolioIssues.tsx": 1,
  "pages/PortfolioRoutines.tsx": 1,
  "pages/ProjectDetail.tsx": 1,
};

describe("a button drawn at most 20 pixels each way", () => {
  it("keeps its size on a touch screen, with the area around it, apart from those still waiting", () => {
    const stretched: Record<string, number> = {};
    for (const { relative, text } of files) {
      const count = tinyButtons(relative, text).filter((button) => !button.optedIn).length;
      if (count > 0) stretched[relative] = count;
    }
    // A new one opts in with data-touch-target="around". One that has opted
    // in comes off the list above.
    expect(stretched).toEqual(WAITING);
  });

  it("is found by its classes, with whether it opts in", () => {
    const sample = [
      '<button className="h-4 w-4" />',
      '<button className={cn("size-5 rounded", open && "bg-accent")} data-touch-target="around" />',
      '<button className="h-4 w-8" />',
      '<Button className="h-5 w-5 opacity-0" />',
      '<span className="h-4 w-4" />',
      '<button className="h-40 w-4" />',
    ].join("\n");
    expect(tinyButtons("sample.tsx", sample)).toEqual([
      { line: 1, optedIn: false },
      { line: 2, optedIn: true },
      { line: 4, optedIn: false },
    ]);
  });

  it("opts in only where the area cannot clash: not positioned, and not drawing with ::before itself", () => {
    const clashes: string[] = [];
    for (const { relative, text } of files) {
      for (const element of elementsIn(relative, text)) {
        if (element.touchTarget === null) continue;
        if (element.touchTarget !== "around") clashes.push(`${relative}:${element.line} says "${element.touchTarget}"`);
        // The rule makes it position: relative outside any layer, which would
        // beat these, and draws the area with ::before.
        if (/(^|\s)(absolute|fixed|sticky)(\s|$)/.test(element.classes)) clashes.push(`${relative}:${element.line} is positioned`);
        if (/(^|\s)before:/.test(element.classes)) clashes.push(`${relative}:${element.line} draws with ::before`);
      }
    }
    expect(clashes).toEqual([]);
  });
});
