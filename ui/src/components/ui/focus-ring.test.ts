import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The focus ring has to be strong enough to see.
 *
 * WCAG 1.4.11 asks anything you have to find in order to use the page to stand
 * out from what is behind it by at least 3 to 1. The ring used to be drawn at
 * half strength (`ring-ring/50`), which on this app's dark surfaces measured
 * 2.36 to 1 against the page, 2.29 against a card and 1.98 against the accent
 * shade: below the line everywhere it appears. Drawn at full strength the same
 * grey measures 5.70, 5.04 and 3.63.
 *
 * This test works from the real token values in index.css, so it also fails if
 * someone lightens a background or dims --ring later.
 *
 * Known and deliberately not covered: in the light theme --ring is
 * oklch(0.708 0 0), which is only 2.58 to 1 against white even at full
 * strength. Fixing that means moving the token itself, which also moves every
 * border that reads from it, so it is a separate decision from this one.
 */

const cssPath = fileURLToPath(new URL("../../index.css", import.meta.url));
const css = readFileSync(cssPath, "utf8");

/** The `.dark { ... }` block that holds this app's real dark palette. */
function darkThemeBlock(): string {
  const start = css.indexOf(".dark {");
  expect(start, "expected index.css to have a .dark block").toBeGreaterThan(-1);
  const end = css.indexOf("\n}", start);
  return css.slice(start, end);
}

function darkToken(name: string): string {
  const match = new RegExp(`${name}:\\s*(oklch\\([^)]*\\))`).exec(darkThemeBlock());
  expect(match, `expected ${name} in the .dark block of index.css`).not.toBeNull();
  return match![1]!;
}

/** oklch(L C H) to sRGB, each channel 0 to 255. */
function oklchToRgb(value: string): [number, number, number] {
  const parts = /oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)/.exec(value);
  expect(parts, `could not read ${value}`).not.toBeNull();
  const rawL = parts![1]!;
  const lightness = rawL.endsWith("%") ? Number.parseFloat(rawL) / 100 : Number.parseFloat(rawL);
  const chroma = Number.parseFloat(parts![2]!);
  const hue = (Number.parseFloat(parts![3]!) * Math.PI) / 180;

  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);

  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];

  return linear.map((channel) => {
    const clamped = Math.min(1, Math.max(0, channel));
    const encoded = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255);
  }) as [number, number, number];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (raw: number) => {
    const v = raw / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** What a colour drawn at `alpha` looks like once it is over `behind`. */
function flatten(
  colour: [number, number, number],
  alpha: number,
  behind: [number, number, number],
): [number, number, number] {
  return colour.map((channel, index) =>
    Math.round(channel * alpha + behind[index]! * (1 - alpha)),
  ) as [number, number, number];
}

/** Every surface a focus ring can end up being drawn on top of. */
const SURFACE_TOKENS = ["--background", "--card", "--sidebar", "--muted", "--accent"];

describe("focus ring contrast on the dark theme", () => {
  const ring = oklchToRgb(darkToken("--ring"));

  it.each(SURFACE_TOKENS)("stands out at least 3 to 1 against %s", (token) => {
    const surface = oklchToRgb(darkToken(token));
    expect(contrast(ring, surface)).toBeGreaterThanOrEqual(3);
  });

  it("would not have stood out at the half strength it used to be drawn at", () => {
    // The reason the change was made, kept here so the numbers are not just a
    // claim in a commit message.
    const page = oklchToRgb(darkToken("--background"));
    expect(contrast(flatten(ring, 0.5, page), page)).toBeLessThan(3);
  });
});

describe("the shared controls draw the ring at full strength", () => {
  const primitives = [
    "button.tsx",
    "badge.tsx",
    "checkbox.tsx",
    "input.tsx",
    "select.tsx",
    "tabs.tsx",
    "textarea.tsx",
    "scroll-area.tsx",
  ];

  it.each(primitives)("%s does not fade its focus ring", (file) => {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    expect(source).toContain("focus-visible:ring-ring");
    // `ring-ring/50` and the like: an alpha suffix here drops the ring back
    // under 3 to 1, which is the whole point of the test above.
    expect(source).not.toMatch(/ring-ring\/\d/);
  });
});
