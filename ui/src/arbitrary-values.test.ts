import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Tailwind arbitrary values the browser keeps.
 *
 * Tailwind writes an arbitrary value out as it stands, underscores turned into
 * spaces and nothing else, so `grid-cols-[1.3fr,1fr]` becomes
 * `grid-template-columns: 1.3fr,1fr`. That is not a value grid-template-columns
 * takes, and the browser drops the whole declaration without a warning: the
 * three two-column rows on the Costs page stacked at every width from the day
 * they were written. Columns are separated with underscores.
 *
 * So this reads the source files and stylesheets under src for arbitrary
 * values with a comma outside any brackets or quotes, and allows one only
 * where the CSS value is a list (LIST_UTILITIES). A `bg-[...]` list is a list
 * of background images, and a colour is not an image, so
 * `bg-[linear-gradient(...),var(--background)]` lost the gradient and the
 * colour together; every layer there has to be an image, and a colour goes in
 * a `bg-` class of its own.
 */

const srcDir = fileURLToPath(new URL(".", import.meta.url));

/**
 * Utilities whose CSS value is a comma separated list, so a comma between
 * items is right: transition-property, the shadows, font-family,
 * font-feature-settings, animation, will-change, mask-image and cursor. `bg`
 * is a list of images, checked layer by layer.
 */
const LIST_UTILITIES = new Set([
  "transition",
  "shadow",
  "inset-shadow",
  "drop-shadow",
  "text-shadow",
  "font",
  "font-features",
  "animate",
  "will-change",
  "mask",
  "cursor",
]);

/** A layer a background-image list can hold. */
const IMAGE_LAYER = /^(?:(?:repeating-)?(?:linear|radial|conic)-gradient|url|image-set|image)\(|^none$/;

/** Splits a value at the commas outside brackets and quotes. */
function topLevelItems(value: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "(" || character === "[") {
      depth += 1;
    } else if (character === ")" || character === "]") {
      depth -= 1;
    } else if (character === "," && depth === 0) {
      items.push(value.slice(start, index));
      start = index + 1;
    }
  }
  items.push(value.slice(start));
  return items;
}

/**
 * The arbitrary values in a piece of text that the browser would drop because
 * of a comma, as the class that holds each: `@4xl:grid-cols-[1.3fr,1fr]`.
 */
function droppedValues(text: string): string[] {
  const dropped: string[] = [];
  // A utility name, after any variants, then the bracketed value.
  const opening = /([@!\w:./-]*?)([a-z][a-z0-9]*(?:-[a-z0-9]+)*)-\[/g;
  for (let match = opening.exec(text); match; match = opening.exec(text)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let end = start;
    for (; end < text.length && depth > 0; end += 1) {
      if (text[end] === "[") depth += 1;
      else if (text[end] === "]") depth -= 1;
    }
    const value = text.slice(start, end - 1);
    // A class has no spaces; this was something else in brackets.
    if (/\s/.test(value)) continue;
    const items = topLevelItems(value);
    if (items.length < 2) continue;
    const utility = match[2]!.replace(/^-/, "");
    if (LIST_UTILITIES.has(utility)) continue;
    // A type hint other than an image, `bg-[position:...]`, is a list of its own kind.
    if (utility === "bg" && /^[a-z-]+:/.test(value) && !value.startsWith("image:")) continue;
    if (utility === "bg" && items.every((item) => IMAGE_LAYER.test(item.replace(/^image:/, "")))) continue;
    dropped.push(`${match[1]}${match[2]}-[${value}]`);
  }
  return dropped;
}

function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    if (!/\.(css|[cm]?[jt]sx?)$/.test(entry.name)) return [];
    // Tests are not shipped, and this one names dropped values on purpose.
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) return [];
    return [file];
  });
}

describe("Tailwind arbitrary values", () => {
  it("never hold a comma the browser drops the whole value for", () => {
    const dropped = sourceFiles(srcDir).flatMap((file) => {
      const relative = path.relative(srcDir, file).split(path.sep).join("/");
      const source = readFileSync(file, "utf8");
      const text = file.endsWith(".css") ? withoutComments(source) : source;
      return text
        .split(/\r?\n/)
        .flatMap((line, index) => droppedValues(line).map((value) => `${relative}:${index + 1} ${value}`));
    });
    expect(dropped, "separate grid columns with underscores, and give a bg colour its own class").toEqual([]);
  });

  it("are read the way the browser reads them", () => {
    // The three Costs rows as they were, and as they are now.
    expect(droppedValues('<div className="grid gap-4 @4xl:grid-cols-[1.3fr,1fr]">')).toEqual([
      "@4xl:grid-cols-[1.3fr,1fr]",
    ]);
    expect(droppedValues('"grid @4xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]"')).toEqual([]);
    // Any other utility that takes one value.
    expect(droppedValues("w-[10px,20px] md:grid-rows-[auto,1fr]")).toEqual(["w-[10px,20px]", "md:grid-rows-[auto,1fr]"]);
    // Lists, and commas inside a function or a string.
    expect(
      droppedValues(
        "transition-[width,opacity] shadow-[0_1px_rgba(0,0,0,0.1),0_0_0_1px_red] grid-cols-[repeat(14,minmax(0,1fr))] content-['a,b']",
      ),
    ).toEqual([]);
    // A background list holds images only.
    expect(droppedValues("bg-[radial-gradient(circle,red,blue),linear-gradient(red,blue)]")).toEqual([]);
    expect(droppedValues("bg-[linear-gradient(180deg,red,transparent_30%),var(--background)]")).toEqual([
      "bg-[linear-gradient(180deg,red,transparent_30%),var(--background)]",
    ]);
    // Brackets that are not a class.
    expect(droppedValues("const pair: Array<[string, number]> = items-[a, b];")).toEqual([]);
  });
});
