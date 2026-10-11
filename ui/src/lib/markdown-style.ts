import type { ToMarkdownOptions } from "@mdxeditor/editor";

const FRONT_MATTER_OPEN = /^---[ \t]*$/;
const FRONT_MATTER_CLOSE = /^(?:---|\.\.\.)[ \t]*$/;
const BLOCKQUOTE_PREFIX = /^(?: {0,3}>[ \t]?)+/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const SETEXT_H1_UNDERLINE = /^ {0,3}=+[ \t]*$/;
const SETEXT_H2_UNDERLINE = /^ {0,3}-+[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
const BULLET_ITEM = /^([ \t]*)([-*+])( +|\t)\S/;
const ORDERED_ITEM = /^([ \t]*)(\d{1,9})([.)])( +|\t)\S/;

const STRONG_MARKERS = [
  { marker: "_", pattern: /(?<![\p{L}\p{N}_\\])__(?![\s_])(?:[^\n]*?[^\s_\\])?__(?![\p{L}\p{N}_])/u },
  { marker: "*", pattern: /(?<![*\\])\*\*(?![\s*])(?:[^\n]*?[^\s*\\])?\*\*(?!\*)/ },
] as const;

const EMPHASIS_MARKERS = [
  { marker: "_", pattern: /(?<![\p{L}\p{N}_\\])_(?![\s_])(?:[^_\n]*?[^\s_\\])?_(?![\p{L}\p{N}_])/u },
  { marker: "*", pattern: /(?<![*\\])\*(?![\s*])(?:[^*\n]*?[^\s*\\])?\*(?!\*)/ },
] as const;

/** The lines after a leading YAML front matter block, which is not markdown. */
function bodyLines(markdown: string): string[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  if (!FRONT_MATTER_OPEN.test(lines[0] ?? "")) return lines;
  const close = lines.findIndex((line, index) => index > 0 && FRONT_MATTER_CLOSE.test(line));
  return close > 0 ? lines.slice(close + 1) : lines;
}

function firstMarker<T extends string>(
  text: string,
  candidates: ReadonlyArray<{ marker: T; pattern: RegExp }>,
): T | undefined {
  let found: { marker: T; index: number } | undefined;
  for (const { marker, pattern } of candidates) {
    const index = pattern.exec(text)?.index;
    if (index !== undefined && (!found || index < found.index)) found = { marker, index };
  }
  return found?.marker;
}

/**
 * The rich editor writes markdown back out in one fixed style ("*" bullets,
 * "*" emphasis, "***" rules, backtick fences and so on), whatever the person
 * wrote. These options make it write the markers the markdown already uses
 * instead, so saving an edit keeps the person's own style. Each marker comes
 * from its first use. Anything the markdown does not use keeps the editor's
 * own default.
 */
export function markdownStyleOptions(markdown: string): ToMarkdownOptions {
  const options: ToMarkdownOptions = { listItemIndent: "one" };
  const prose: string[] = [];
  let listIndentKnown = false;
  // The first numbered list, until its second item says whether the numbers count up.
  let numberedList: { indent: number; number: number } | "known" | null = null;
  // The line that ends the fenced code block the scan is in, if it is in one.
  let fenceClose: RegExp | null = null;
  let previousIsText = false;

  for (const rawLine of bodyLines(markdown)) {
    const line = rawLine.replace(BLOCKQUOTE_PREFIX, "");
    if (fenceClose) {
      if (fenceClose.test(line)) fenceClose = null;
      continue;
    }
    const afterText = previousIsText;
    previousIsText = false;
    if (line.trim() === "") continue;

    const bullet = BULLET_ITEM.exec(line);
    const ordered = ORDERED_ITEM.exec(line);
    if (numberedList && numberedList !== "known") {
      const indent = (ordered ?? /^([ \t]*)/.exec(line)!)[1]!.length;
      if (ordered && indent === numberedList.indent) {
        if (Number(ordered[2]) === numberedList.number) options.incrementListMarker = false;
        numberedList = "known";
      } else if (indent <= numberedList.indent) {
        numberedList = "known";
      }
    }

    const fenceOpen = FENCE_OPEN.exec(line);
    if (fenceOpen) {
      const fence = fenceOpen[1]!;
      fenceClose = new RegExp(`^ {0,3}\\${fence[0]}{${fence.length},}[ \\t]*$`);
      options.fence ??= fence[0] as "`" | "~";
      continue;
    }
    if (afterText && SETEXT_H1_UNDERLINE.test(line)) {
      options.setext ??= true;
      continue;
    }
    // Under a line of text this is a heading underline, not a rule.
    if (afterText && SETEXT_H2_UNDERLINE.test(line)) continue;
    const rule = THEMATIC_BREAK.exec(line);
    if (rule) {
      if (!options.rule) {
        const markers = line.trim();
        options.rule = rule[1] as "*" | "-" | "_";
        options.ruleRepetition = markers.replace(/[ \t]/g, "").length;
        options.ruleSpaces = /[ \t]/.test(markers);
      }
      continue;
    }
    const heading = ATX_HEADING.exec(line);
    if (heading) {
      if (heading[1]!.length <= 2) options.setext ??= false;
      // "# Title #" closes the heading with its own hashes.
      options.closeAtx ??= /[ \t]#+[ \t]*$/.test(line);
    }

    const item = bullet ?? ordered;
    if (bullet) options.bullet ??= bullet[2] as "*" | "+" | "-";
    if (ordered) {
      options.bulletOrdered ??= ordered[3] as "." | ")";
      numberedList ??= { indent: ordered[1]!.length, number: Number(ordered[2]) };
    }
    if (item && !listIndentKnown) {
      // "-   item" lines the text up four columns in, which the editor calls "tab".
      const marker = bullet ? bullet[2]! : `${ordered![2]}${ordered![3]}`;
      const space = item[item.length - 1]!;
      if (space.length > 1 && marker.length + space.length === Math.ceil((marker.length + 1) / 4) * 4) {
        options.listItemIndent = "tab";
      }
      listIndentKnown = true;
    }
    prose.push(line);
    previousIsText = !heading && !item;
  }

  // Code, links and addresses can hold "*" and "_" that are not emphasis.
  const text = prose
    .join("\n")
    .replace(/(`+)[^`]*?\1/g, "x")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/<[^>\s]+>/g, "x")
    .replace(/\bhttps?:\/\/\S+/g, "x");
  const strong = firstMarker(text, STRONG_MARKERS);
  if (strong) options.strong = strong;
  const emphasis = firstMarker(text, EMPHASIS_MARKERS);
  if (emphasis) options.emphasis = emphasis;
  return options;
}
