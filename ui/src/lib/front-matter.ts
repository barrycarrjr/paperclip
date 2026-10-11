const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const OPENING_FENCE = /^---[ \t]*$/;
const CLOSING_FENCE = /^(?:---|\.\.\.)[ \t]*$/;
const BLANK_LINE = /^[ \t]*$/;
const LINE_ENDING = /\r\n|\n|\r/;
// "name: value", or a key in quotes. Front matter starts with one; a divider
// with ordinary text under it does not.
const YAML_KEY_LINE = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*|"[^"]*"|'[^']*')[ \t]*:(?:[ \t]|$)/;
// A line that opens or closes a fenced code block, which is never front matter.
const CODE_FENCE = /^ {0,3}(?:`{3,}|~{3,})/;

/**
 * A YAML front matter block: the lines between "---" lines at the very top of
 * a markdown file, as agent instructions and skills have. It is not markdown,
 * and the rich editor writes it back broken (the first "---" as a rule, the
 * YAML as a paragraph with escapes, the closing "---" as a heading underline),
 * so it is kept out of the editor and put back exactly as written.
 *
 * The block is `open + yaml + close`, byte for byte.
 */
export interface FrontMatter {
  /** A byte order mark, if the text starts with one, and the opening "---" line. */
  open: string;
  /** The YAML between the fences, with its own line endings. */
  yaml: string;
  /** The closing "---" line and the blank lines after it. */
  close: string;
  /** The line ending the block uses, for anything added to it. */
  lineEnding: string;
}

/** Why YAML between the fences would not be read back as front matter. */
export type FrontMatterYamlProblem = "endsEarly" | "codeFence" | "noKey";

/**
 * Why this YAML, put between the fences, would not be read back as front
 * matter, or null when it would be. A line of only "---" or "..." would end the
 * block there, a code fence line is markdown, and the first line that is not
 * blank has to look like a YAML key.
 */
export function frontMatterYamlProblem(yaml: string): FrontMatterYamlProblem | null {
  const lines = yaml.split(LINE_ENDING);
  if (lines.some((line) => CLOSING_FENCE.test(line))) return "endsEarly";
  if (lines.some((line) => CODE_FENCE.test(line))) return "codeFence";
  const first = lines.find((line) => !BLANK_LINE.test(line));
  return first !== undefined && YAML_KEY_LINE.test(first) ? null : "noKey";
}

/**
 * Splits a leading front matter block off markdown, so that
 * `joinFrontMatter(split.frontMatter, split.body)` is the text again, byte for
 * byte. A block needs "---" on the first line, a closing "---" (or "...") line,
 * and YAML between them that starts with a key such as "name:". Anything else,
 * a divider with text under it or a block that is never closed, is all body.
 */
export function splitFrontMatter(markdown: string): { frontMatter: FrontMatter | null; body: string } {
  const none = { frontMatter: null, body: markdown };
  const start = markdown.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK.length : 0;
  const lineEnding = new RegExp(LINE_ENDING.source, "g");
  lineEnding.lastIndex = start;
  const opening = lineEnding.exec(markdown);
  if (!opening || !OPENING_FENCE.test(markdown.slice(start, opening.index))) return none;
  const yamlStart = opening.index + opening[0].length;

  for (let lineStart = yamlStart; ;) {
    const ending = lineEnding.exec(markdown);
    const lineEnd = ending ? ending.index : markdown.length;
    if (CLOSING_FENCE.test(markdown.slice(lineStart, lineEnd))) {
      if (frontMatterYamlProblem(markdown.slice(yamlStart, lineStart))) return none;
      let end = ending ? lineEnd + ending[0].length : markdown.length;
      // The blank lines after the block stay with it: the editor drops blank
      // lines at the start of the markdown it is given.
      if (ending) {
        for (
          let next = lineEnding.exec(markdown);
          next && BLANK_LINE.test(markdown.slice(end, next.index));
          next = lineEnding.exec(markdown)
        ) {
          end = next.index + next[0].length;
        }
      }
      return {
        frontMatter: {
          open: markdown.slice(0, yamlStart),
          yaml: markdown.slice(yamlStart, lineStart),
          close: markdown.slice(lineStart, end),
          lineEnding: opening[0],
        },
        body: markdown.slice(end),
      };
    }
    if (!ending) return none;
    lineStart = lineEnd + ending[0].length;
  }
}

/** Puts a front matter block back in front of the markdown after it. */
export function joinFrontMatter(frontMatter: FrontMatter | null, body: string): string {
  if (!frontMatter) return body;
  const block = frontMatter.open + frontMatter.yaml + frontMatter.close;
  // A block at the very end of a file has no line ending after its closing
  // "---", so text written after it starts on a line of its own.
  const separator = body && !/[\r\n]$/.test(block) ? frontMatter.lineEnding : "";
  return block + separator + body;
}

/** The YAML to show, with "\n" line endings and without the one that ends its last line. */
export function frontMatterYamlText(frontMatter: FrontMatter): string {
  return frontMatter.yaml.replace(/\r\n?/g, "\n").replace(/\n$/, "");
}

/**
 * The block with its YAML replaced by `yaml`, as typed, keeping its fences,
 * byte order mark, line endings and the blank lines after it. Null when the
 * new YAML would not be read back as front matter (see frontMatterYamlProblem).
 */
export function withFrontMatterYaml(frontMatter: FrontMatter, yaml: string): FrontMatter | null {
  if (frontMatterYamlProblem(yaml)) return null;
  const lineEnding = frontMatter.lineEnding;
  return { ...frontMatter, yaml: `${yaml.split(LINE_ENDING).join(lineEnding)}${lineEnding}` };
}

/**
 * A whole file pasted into a file: the front matter it starts with, which
 * becomes the file's own, the file's body as it is, and the rest of the paste,
 * which is what goes into the rich text. Null when the paste has no front
 * matter. A byte order mark the file starts with stays at its very start.
 */
export function pastedFrontMatter(
  file: { frontMatter: FrontMatter | null; body: string },
  pasted: string,
): { frontMatter: FrontMatter; body: string; rest: string } | null {
  const bom = (file.frontMatter ? file.frontMatter.open : file.body).startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK : "";
  const split = splitFrontMatter(bom + (pasted.startsWith(BYTE_ORDER_MARK) ? pasted.slice(BYTE_ORDER_MARK.length) : pasted));
  if (!split.frontMatter) return null;
  // With no front matter before, the byte order mark started the body.
  const body = !file.frontMatter && bom ? file.body.slice(bom.length) : file.body;
  return { frontMatter: split.frontMatter, body, rest: split.body };
}
