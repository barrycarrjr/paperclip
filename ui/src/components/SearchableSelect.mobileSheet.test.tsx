// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SearchableSelect } from "./SearchableSelect";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * On a phone, SearchableSelect opens as a sheet that fills the screen above the
 * on-screen keyboard, with a heading and a close button.
 *
 * The component does its half by marking the popup and its heading with
 * data-mobile-entity-picker attributes, and by setting
 * --mobile-entity-picker-visual-viewport-height on the popup to the height the
 * keyboard leaves visible. index.css does the rest below 40rem wide. The
 * October 2026 port from upstream (PR #12) brought the component without those
 * rules, so on a phone the picker stayed a small floating box with its heading
 * hidden. jsdom does no layout, so these tests check the hand-off: the popup
 * carries what the rules read, and every selector in the rules finds its
 * element in the open picker.
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

/** The rules that only apply on a phone and style the picker. */
function phonePickerRules() {
  return styleRules().filter(
    (rule) =>
      rule.media !== null
      && /max-width:\s*40rem/.test(rule.media)
      && rule.selector.includes("data-mobile-entity-picker"),
  );
}

let container: HTMLDivElement;
let root: Root;
const scrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // jsdom has no visualViewport. A phone with its keyboard open reports the
  // height left above the keyboard here.
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: { height: 412, addEventListener() {}, removeEventListener() {} },
  });
  // The list scrolls its selected option into view, which jsdom cannot do.
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  document.body.innerHTML = "";
  Reflect.deleteProperty(window, "visualViewport");
  Element.prototype.scrollIntoView = scrollIntoView;
});

async function openPicker() {
  act(() => {
    root.render(
      <SearchableSelect<string>
        value="brand-kit"
        groups={[
          {
            id: "skills",
            options: [
              { key: "brand-kit", value: "brand-kit", label: "Brand kit" },
              { key: "quote-replies", value: "quote-replies", label: "Quote replies" },
            ],
          },
        ]}
        onValueChange={() => {}}
        placeholder="Select skill"
        searchPlaceholder="Search skills..."
      />,
    );
  });
  const trigger = container.querySelector<HTMLButtonElement>('button[role="combobox"]');
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  const picker = document.querySelector<HTMLElement>("[data-mobile-entity-picker]");
  expect(picker, "expected the picker to open").not.toBeNull();
  return picker!;
}

describe("SearchableSelect on a phone", () => {
  it("carries the visible height and a heading with a close button on its popup", async () => {
    const picker = await openPicker();

    expect(picker.style.getPropertyValue("--mobile-entity-picker-visual-viewport-height")).toBe("412px");
    const heading = picker.querySelector("[data-mobile-entity-picker-header]");
    expect(heading?.textContent).toContain("Select skill");
    expect(heading?.querySelector('button[aria-label="Close selector"]')).not.toBeNull();
  });

  it("has phone rules that show the heading and size the sheet to the visible height", () => {
    const rules = phonePickerRules();

    const heading = rules.find((rule) => rule.selector === "[data-mobile-entity-picker-header]");
    expect(heading, "expected index.css to style the picker heading on phones").toBeDefined();
    expect(heading!.body).toMatch(/display:\s*flex/);
    const sheet = rules.find((rule) => rule.selector === "[data-mobile-entity-picker]");
    expect(sheet, "expected index.css to style the picker on phones").toBeDefined();
    expect(sheet!.body).toMatch(/position:\s*fixed/);
    expect(sheet!.body).toMatch(/height:[^;]*var\(--mobile-entity-picker-visual-viewport-height\)/);
  });

  it("dims the page behind the sheet with the half-strength black of every other overlay, in both themes", () => {
    // One value for both themes: upstream's mix of the text colour turned light
    // grey in dark mode, where dialogs and sheets use bg-black/50.
    const uncommented = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const values = [...uncommented.matchAll(/--mobile-entity-picker-backdrop\s*:\s*([^;]+);/g)].map((match) => match[1].trim());

    expect(values).toEqual(["rgb(0 0 0 / 0.5)"]);
  });

  it("finds an element in the open picker for every selector in the phone rules", async () => {
    await openPicker();
    const selectors = phonePickerRules().flatMap((rule) => rule.selector.split(",").map((part) => part.trim()));
    expect(selectors.length, "expected index.css to have phone rules for the picker").toBeGreaterThan(0);

    // A pseudo-element is drawn on whatever the rest of the selector matches.
    const unmatched = selectors.filter((selector) => !document.querySelector(selector.replace(/::(before|after)$/, "")));
    expect(unmatched).toEqual([]);
  });
});
