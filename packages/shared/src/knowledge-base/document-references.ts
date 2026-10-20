import { DRIVE_FILE_ID_PATTERN } from "../validators/document-links.js";
import { logicalDirname, logicalExtname, logicalJoin, logicalRelative } from "./logical-path.js";

export interface DocumentReference {
  start: number;
  end: number;
  line: number;
  target: string;
  label: string;
  kind: "inline" | "wiki" | "reference" | "definition";
  image: boolean;
  driveFileId: string | null;
  markerEnd: number;
  targetStart: number | null;
  targetEnd: number | null;
}

function escapeFlags(text: string): Uint8Array {
  const flags = new Uint8Array(text.length);
  let slashes = 0;
  for (let index = 0; index < text.length; index += 1) {
    flags[index] = slashes % 2;
    slashes = text[index] === "\\" ? slashes + 1 : 0;
  }
  return flags;
}

/** Mask examples without changing offsets, including multiline code spans. */
function proseMask(text: string, bodyStartLine: number): string {
  const chars = text.split("");
  let offset = 0;
  let fence: { char: string; length: number } | null = null;
  const lines = text.split(/(?<=\n)/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    let hide = index + 1 < bodyStartLine || fence !== null;
    if (fence && match && match[1]![0] === fence.char && match[1]!.length >= fence.length && line.slice(match[0].length).trim() === "") {
      fence = null;
    } else if (!fence && match) {
      fence = { char: match[1]![0]!, length: match[1]!.length };
      hide = true;
    }
    if (hide) for (let at = offset; at < offset + line.length; at += 1) if (chars[at] !== "\n") chars[at] = " ";
    offset += line.length;
  }
  let masked = chars.join("");
  const prose = masked.split("");
  let comment = masked.indexOf("<!--");
  while (comment >= 0) {
    const closing = masked.indexOf("-->", comment + 4);
    const end = closing >= 0 ? closing + 3 : masked.length;
    for (let at = comment; at < end; at += 1) if (prose[at] !== "\n") prose[at] = " ";
    if (closing < 0) break;
    comment = masked.indexOf("<!--", end);
  }
  masked = prose.join("");
  const escapes = escapeFlags(masked);
  const runs: Array<{ start: number; length: number; closing: number | null }> = [];
  for (let index = 0; index < masked.length; index += 1) {
    if (masked[index] !== "`" || escapes[index]) continue;
    let length = 1;
    while (masked[index + length] === "`") length += 1;
    runs.push({ start: index, length, closing: null });
    index += length - 1;
  }
  const nextRun = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]!;
    run.closing = nextRun.get(run.length) ?? null;
    nextRun.set(run.length, run.start);
  }
  let consumedThrough = 0;
  for (const run of runs) {
    if (run.start < consumedThrough || run.closing === null) continue;
    consumedThrough = run.closing + run.length;
    for (let at = run.start; at < consumedThrough; at += 1) if (prose[at] !== "\n") prose[at] = " ";
  }
  return prose.join("");
}

function pairedDelimiters(text: string, opening: string, closing: string): Map<number, number> {
  const stack: number[] = [];
  const pairs = new Map<number, number>();
  for (let at = 0; at < text.length; at += 1) {
    if (text[at] === "\\") { at += 1; continue; }
    if (text[at] === opening) stack.push(at);
    else if (text[at] === closing && stack.length > 0) pairs.set(stack.pop()!, at);
  }
  return pairs;
}

interface DelimiterIndex {
  parentheses: Map<number, number>;
  whitespace: Uint32Array;
  nonWhitespace: Uint32Array;
  greater: Uint32Array;
  doubleQuote: Uint32Array;
  singleQuote: Uint32Array;
}

function delimiterIndex(text: string, escapes: Uint8Array): DelimiterIndex {
  const arrays = [new Uint32Array(text.length + 1), new Uint32Array(text.length + 1), new Uint32Array(text.length + 1), new Uint32Array(text.length + 1), new Uint32Array(text.length + 1)] as const;
  for (const positions of arrays) positions[text.length] = text.length;
  const [whitespace, nonWhitespace, greater, doubleQuote, singleQuote] = arrays;
  for (let at = text.length - 1; at >= 0; at -= 1) {
    const space = /\s/.test(text[at]!);
    whitespace[at] = space && !escapes[at] ? at : whitespace[at + 1]!;
    nonWhitespace[at] = space ? nonWhitespace[at + 1]! : at;
    greater[at] = text[at] === ">" && !escapes[at] ? at : greater[at + 1]!;
    doubleQuote[at] = text[at] === '"' && !escapes[at] ? at : doubleQuote[at + 1]!;
    singleQuote[at] = text[at] === "'" && !escapes[at] ? at : singleQuote[at + 1]!;
  }
  return { parentheses: pairedDelimiters(text, "(", ")"), whitespace, nonWhitespace, greater, doubleQuote, singleQuote };
}

function linkTarget(text: string, start: number, escapes: Uint8Array, delimiters: DelimiterIndex): { target: string; start: number; end: number } | null {
  let at = delimiters.nonWhitespace[start]!;
  const targetStart = at;
  if (text[at] === "<") {
    at = delimiters.greater[at + 1]!;
    if (at >= text.length) return null;
    return { target: text.slice(targetStart, at + 1), start: targetStart, end: at + 1 };
  }
  for (; at < text.length; at += 1) {
    if (escapes[at]) continue;
    if (text[at] === "(") {
      const closing = delimiters.parentheses.get(at);
      if (closing === undefined || delimiters.whitespace[at]! < closing) return null;
      at = closing;
    } else if (text[at] === ")" || /\s/.test(text[at]!)) break;
  }
  return at > targetStart ? { target: text.slice(targetStart, at), start: targetStart, end: at } : null;
}

function referenceKey(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Actual prose references and their exact source ranges. No filesystem or network reads. */
export function documentReferences(text: string, bodyStartLine = 1): DocumentReference[] {
  const masked = proseMask(text, bodyStartLine);
  const escapes = escapeFlags(masked);
  const definitions = new Map<string, string>();
  const result: DocumentReference[] = [];
  const definitionRanges: Array<[number, number]> = [];
  const brackets = pairedDelimiters(masked, "[", "]");
  const delimiters = delimiterIndex(masked, escapes);
  const newlines: number[] = [];
  for (let at = 0; at < text.length; at += 1) if (text[at] === "\n") newlines.push(at);
  const lineAt = (at: number) => {
    let low = 0; let high = newlines.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (newlines[middle]! < at) low = middle + 1; else high = middle;
    }
    return low + 1;
  };
  for (const match of masked.matchAll(/^ {0,3}\[([^\]\n]+)\]:[ \t]*(<[^>\n]+>|\S+)/gm)) {
    const start = match.index!;
    const end = start + match[0].length;
    const key = referenceKey(match[1]!);
    if (!definitions.has(key)) definitions.set(key, match[2]!);
    definitionRanges.push([start, end]);
    result.push({ start, end, line: lineAt(start), target: match[2]!, label: match[1]!, kind: "definition", image: false, driveFileId: null, markerEnd: end, targetStart: null, targetEnd: null });
  }
  let definitionIndex = 0;
  for (let at = 0; at < masked.length; at += 1) {
    while (definitionIndex < definitionRanges.length && at >= definitionRanges[definitionIndex]![1]) definitionIndex += 1;
    if (masked[at] !== "[" || escapes[at]) continue;
    if (definitionIndex < definitionRanges.length && at >= definitionRanges[definitionIndex]![0]) { at = definitionRanges[definitionIndex]![1] - 1; continue; }
    const close = brackets.get(at);
    if (close === undefined) continue;
    let end = close + 1;
    let target: string | null = null;
    let targetStart: number | null = null;
    let targetEnd: number | null = null;
    let label = text.slice(at + 1, close);
    let kind: DocumentReference["kind"] = "reference";
    if (masked[at + 1] === "[" && masked[close - 1] === "]") {
      const parts = text.slice(at + 2, close - 1).split("|");
      target = parts[0]!.trim();
      label = parts.slice(1).join("|") || target;
      kind = "wiki";
    } else if (masked[end] === "(") {
      const parsed = linkTarget(masked, end + 1, escapes, delimiters);
      if (!parsed) continue;
      let tail = delimiters.nonWhitespace[parsed.end]!;
      if (masked[tail] === '"' || masked[tail] === "'") {
        const quote = masked[tail++]!;
        tail = (quote === '"' ? delimiters.doubleQuote : delimiters.singleQuote)[tail]!;
        if (tail >= masked.length) continue;
        tail += 1;
        tail = delimiters.nonWhitespace[tail]!;
      }
      if (masked[tail] !== ")") continue;
      target = parsed.target;
      targetStart = parsed.start;
      targetEnd = parsed.end;
      end = tail + 1;
      kind = "inline";
    } else if (masked[end] === "[") {
      const referenceClose = brackets.get(end);
      if (referenceClose === undefined) continue;
      target = definitions.get(referenceKey(masked.slice(end + 1, referenceClose) || label)) ?? null;
      end = referenceClose + 1;
    } else {
      // Shortcut references cannot have nested bracket labels. Avoid normalizing
      // every overlapping suffix of an adversarial nested-bracket sequence.
      const nested = masked.indexOf("[", at + 1);
      if (definitions.size === 0 || (nested >= 0 && nested < close)) continue;
      target = definitions.get(referenceKey(label)) ?? null;
    }
    if (!target) continue;
    const marker = /^[ \t]*\(Drive-ID:[ \t]*([^\)\r\n]*)\)/.exec(masked.slice(end));
    const malformedMarker = /^[ \t]*\(Drive-ID:/.test(masked.slice(end));
    result.push({ start: at, end, line: lineAt(at), target, label, kind, image: at > 0 && masked[at - 1] === "!" && !escapes[at - 1], driveFileId: marker ? marker[1]!.trim() : malformedMarker ? "" : null, markerEnd: marker ? end + marker[0].length : end, targetStart, targetEnd });
    at = end - 1;
  }
  return result.sort((a, b) => a.start - b.start);
}

export function driveIdFromUrl(raw: string): string | null {
  try {
    const url = new URL(raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    let id: string | null = null;
    if (url.hostname === "drive.google.com") {
      id = /^\/file\/d\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(url.pathname)?.[1] ?? (url.pathname === "/open" ? url.searchParams.get("id") : null);
    } else if (url.hostname === "docs.google.com") {
      id = /^\/(?:document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(url.pathname)?.[1] ?? null;
    }
    return id && DRIVE_FILE_ID_PATTERN.test(id) ? id : null;
  } catch { return null; }
}

/** Resolve logical note paths. Set caseInsensitive to match the supplied map keys. */
export function relativeDocumentTarget(notePath: string, raw: string, wiki: boolean, files: Map<string, string>, caseInsensitive = false): { resolved: string | null; valid: boolean } {
  let target = raw.trim();
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
  if (!target || target.startsWith("#")) return { resolved: null, valid: true };
  const unc = target.startsWith("\\\\");
  target = target.replace(/\\/g, "/");
  if (!unc && !/^[A-Za-z]:\//.test(target) && /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) return { resolved: null, valid: true };
  target = target.split("#", 1)[0]!.split("?", 1)[0]!;
  try { target = decodeURIComponent(target); } catch { /* An invalid escape remains a nonmatching literal path. */ }
  if (target.startsWith("/") || /^[A-Za-z]:\//.test(target)) return { resolved: target, valid: false };
  const joined = logicalJoin(logicalDirname(notePath), target);
  if (joined === ".." || joined.startsWith("../")) return { resolved: joined, valid: false };
  const candidates = [joined];
  if (wiki && !logicalExtname(joined)) candidates.push(`${joined}.md`, `${joined}/index.md`);
  const key = (value: string) => caseInsensitive ? value.toLowerCase() : value;
  const match = candidates.map((candidate) => files.get(key(candidate))).find((value) => value !== undefined);
  return { resolved: match ?? joined, valid: match !== undefined };
}

/** Logical slash paths, resolved from basePath (default /), independent of the host filesystem. */
export function documentPath(source: string, target: string, basePath = "/"): string {
  const relative = logicalRelative(logicalDirname(source), target, basePath);
  const encoded = relative.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return encoded;
}

export function documentLink(label: string, source: string, target: string, id: string, suffix = "", basePath = "/"): string {
  return `[${label}](${documentPath(source, target, basePath)}${suffix}) (Drive-ID: ${id})`;
}
