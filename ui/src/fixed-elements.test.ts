import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Nothing a page fixes to the screen is drawn inside the page area, and a bar
 * a page pins along the bottom rests on the phone bottom bar.
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
 *
 * A bar pinned along the bottom (one that takes usePageBottomBarRef) has a
 * second rule. On a phone the agent Save bar, pinned at `bottom-0`, sat under
 * the bottom bar, which is drawn later on the same layer, so Save could not be
 * pressed; the selection bars, at `bottom-6`, sat over it instead. Such a bar
 * is placed with PAGE_BOTTOM_BAR_FLUSH_CLASS or PAGE_BOTTOM_BAR_FLOATING_CLASS
 * (lib/narrow-layout), or with a bottom offset of its own that adds the room
 * Layout publishes for the bottom bar, `--mobile-bottom-nav-room`. A bar flush
 * with the edge also pads its contents above the safe area once the bottom bar
 * has slid away (pageBottomBarFlushPadding), or an iPhone's home bar sits on
 * its buttons.
 *
 * And nothing else fixed to the screen sits low enough to cover the phone
 * bottom bar: the toasts at `bottom-3` lay over all of it, from the highest
 * layer there is, and the Email page's notices at `bottom-4` over its last
 * buttons. A fixed class list may only name a bottom offset that knows about
 * the bars along the bottom; the rest take theirs from lib/narrow-layout.
 *
 * Last, a bar the page scrolls under (fixed or sticky) is solid: at 85 to 95
 * per cent the page showed through the phone's top bar as it scrolled.
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

/** Files that fix something at a plain bottom offset, and why that is right there. */
const PLAIN_BOTTOM_OFFSET: Record<string, string> = {
  "components/MobileBottomNav.tsx": "the phone bottom bar itself, at the foot of the window",
};

/**
 * The lines of a file with a class list that holds `fixed` and a bottom
 * offset for a phone (no `md:` or other variant in front) that does not know
 * about the bars along the bottom: it names neither the phone bottom bar's
 * room nor the room the bars along the bottom take.
 */
function fixedAtPlainBottom(fileName: string, source: string): number[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    const templatePart = ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || templatePart) &&
      holdsFixedClass(node.text, templatePart)
    ) {
      const plain = node.text
        .trim()
        .split(/\s+/)
        .filter((name) => name.startsWith("bottom-"))
        .filter((name) => !/--(mobile-bottom-nav-room|page-bottom-bar-room)\b/.test(name));
      if (plain.length > 0) lines.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return lines;
}

/**
 * Files with a bar registered along the bottom that does not rest on the
 * phone bottom bar, and why. None today: the phone bottom bar itself tells
 * lib/page-bottom-bar about itself another way (setPhoneBottomBar), and the
 * issue reply box no longer registers, since it sticks inside its own section
 * rather than to the window.
 */
const NOT_ON_THE_BOTTOM_BAR: Record<string, string> = {};

/** What a bar's class list names to rest on the phone bottom bar. */
const RESTS_ON_THE_BOTTOM_BAR = ["PAGE_BOTTOM_BAR_FLUSH_CLASS", "PAGE_BOTTOM_BAR_FLOATING_CLASS", "--mobile-bottom-nav-room"];

/**
 * The bars a file registers along the bottom: each element given a ref made
 * by usePageBottomBarRef, with its line and whether its class list rests on
 * the phone bottom bar. A ref no element in the file takes is reported with
 * line 0, so a bar this cannot read is never passed over in silence.
 */
function bottomBars(fileName: string, source: string): Array<{ line: number; restsOnBottomBar: boolean }> {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const refs = new Set<string>();
  const findRefs = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText(sourceFile) === "usePageBottomBarRef"
    ) {
      refs.add(node.name.text);
    }
    ts.forEachChild(node, findRefs);
  };
  findRefs(sourceFile);

  const bars: Array<{ line: number; restsOnBottomBar: boolean }> = [];
  const used = new Set<string>();
  const findBars = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attribute = (name: string) =>
        node.attributes.properties.find(
          (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText(sourceFile) === name,
        );
      const ref = attribute("ref")?.initializer;
      const refName =
        ref && ts.isJsxExpression(ref) && ref.expression && ts.isIdentifier(ref.expression) ? ref.expression.text : null;
      if (refName && refs.has(refName)) {
        used.add(refName);
        const classList = attribute("className")?.initializer?.getText(sourceFile) ?? "";
        bars.push({
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          restsOnBottomBar: RESTS_ON_THE_BOTTOM_BAR.some((name) => classList.includes(name)),
        });
      }
    }
    ts.forEachChild(node, findBars);
  };
  findBars(sourceFile);
  for (const ref of refs) {
    if (!used.has(ref)) bars.push({ line: 0, restsOnBottomBar: false });
  }
  return bars;
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

describe("a bar a page pins along the bottom", () => {
  const registered = files.flatMap(({ file, relative }) =>
    bottomBars(relative, readFileSync(file, "utf8")).map((bar) => ({ ...bar, relative })),
  );

  it("rests on the phone bottom bar rather than under or over it", () => {
    const offending = registered
      .filter(({ relative, restsOnBottomBar }) => !restsOnBottomBar && !(relative in NOT_ON_THE_BOTTOM_BAR))
      .map(({ relative, line }) => `${relative}:${line}`);
    expect(offending, "place these with PAGE_BOTTOM_BAR_FLUSH_CLASS or PAGE_BOTTOM_BAR_FLOATING_CLASS").toEqual([]);
  });

  it("is found for every bar the app registers", () => {
    // The agent Save bars (desktop and phone), four selection bars and the
    // pipeline stage's unsaved changes bar. Fewer would mean the check
    // stopped reading some of them.
    expect(registered.length).toBeGreaterThanOrEqual(7);
    expect(registered.filter(({ line }) => line === 0)).toEqual([]);
  });

  it("keeps its contents above the safe area once the phone bottom bar has gone, when it runs along the edge", () => {
    // The pipeline stage's unsaved changes bar had no such padding, so an
    // iPhone's home bar sat on its Save button with the bottom bar away.
    const unpadded = files
      .filter(({ relative }) => relative !== "lib/narrow-layout.ts")
      .filter(({ file, relative }) => {
        const sourceFile = ts.createSourceFile(relative, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        let placedFlush = false;
        let padded = false;
        const visit = (node: ts.Node) => {
          if (ts.isIdentifier(node) && node.text === "PAGE_BOTTOM_BAR_FLUSH_CLASS" && !ts.isImportSpecifier(node.parent)) {
            placedFlush = true;
          }
          if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === "pageBottomBarFlushPadding") padded = true;
          ts.forEachChild(node, visit);
        };
        visit(sourceFile);
        return placedFlush && !padded;
      })
      .map(({ relative }) => relative);
    expect(unpadded, "pad the bar's contents with pageBottomBarFlushPadding").toEqual([]);
  });

  it("is told apart however its classes are written", () => {
    const page = [
      "const barRef = usePageBottomBarRef<HTMLDivElement>();",
      'const a = <div ref={barRef} className="fixed bottom-0 z-30" />;',
      'const b = <div ref={barRef} className={cn("fixed inset-x-0", PAGE_BOTTOM_BAR_FLUSH_CLASS)} />;',
      'const c = <div ref={barRef} className={cn("fixed flex", PAGE_BOTTOM_BAR_FLOATING_CLASS, Z_PAGE_FLOATING)} />;',
      'const d = <div ref={barRef} className="sticky bottom-[calc(max(var(--mobile-bottom-nav-room,0px),env(safe-area-inset-bottom))+20px)]" />;',
      'const e = <div ref={otherRef} className="fixed bottom-6" />;',
    ].join("\n");
    expect(bottomBars("page.tsx", page)).toEqual([
      { line: 2, restsOnBottomBar: false },
      { line: 3, restsOnBottomBar: true },
      { line: 4, restsOnBottomBar: true },
      { line: 5, restsOnBottomBar: true },
    ]);
    // A ref no element takes is reported rather than passed over.
    expect(bottomBars("page.tsx", "const lostRef = usePageBottomBarRef();")).toEqual([
      { line: 0, restsOnBottomBar: false },
    ]);
  });

  it("lists no file outside the rule that has no such bar any more", () => {
    const stale = Object.keys(NOT_ON_THE_BOTTOM_BAR).filter(
      (relative) => !registered.some((bar) => bar.relative === relative),
    );
    expect(stale).toEqual([]);
  });
});

describe("what floats along the bottom of a phone", () => {
  const plain = files.flatMap(({ file, relative }) =>
    fixedAtPlainBottom(relative, readFileSync(file, "utf8")).map((line) => ({ relative, line })),
  );

  it("stays clear of the bottom bar, taking its offset from lib/narrow-layout", () => {
    const offending = plain
      .filter(({ relative }) => !(relative in PLAIN_BOTTOM_OFFSET))
      .map(({ relative, line }) => `${relative}:${line}`);
    expect(offending, "use ABOVE_MOBILE_BOTTOM_NAV_CLASS, or the page bottom bar classes, for the bottom").toEqual([]);
  });

  it("is told apart however its classes are written", () => {
    const page = [
      'const a = <div className="fixed bottom-4 flex" />;',
      'const b = <div className={cn("pointer-events-none fixed inset-x-3 bottom-3 max-w-sm", Z_TOAST)} />;',
      'const c = <div className={cn("fixed flex", ABOVE_MOBILE_BOTTOM_NAV_CLASS)} />;',
      'const d = <div className="fixed inset-x-0 bottom-[var(--mobile-bottom-nav-room,0px)]" />;',
      'const e = <div className="fixed md:bottom-4 top-4" />;',
      'const f = <div className="sticky bottom-0" />;',
    ].join("\n");
    expect(fixedAtPlainBottom("page.tsx", page)).toEqual([1, 2]);
  });

  it("lists no file outside the rule that has no such element any more", () => {
    const stale = Object.keys(PLAIN_BOTTOM_OFFSET).filter(
      (relative) => !plain.some((entry) => entry.relative === relative),
    );
    expect(stale).toEqual([]);
  });
});

/**
 * The lines of a file with a class list for a bar the page scrolls under
 * (fixed or sticky, at any width) whose background lets the page show
 * through: `bg-background/90`, `bg-muted/50` and the like, or a backdrop blur,
 * which is only there to soften what shows through. A dimmed layer over the
 * whole window (`inset-0`, behind a dialog) is meant to be seen through and
 * is left out, as is a colour that only shows on hover or focus.
 */
function seeThroughBars(fileName: string, source: string): number[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const classes = node.text.trim().split(/\s+/);
      const bar = classes.some((name) => /^(?:[\w-]+:)*(?:fixed|sticky)$/.test(name));
      const overWholeWindow = classes.some((name) => /^(?:[\w-]+:)*inset-0$/.test(name));
      const seeThrough = classes.some((name) => {
        const variants = name.split(":").slice(0, -1);
        if (variants.some((variant) => /^(?:hover|focus|focus-visible|active|group-hover|peer-hover)$/.test(variant))) return false;
        const utility = name.split(":").at(-1)!;
        return /^bg-[\w-]+\/\d+$/.test(utility) || /^backdrop-blur/.test(utility);
      });
      if (bar && !overWholeWindow && seeThrough) {
        lines.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return lines;
}

/**
 * A page's own short notice in the corner, on the page notice layer
 * (Z_PAGE_NOTICE): the line of each class list that places one, and whether
 * it is placed with PAGE_CORNER_NOTICE_CLASS.
 */
function cornerNotices(fileName: string, source: string): Array<{ line: number; placed: boolean }> {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const notices: Array<{ line: number; placed: boolean }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(sourceFile) === "className" && node.initializer) {
      const classList = node.initializer.getText(sourceFile);
      if (/\bZ_PAGE_NOTICE\b/.test(classList)) {
        notices.push({
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          placed: /\bPAGE_CORNER_NOTICE_CLASS\b/.test(classList),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return notices;
}

describe("a page's own notice in the corner", () => {
  const notices = files.flatMap(({ file, relative }) =>
    cornerNotices(relative, readFileSync(file, "utf8")).map((notice) => ({ ...notice, relative })),
  );

  it("sits beside the launcher on a phone rather than in its place", () => {
    // In the launcher's own place, the Email pages' "Archived" lay over the
    // round launcher for the seconds it showed.
    const misplaced = notices.filter((notice) => !notice.placed).map(({ relative, line }) => `${relative}:${line}`);
    expect(misplaced, "place these with PAGE_CORNER_NOTICE_CLASS").toEqual([]);
  });

  it("is found on each page that has one", () => {
    // Email, Portfolio email and the Help Scout mailbox.
    expect(notices.length).toBeGreaterThanOrEqual(3);
  });

  it("is told apart however its classes are written", () => {
    const page = [
      'const a = <div className={cn("fixed flex", ABOVE_MOBILE_BOTTOM_NAV_CLASS, PAGE_CORNER_RIGHT_CLASS, Z_PAGE_NOTICE)} />;',
      'const b = <div className={cn("fixed flex", PAGE_CORNER_NOTICE_CLASS, Z_PAGE_NOTICE)} />;',
      'const c = <div className="fixed bottom-4" />;',
    ].join("\n");
    expect(cornerNotices("page.tsx", page)).toEqual([
      { line: 1, placed: false },
      { line: 2, placed: true },
    ]);
  });
});

/** Sticky or fixed and see-through on purpose, by file, with the reason. */
const SEE_THROUGH_ON_PURPOSE: Record<string, string> = {
  "pages/PipelineSettings.tsx": "the list of a stage's sections sits beside the form, so nothing scrolls under it",
};

describe("a bar the page scrolls under", () => {
  it("is solid, so the page does not show through it", () => {
    // At 85 to 95 per cent the page showed through the phone's top bar, the
    // bottom bar and the agent Save bar as it scrolled, and at half strength
    // through the day headings in the Clippy session list.
    const offending = files
      .filter(({ relative }) => !(relative in SEE_THROUGH_ON_PURPOSE))
      .flatMap(({ file, relative }) =>
        seeThroughBars(relative, readFileSync(file, "utf8")).map((line) => `${relative}:${line}`),
      );
    expect(offending, "give the bar a solid background, such as bg-background").toEqual([]);
  });

  it("lists no file as see-through on purpose that has no such bar any more", () => {
    const stale = Object.keys(SEE_THROUGH_ON_PURPOSE).filter((relative) => {
      const file = files.find((entry) => entry.relative === relative);
      return !file || seeThroughBars(relative, readFileSync(file.file, "utf8")).length === 0;
    });
    expect(stale).toEqual([]);
  });

  it("is told apart however its classes are written", () => {
    const page = [
      'const a = <div className="sticky top-0 z-20 bg-background/95 backdrop-blur" />;',
      'const b = <div className="md:sticky md:top-0 md:bg-background/95" />;',
      'const c = <div className="fixed inset-x-0 bg-background border-t" />;',
      'const d = <div className="rounded-md bg-background/60 px-2" />;',
      'const e = <div className="sticky top-0 bg-muted/50 px-3" />;',
      'const f = <div className="fixed bottom-0 bg-background backdrop-blur-sm" />;',
      'const g = <div className="fixed inset-0 z-50 bg-black/50" />;',
      'const h = <div className="sticky top-0 bg-background hover:bg-accent/50" />;',
    ].join("\n");
    expect(seeThroughBars("page.tsx", page)).toEqual([1, 2, 5, 6]);
  });
});
