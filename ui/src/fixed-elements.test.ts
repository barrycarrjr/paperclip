import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Nothing a page fixes to the screen is drawn inside the page area.
 *
 * The page area (`main`) is a size container (PAGE_AREA_CONTAINER_CLASS, in
 * lib/narrow-layout), and Safari before 18.4 made a size container the box that
 * `position: fixed` elements inside it are placed against (WebKit bugs 277122
 * and 284945). There a fixed element inside the page area was pinned to the
 * page area, not the screen: on an older iPhone the agent Save bar sat at the
 * end of the page. So a page's fixed bars, notices and buttons go through
 * PageFloating (components/PageFloatingLayer), which draws them in a layer
 * beside the page area.
 *
 * This reads the source files under src for class lists that hold `fixed`, and
 * checks each one is drawn through PageFloating or through a portal of its own
 * (a Radix `...Portal`, or `createPortal`), which puts it at the end of the
 * document. Files whose fixed elements are never inside the page area are
 * listed in OUTSIDE_THE_PAGE_AREA with the reason.
 */

const srcDir = fileURLToPath(new URL(".", import.meta.url));

/** Files whose fixed elements are drawn outside the page area, and why. */
const OUTSIDE_THE_PAGE_AREA: Record<string, string> = {
  "components/ClippyLauncher.tsx": "drawn by Layout, beside the page area",
  "components/ClippyWindow.tsx": "drawn by Layout, beside the page area",
  "components/MobileBottomNav.tsx": "drawn by Layout, beside the page area",
  "components/ToastViewport.tsx": "drawn by Layout, beside the page area",
  "components/ui/dialog.tsx": "its overlay is only drawn inside DialogContent's portal",
  "components/ui/sheet.tsx": "its overlay is only drawn inside SheetContent's portal",
  "plugins/launchers.tsx": "drawn by PluginLauncherProvider, around the whole app",
  "pages/Auth.tsx": "the sign-in page, which is drawn without Layout",
};

/**
 * Whether a string holds `fixed` as a class of its own. A plain string has to
 * hold other classes too, so a lone "fixed" (a style value, a setting's name)
 * is not taken for one; part of a template is building a list anyway.
 */
function holdsFixedClass(text: string, partOfTemplate = false): boolean {
  const classes = text.trim().split(/\s+/);
  return (partOfTemplate || classes.length > 1) && classes.includes("fixed");
}

/** Where in a file things are drawn through PageFloating or a portal, as [start, end) offsets. */
function floatingRanges(sourceFile: ts.SourceFile): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node)) {
      const tag = node.openingElement.tagName.getText(sourceFile);
      if (tag === "PageFloating" || /Portal$/.test(tag)) ranges.push([node.getStart(sourceFile), node.end]);
    } else if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === "createPortal") {
      ranges.push([node.getStart(sourceFile), node.end]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return ranges;
}

/** The lines of a file with a class list holding `fixed` that is not drawn through PageFloating or a portal. */
function fixedInPlace(fileName: string, source: string): number[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const ranges = floatingRanges(sourceFile);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    const templatePart = ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || templatePart) &&
      holdsFixedClass(node.text, templatePart)
    ) {
      const at = node.getStart(sourceFile);
      if (!ranges.some(([start, end]) => at >= start && at < end)) {
        lines.push(sourceFile.getLineAndCharacterOfPosition(at).line + 1);
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
    if (/\.(test|spec)\.tsx?$/.test(entry.name)) return [];
    return [file];
  });
}

const files = sourceFiles(srcDir).map((file) => ({
  file,
  relative: path.relative(srcDir, file).split(path.sep).join("/"),
}));

describe("what a page fixes to the screen", () => {
  it("is drawn beside the page area, through PageFloating or a portal of its own", () => {
    const inPlace = files
      .filter(({ relative }) => !(relative in OUTSIDE_THE_PAGE_AREA))
      .flatMap(({ file, relative }) =>
        fixedInPlace(relative, readFileSync(file, "utf8")).map((line) => `${relative}:${line}`),
      );
    expect(inPlace, "wrap these in <PageFloating> (components/PageFloatingLayer)").toEqual([]);
  });

  it("is found however its classes are written, and left alone once it is drawn elsewhere", () => {
    const page = [
      'const a = <div className="fixed bottom-6 z-30" />;',
      'const b = <div className={cn("fixed bottom-4 flex", Z_PAGE_NOTICE)} />;',
      "const c = <div className={`fixed ${offset}`} />;",
      'const d = <PageFloating><div className="fixed bottom-6" /></PageFloating>;',
      'const e = <DialogPrimitive.Portal><div className="fixed inset-0" /></DialogPrimitive.Portal>;',
      'const f = createPortal(<div className="fixed z-[9999]" />, document.body);',
      'textarea.style.position = "fixed";',
      'const g = <a className="sr-only focus:fixed focus:top-3" />;',
      '// a comment saying "fixed bottom-6" is not a class',
    ].join("\n");
    expect(fixedInPlace("page.tsx", page)).toEqual([1, 2, 3]);
  });

  it("lists no file outside the page area that has nothing fixed in it any more", () => {
    const fixedAnywhere = (source: string, fileName: string) => {
      const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      let found = false;
      const visit = (node: ts.Node) => {
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && holdsFixedClass(node.text)) {
          found = true;
        }
        if (!found) ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      return found;
    };
    const stale = Object.keys(OUTSIDE_THE_PAGE_AREA).filter((relative) => {
      const entry = files.find((candidate) => candidate.relative === relative);
      return !entry || !fixedAnywhere(readFileSync(entry.file, "utf8"), relative);
    });
    expect(stale).toEqual([]);
  });
});
