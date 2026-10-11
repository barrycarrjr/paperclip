// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HoverPreview, HoverPreviewContent, HoverPreviewTrigger } from "./HoverPreview";
import { TooltipProvider } from "./ui/tooltip";
import { CAN_HOVER_QUERY } from "../hooks/useCanHover";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A row's hover preview opens only where the pointer can hover, and is never
 * wider than the screen. On a phone the portfolio issues preview opened
 * whenever the row took focus, as a tap can give it, and ran from the left
 * edge of a 390 pixel screen to 115 pixels past the right one.
 */

/** Stands in for the device's answer to "can the pointer hover", which can change. */
function stubHover(canHover: boolean) {
  const listeners = new Set<() => void>();
  let matches = canHover;
  const original = Object.getOwnPropertyDescriptor(window, "matchMedia");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query === CAN_HOVER_QUERY ? matches : false,
      media: query,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    }),
  });
  return {
    set(next: boolean) {
      matches = next;
      for (const listener of listeners) listener();
    },
    restore() {
      if (original) Object.defineProperty(window, "matchMedia", original);
      else delete (window as { matchMedia?: unknown }).matchMedia;
    },
  };
}

describe("HoverPreview", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let device: ReturnType<typeof stubHover> | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    device?.restore();
    device = null;
  });

  function render() {
    act(() => {
      root.render(
        <TooltipProvider>
          <HoverPreview>
            <HoverPreviewTrigger>
              <div role="button" tabIndex={0}>
                Plan the enterprise onboarding release
              </div>
            </HoverPreviewTrigger>
            <HoverPreviewContent>Agree the steps, owners and dates.</HoverPreviewContent>
          </HoverPreview>
        </TooltipProvider>,
      );
    });
  }

  const row = () => container.querySelector<HTMLElement>('[role="button"]')!;
  const preview = () => document.querySelector<HTMLElement>('[data-slot="tooltip-content"]');

  function focusRow() {
    act(() => row().blur());
    act(() => row().focus());
  }

  it("opens under its row where the pointer can hover, and when the row takes focus from the keyboard", () => {
    device = stubHover(true);
    render();
    focusRow();
    expect(preview()?.textContent).toContain("Agree the steps");
  });

  it("does not open on a touch screen, where a tap on the row opens the row itself", () => {
    // A tap can give the row focus, and focus opened the preview over the list.
    device = stubHover(false);
    render();
    focusRow();
    expect(preview()).toBeNull();
  });

  it("follows the device when it changes, as when a tablet gets a mouse", () => {
    device = stubHover(false);
    render();
    focusRow();
    expect(preview()).toBeNull();
    act(() => device!.set(true));
    focusRow();
    expect(preview()?.textContent).toContain("Agree the steps");
  });

  it("is never wider than the room on screen", () => {
    device = stubHover(true);
    render();
    focusRow();
    expect(preview()!.className).toContain("max-w-[min(32rem,var(--radix-tooltip-content-available-width))]");
  });
});

// Under jsdom, `new URL(..., import.meta.url)` resolves against the test page
// rather than the disk, so the path is built from this file's own location.
const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    if (!/\.tsx$/.test(entry.name) || /\.(test|spec|stories)\.tsx$/.test(entry.name)) return [];
    return [file];
  });
}

/** Tailwind's named widths, in rem. */
const NAMED_WIDTH_REM: Record<string, number> = {
  "3xs": 16, "2xs": 18, xs: 20, sm: 24, md: 28, lg: 32, xl: 36,
  "2xl": 42, "3xl": 48, "4xl": 56, "5xl": 64, "6xl": 72, "7xl": 80,
};

/** The widest a tooltip may be without taking the room on screen into account: 20rem (`max-w-xs`). */
const WIDEST_FIXED_TOOLTIP_PX = 320;

/** How wide a width class lets an element be, in pixels, or null for anything else. */
function widthPixels(name: string): number | null {
  const utility = name.split(":").at(-1)!;
  const named = /^(?:max-w|min-w|w)-(3xs|2xs|xs|sm|md|lg|xl|[2-7]xl)$/.exec(utility);
  if (named) return NAMED_WIDTH_REM[named[1]!]! * 16;
  const scale = /^(?:max-w|min-w|w)-(\d+(?:\.\d+)?)$/.exec(utility);
  if (scale) return Number(scale[1]) * 4;
  const arbitrary = /^(?:max-w|min-w|w)-\[(\d+(?:\.\d+)?)(px|rem)\]$/.exec(utility);
  if (arbitrary) return Number(arbitrary[1]) * (arbitrary[2] === "rem" ? 16 : 1);
  return null;
}

/**
 * The lines of a file with a tooltip allowed to be wider than a phone has room
 * for: a width over 20rem that does not take the room on screen into account.
 */
function tooltipsWiderThanAPhone(fileName: string, source: string): number[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(sourceFile) === "TooltipContent") {
      const initializer = node.attributes.properties.find(
        (property): property is ts.JsxAttribute =>
          ts.isJsxAttribute(property) && property.name.getText(sourceFile) === "className",
      )?.initializer;
      const classes: string[] = [];
      const collect = (inner: ts.Node) => {
        if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) classes.push(...inner.text.trim().split(/\s+/));
        ts.forEachChild(inner, collect);
      };
      if (initializer) collect(initializer);
      const fitsTheScreen = (initializer?.getText(sourceFile) ?? "").includes("--radix-tooltip-content-available-width");
      if (!fitsTheScreen && classes.some((name) => (widthPixels(name) ?? 0) > WIDEST_FIXED_TOOLTIP_PX)) {
        lines.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return lines;
}

describe("a tooltip wider than a phone", () => {
  it("is a row's hover preview, which fits the screen and stays off touch screens", () => {
    const offending = sourceFiles(srcDir).flatMap((file) => {
      const relative = path.relative(srcDir, file).split(path.sep).join("/");
      return tooltipsWiderThanAPhone(relative, readFileSync(file, "utf8")).map((line) => `${relative}:${line}`);
    });
    expect(offending, "draw a preview this wide with HoverPreview (components/HoverPreview)").toEqual([]);
  });

  it("is told apart however its classes are written", () => {
    const page = [
      'const a = <TooltipContent side="bottom" align="start" className="max-w-lg p-3">x</TooltipContent>;',
      'const b = <TooltipContent className="max-w-[220px]">x</TooltipContent>;',
      'const c = <TooltipContent className={cn("max-w-md", tone)}>x</TooltipContent>;',
      'const d = <TooltipContent className="max-w-[min(32rem,var(--radix-tooltip-content-available-width))]">x</TooltipContent>;',
      'const e = <TooltipContent className="max-w-xs">x</TooltipContent>;',
      'const f = <PopoverContent className="w-96">x</PopoverContent>;',
      'const g = <TooltipContent className="w-[400px]" />;',
    ].join("\n");
    expect(tooltipsWiderThanAPhone("page.tsx", page)).toEqual([1, 3, 7]);
  });
});
