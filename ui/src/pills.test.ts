// @vitest-environment jsdom

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * A pill keeps its text on one line.
 *
 * A pill is a rounded-full box with padding either side of a count or a short
 * label: "0 agents", "Paused", a status. Squeezed in a row on a phone, Skill
 * Studio's agents pill broke into "0" over "agents". Badge holds its line
 * already (`whitespace-nowrap`), but most of the app's pills are written by
 * hand, so index.css holds the line for every rounded-full box with `px-`
 * padding, in the base layer so that a chip holding a sentence can still say
 * `whitespace-normal`.
 *
 * This checks the rule is there, that it reaches each pill written in the
 * source files under src, and that only the chips in HOLDS_A_SENTENCE wrap.
 *
 * One line is wrong for text a person wrote, which can be any length: a long
 * label name ran past the edge of the properties panel and into the next
 * column of the board. A pill holding such text shows it through PillText
 * (components/PillText), which cuts it short with "…" and keeps the whole of
 * it as the tooltip, and lets the pill give way (PILL_HOLDING_TEXT_CLASS).
 * Which text a person wrote cannot be told from the source for certain, so
 * the check below goes by what is read: a `name`, `title`, `email` or `key`,
 * which covers labels, agents, companies, issues and documents. Text read
 * under another name, or put together outside the pill, is not seen.
 */

// Under jsdom, `new URL(..., import.meta.url)` resolves against the test page
// rather than the disk, so the path is built from this file's own location.
const srcDir = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(srcDir, "index.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Files with a pill-shaped chip that may wrap, because it holds more than a pill does, and why. */
const HOLDS_A_SENTENCE: Record<string, string> = {
  "components/DevRestartBanner.tsx": "what the dev server waits for, in a sentence longer than a phone is wide",
  "components/IssueChatThread.tsx": "the hint above the reply box, a whole sentence",
  "pages/ProjectDetail.tsx": "the budget stop label, five spaced capitals nearly a phone's width",
};

/** Classes that let a chip's text wrap again. */
const WRAPS = /^(whitespace-normal|whitespace-pre-wrap|whitespace-pre-line|break-words|break-all)$/;

/** The pill rule in a stylesheet: its selector, its declarations and the blocks it sits in. */
function pillRule(stylesheet: string): { selector: string; body: string; within: string[] } | null {
  const match = /([^{};]*\.rounded-full[^{};]*\[class\*="px-"\][^{};]*)\{([^}]*)\}/.exec(stylesheet);
  if (!match) return null;
  const within: string[] = [];
  let header = 0;
  for (let index = 0; index < match.index; index += 1) {
    if (stylesheet[index] === "{") {
      within.push(stylesheet.slice(header, index).trim());
      header = index + 1;
    } else if (stylesheet[index] === "}") {
      within.pop();
      header = index + 1;
    } else if (stylesheet[index] === ";") {
      header = index + 1;
    }
  }
  return { selector: match[1]!.trim(), body: match[2]!, within };
}

const isPill = (classes: string[]) => classes.includes("rounded-full") && classes.some((name) => /^(?:[\w@[\]-]+:)*px-/.test(name));

/** The pill-shaped class lists written in a file, with their lines. */
function pillClassLists(fileName: string, source: string): Array<{ line: number; classes: string[] }> {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lists: Array<{ line: number; classes: string[] }> = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const classes = node.text.trim().split(/\s+/);
      if (isPill(classes)) {
        lists.push({ line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, classes });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return lists;
}

/** A name, a title, an email or a key read for showing: text a person wrote. */
const USER_TEXT = /^(?:name|title|email|key)$|(?:Name|Title|Email|Key)$/;

/**
 * The pills in a file that show text a person wrote other than through
 * PillText, or show it through PillText in a pill that cannot give way
 * (without PILL_HOLDING_TEXT_CLASS, and no width of its own on the text), as
 * the lines they start on.
 */
function userTextPillsNotCutShort(fileName: string, source: string): number[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // Class lists kept in a constant of the file and named by it.
  const constants = new Map<string, string[]>();
  const strings = (node: ts.Node): string[] => {
    const found: string[] = [];
    const collect = (inner: ts.Node) => {
      if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) found.push(inner.text);
      ts.forEachChild(inner, collect);
    };
    collect(node);
    return found;
  };
  const findConstants = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      constants.set(node.name.text, strings(node.initializer));
    }
    ts.forEachChild(node, findConstants);
  };
  findConstants(sourceFile);

  const attribute = (element: ts.JsxOpeningLikeElement, name: string) =>
    element.attributes.properties.find(
      (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText(sourceFile) === name,
    );
  const tagOf = (node: ts.Node) =>
    ts.isJsxElement(node)
      ? node.openingElement.tagName.getText(sourceFile)
      : ts.isJsxSelfClosingElement(node)
        ? node.tagName.getText(sourceFile)
        : null;

  /** Whether a pill's contents show user text outside PillText, and the PillText elements in it. */
  const contents = (children: ts.Node) => {
    let bare = false;
    const pillTexts: ts.JsxSelfClosingElement[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxAttribute(node)) return;
      const tag = tagOf(node);
      if (tag === "PillText") {
        if (ts.isJsxSelfClosingElement(node)) pillTexts.push(node);
        return;
      }
      if (ts.isPropertyAccessExpression(node) && USER_TEXT.test(node.name.text)) bare = true;
      ts.forEachChild(node, visit);
    };
    visit(children);
    return { bare, pillTexts };
  };

  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node)) {
      const initializer = attribute(node.openingElement, "className")?.initializer;
      const classText = initializer?.getText(sourceFile) ?? "";
      const classLists = initializer ? strings(initializer) : [];
      for (const name of classText.match(/\b[A-Za-z_]\w*\b/g) ?? []) classLists.push(...(constants.get(name) ?? []));
      const holdsText = classText.includes("PILL_HOLDING_TEXT_CLASS");
      if (holdsText || classLists.some((list) => isPill(list.trim().split(/\s+/)))) {
        let bare = false;
        const pillTexts: ts.JsxSelfClosingElement[] = [];
        for (const child of node.children) {
          const found = contents(child);
          bare ||= found.bare;
          pillTexts.push(...found.pillTexts);
        }
        const textHasOwnWidth = (element: ts.JsxSelfClosingElement) =>
          /\bmax-w-/.test(attribute(element, "className")?.initializer?.getText(sourceFile) ?? "");
        if (bare || (pillTexts.length > 0 && !holdsText && !pillTexts.every(textHasOwnWidth))) {
          lines.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return lines;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    if (!/\.tsx?$/.test(entry.name) || /\.d\.ts$/.test(entry.name)) return [];
    if (/\.(test|spec|stories)\.tsx?$/.test(entry.name)) return [];
    return [file];
  });
}

const pills = sourceFiles(srcDir).flatMap((file) => {
  const relative = path.relative(srcDir, file).split(path.sep).join("/");
  return pillClassLists(relative, readFileSync(file, "utf8")).map((pill) => ({ ...pill, relative }));
});

/** Whether an element with these classes is reached by the selector. */
function reaches(selector: string, classes: string[]): boolean {
  const element = document.createElement("span");
  element.className = classes.join(" ");
  return element.matches(selector);
}

describe("a pill", () => {
  const rule = pillRule(css);

  it("keeps its text on one line, by a rule in index.css", () => {
    expect(rule, "the pill rule in index.css").not.toBeNull();
    expect(rule!.body).toMatch(/white-space:\s*nowrap/);
  });

  it("can still be told to wrap by a class, because the rule is in the base layer", () => {
    // In the utilities layer, or outside any layer, it would beat
    // whitespace-normal, and a chip holding a sentence would run off a phone.
    expect(rule!.within).toEqual(["@layer base"]);
  });

  it("is reached by the rule, however it is written", () => {
    expect(pills.length, "pills found in the source").toBeGreaterThan(50);
    const missed = pills
      .filter(({ classes }) => !reaches(rule!.selector, classes))
      .map(({ relative, line }) => `${relative}:${line}`);
    expect(missed).toEqual([]);
    // Skill Studio's agents pill, and one with padding only from md up.
    expect(reaches(rule!.selector, "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs".split(" "))).toBe(true);
    expect(reaches(rule!.selector, "flex size-12 items-center rounded-full md:px-3".split(" "))).toBe(true);
    // A status dot and an avatar have no text to keep on a line.
    expect(reaches(rule!.selector, "h-2 w-2 rounded-full bg-red-400".split(" "))).toBe(false);
  });

  it("only wraps where it holds a sentence", () => {
    const wrapping = pills
      .filter(({ classes, relative }) => classes.some((name) => WRAPS.test(name)) && !(relative in HOLDS_A_SENTENCE))
      .map(({ relative, line }) => `${relative}:${line}`);
    expect(wrapping, "a pill holding a count or a short label keeps it on one line").toEqual([]);
  });

  it("lists no file that has no wrapping chip any more", () => {
    const stale = Object.keys(HOLDS_A_SENTENCE).filter(
      (relative) =>
        !pills.some((pill) => pill.relative === relative && pill.classes.some((name) => WRAPS.test(name))),
    );
    expect(stale).toEqual([]);
  });
});

describe("a pill holding text a person wrote", () => {
  it("cuts it short with the whole of it as the tooltip, and gives way in its row", () => {
    // On one line, a long label name ran past the edge of the properties
    // panel, into the next column of the board, and made the issue page
    // scroll sideways.
    const offending = sourceFiles(srcDir).flatMap((file) => {
      const relative = path.relative(srcDir, file).split(path.sep).join("/");
      return userTextPillsNotCutShort(relative, readFileSync(file, "utf8")).map((line) => `${relative}:${line}`);
    });
    expect(offending, "show the text through PillText, in a pill with PILL_HOLDING_TEXT_CLASS").toEqual([]);
  });

  it("is told apart however the pill and its text are written", () => {
    const page = [
      'const a = <span className="inline-flex rounded-full border px-2 py-0.5">{label.name}</span>;',
      'const b = <span className={cn("rounded-full border px-2", PILL_HOLDING_TEXT_CLASS)}><PillText text={label.name} /></span>;',
      'const c = <span className="rounded-full px-2"><span className="truncate">{agent.name}</span></span>;',
      'const d = <span className="rounded-full px-2 py-0.5">{count} agents</span>;',
      'const e = <span className="rounded-full px-2"><PillText text={company.name} /></span>;',
      'const f = <span className="rounded-full px-2"><PillText text={company.name} className="max-w-24" /></span>;',
      'const chip = "inline-flex rounded-full px-1.5 text-[10px]";',
      "const g = <span className={chip}>{file.documentKey}</span>;",
      'const h = <span key={doc.key} className="rounded-full px-2" title={doc.title}>Current</span>;',
    ].join("\n");
    expect(userTextPillsNotCutShort("page.tsx", page)).toEqual([1, 3, 5, 8]);
  });
});
