import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * A page that fills the page area and scrolls a box of its own keeps room at
 * the end of that box for the Clippy launcher.
 *
 * The page area keeps room under a page that scrolls (PAGE_END_ROOM_CLASS in
 * lib/narrow-layout), but a page such as portfolio issues fills the area and
 * scrolls a list inside it, so the area never scrolls and its room never came
 * on: at 1280 pixels the "Ask Clippy anything" pill sat on the end of the
 * last row. Such a box is a `flex-1 min-h-0` box that scrolls; it carries
 * PAGE_SCROLL_BOX_END_ROOM_CLASS. jsdom lays nothing out, so this reads the
 * pages' classes.
 */

const srcDir = path.dirname(fileURLToPath(import.meta.url));

function pageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return pageFiles(file);
    if (!/\.tsx$/.test(entry.name) || /\.(test|spec|stories)\.tsx$/.test(entry.name)) return [];
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

/** The boxes in a file that fill the rest of a page's height and scroll: the line of each, and whether it keeps the room. */
function scrollBoxes(fileName: string, source: string): Array<{ line: number; keepsRoom: boolean }> {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const boxes: Array<{ line: number; keepsRoom: boolean }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(sourceFile) === "className" && node.initializer) {
      const classes = stringsIn(node.initializer).split(/\s+/);
      const fillsTheRest = classes.includes("flex-1") && classes.includes("min-h-0");
      const scrolls = classes.includes("overflow-y-auto") || classes.includes("overflow-auto");
      if (fillsTheRest && scrolls) {
        boxes.push({
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          keepsRoom: /\bPAGE_SCROLL_BOX_END_ROOM_CLASS\b/.test(node.initializer.getText(sourceFile)),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return boxes;
}

/** Pages whose such boxes are inside a dialog, which covers the launcher, with where. */
const IN_A_DIALOG: Record<string, string> = {
  "pages/IssueDetail.tsx": "the stop and cancel dialog for a tree of tasks",
  "pages/Routines.tsx": "the new routine dialog",
};

const boxes = pageFiles(path.join(srcDir, "pages")).flatMap((file) => {
  const relative = path.relative(srcDir, file).split(path.sep).join("/");
  return scrollBoxes(relative, readFileSync(file, "utf8")).map((box) => ({ ...box, relative }));
});

describe("a page's own scrolling box", () => {
  it("keeps room at its end for the Clippy launcher", () => {
    const withoutRoom = boxes
      .filter((box) => !box.keepsRoom && !(box.relative in IN_A_DIALOG))
      .map(({ relative, line }) => `${relative}:${line}`);
    expect(withoutRoom, "add PAGE_SCROLL_BOX_END_ROOM_CLASS (lib/narrow-layout)").toEqual([]);
  });

  it("is found on the pages that scroll a box of their own", () => {
    // The portfolio lists, the instance log, Skill Studio's panes and the
    // transcript lab. Fewer would mean the check stopped seeing some.
    expect(boxes.filter((box) => box.keepsRoom).length).toBeGreaterThanOrEqual(16);
    expect(boxes.some((box) => box.relative === "pages/PortfolioIssues.tsx" && box.keepsRoom)).toBe(true);
  });

  it("lists no page as a dialog's that has no such box any more", () => {
    const stale = Object.keys(IN_A_DIALOG).filter((relative) => !boxes.some((box) => box.relative === relative && !box.keepsRoom));
    expect(stale).toEqual([]);
  });

  it("is told apart however its classes are written", () => {
    const page = [
      'const a = <div className="flex-1 min-h-0 overflow-y-auto px-6 py-3" />;',
      'const b = <div className={cn("min-h-0 flex-1 overflow-auto p-3", PAGE_SCROLL_BOX_END_ROOM_CLASS)} />;',
      'const c = <div className="flex-1 overflow-y-auto" />;',
      'const d = <div className="min-h-0 flex-1" />;',
    ].join("\n");
    expect(scrollBoxes("page.tsx", page)).toEqual([
      { line: 1, keepsRoom: false },
      { line: 2, keepsRoom: true },
    ]);
  });
});
