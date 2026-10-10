import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every CSS variable the app names has to be defined somewhere.
 *
 * Tailwind's `(--name)` shorthand, as in `grid-cols-(--gtc-45)` or
 * `text-(length:--text-micro)`, compiles to `var(--name)` with no fallback, and
 * so does a plain `var(--name)` in an inline style or a stylesheet. When nothing
 * defines the variable, the browser ignores that style without any warning: a
 * grid collapses to one column, a width falls back to auto, small text takes
 * whatever size it inherits. That is how the October 2026 port from upstream
 * (PR #12) brought in 53 such names without the stylesheet block that defines
 * them.
 *
 * So this reads the source files and stylesheets under src and checks each name
 * used that way against the variables declared in src's CSS and in Tailwind's
 * own theme, which index.css imports. `var(--name, fallback)` is left alone,
 * because the fallback is there for exactly this case. Variables that are set
 * on purpose while the app runs, rather than in a stylesheet, are listed in
 * RUNTIME_VARIABLES with where they are set.
 */

const srcDir = fileURLToPath(new URL(".", import.meta.url));

/** Set on elements while the app runs, so no stylesheet defines them. */
const RUNTIME_VARIABLES: Record<string, string> = {
  // Radix sets these on the content element of each primitive, from the
  // position it measured (radix-ui, used through components/ui).
  "--radix-dropdown-menu-content-available-height": "Radix DropdownMenu content",
  "--radix-dropdown-menu-content-transform-origin": "Radix DropdownMenu content",
  "--radix-hover-card-content-transform-origin": "Radix HoverCard content",
  "--radix-popover-content-transform-origin": "Radix Popover content",
  "--radix-popover-trigger-width": "Radix Popover content",
  "--radix-select-content-available-height": "Radix Select content",
  "--radix-select-content-transform-origin": "Radix Select content",
  "--radix-select-trigger-height": "Radix Select content",
  "--radix-select-trigger-width": "Radix Select content",
  "--radix-tooltip-content-transform-origin": "Radix Tooltip content",
  // The icon an agent mention chip shows, read by index.css.
  "--paperclip-mention-icon-mask": "lib/mention-chips.ts, on each agent mention chip",
};

/** Names used as `utility-(--name)`, `utility-(type:--name)` or `var(--name)`. */
function variableUses(text: string): string[] {
  return [...text.matchAll(/-\((?:[a-z-]+:)?(--[\w-]+)\)|\bvar\((--[\w-]+)\)/g)].map(
    (match) => (match[1] ?? match[2])!,
  );
}

function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * The `--name:` declarations in a stylesheet. Ones inside @media, @supports or
 * @container do not count: they only hold under that condition, the way the
 * touch-device rule in index.css resets the small text sizes on form fields.
 */
function declaredVariables(css: string): Set<string> {
  let text = withoutComments(css);
  const conditional = /@(?:media|supports|container)\b/;
  for (let start = text.search(conditional); start !== -1; start = text.search(conditional)) {
    let end = text.indexOf("{", start);
    if (end === -1) break;
    let depth = 0;
    for (; end < text.length; end += 1) {
      if (text[end] === "{") depth += 1;
      else if (text[end] === "}") depth -= 1;
      if (depth === 0) break;
    }
    text = text.slice(0, start) + text.slice(end + 1);
  }
  return new Set([...text.matchAll(/(?:^|[{;\s])(--[\w-]+)\s*:/g)].map((match) => match[1]!));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    if (!/\.(css|[cm]?[jt]sx?)$/.test(entry.name)) return [];
    // Tests are not shipped, and this one names undefined variables on purpose.
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) return [];
    return [file];
  });
}

const files = sourceFiles(srcDir);
const tailwindTheme = readFileSync(createRequire(import.meta.url).resolve("tailwindcss/theme.css"), "utf8");

const defined = declaredVariables(tailwindTheme);
for (const file of files.filter((name) => name.endsWith(".css"))) {
  for (const name of declaredVariables(readFileSync(file, "utf8"))) defined.add(name);
}

/** Each variable named under src, with the files that name it. */
const uses = new Map<string, Set<string>>();
for (const file of files) {
  const source = readFileSync(file, "utf8");
  const relative = path.relative(srcDir, file).split(path.sep).join("/");
  for (const name of variableUses(file.endsWith(".css") ? withoutComments(source) : source)) {
    if (!uses.has(name)) uses.set(name, new Set());
    uses.get(name)!.add(relative);
  }
}

describe("CSS variables the app names", () => {
  it("are all defined in src's CSS, by Tailwind's theme, or on purpose at run time", () => {
    const undefinedNames = [...uses]
      .filter(([name]) => !defined.has(name) && !(name in RUNTIME_VARIABLES))
      .map(([name, where]) => `${name} (${[...where].sort().join(", ")})`)
      .sort();
    expect(undefinedNames).toEqual([]);
  });

  it("are found in every form a class or a style can name them", () => {
    expect(
      variableUses(
        'grid-cols-(--a) text-(length:--b) bg-(color:--c)/50 style="width: var(--d)" ' +
          "pr-[var(--e,0px)] var(--f, 1rem) Enable Chrome (--chrome)",
      ),
    ).toEqual(["--a", "--b", "--c", "--d"]);
    expect([...declaredVariables(":root { --a: 1px; } @media (pointer: coarse) { input { --b: 2px; } }")]).toEqual([
      "--a",
    ]);
  });
});

describe("the run-time variable list", () => {
  it("holds nothing the app no longer names", () => {
    expect(Object.keys(RUNTIME_VARIABLES).filter((name) => !uses.has(name))).toEqual([]);
  });
});
