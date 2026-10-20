import { commentRedactionReplacement } from "@paperclipai/shared";

// Operational values needed to address/resume runs must survive a manual cleanup.
// Everything else is content, including unknown provider fields and token values.
const structural = /(?:^|[_-])(?:id|ids|config|settings|session|folder|path|directory|cwd|url|ref|digest|hash|usage|budget|cost|status|type|timestamp|created_at|updated_at)$|(?:Id|Ids|ID|IDs|Config|Settings|Session|Folder|Path|Directory|Url|URL|Ref|Digest|Hash|Usage|Budget|Cost|Status|Timestamp|CreatedAt|UpdatedAt)$|^(?:sessionParams|sessionParamsJson|adapterSessionParams|adapterConfig|runtimeConfig|createdAt|updatedAt)$/;

/** The original target determines the marker, even when matching encoded text. */
export function redactionVariants(targets: readonly string[], keepLast4: boolean, maxLevel = 2) {
  const forms = new Map<string, string>();
  for (const target of targets) {
    const replacement = commentRedactionReplacement(target, keepLast4);
    let form = target;
    for (let level = 0; level <= maxLevel; level++) {
      forms.set(form, replacement);
      form = JSON.stringify(form).slice(1, -1);
    }
  }
  return forms;
}

const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Python and other encoders can escape individual UTF-16 units, including emoji.
// Match these representations without decoding/re-encoding enclosing JSON.
function encodedPattern(form: string) {
  return form.split("").map((unit) => {
    if (unit.charCodeAt(0) < 128) return escapePattern(unit);
    const hex = unit.charCodeAt(0).toString(16).padStart(4, "0").replace(/[a-f]/g, (c) => `[${c}${c.toUpperCase()}]`);
    return `(?:${escapePattern(unit)}|\\\\{1,8}u${hex})`;
  }).join("");
}

// PostgreSQL text cannot contain lone surrogate halves. Keep a supplementary
// literal whole, while accepting either hex case for both escaped UTF-16 units.
// PostgreSQL's compiler allocates a state/character matrix. Conservatively
// estimate that work from generated source length and distinct characters.
// Long selections require ALL contiguous pieces; JS still checks full adjacency.
const MAX_PG_REGEX_SOURCE_UNITS = 16_000;
const MAX_PG_REGEX_COMPLEXITY = 1_000_000;
const hexUnit = (unit: string) => unit.charCodeAt(0).toString(16).padStart(4, "0").replace(/[a-f]/g, (c) => `[${c}${c.toUpperCase()}]`);
function postgresEncodedPatterns(targets: Iterable<string>) {
  const alternatives: string[][] = [];
  let merged = "", mergedStates = 0;
  const mergedColors = new Set<string>();
  for (const target of targets) {
    if (!/[^\x00-\x7f]/.test(target)) continue;
    const pieces: string[] = [];
    let piece = "", states = 0;
    let colors = new Set<string>();
    for (const char of target) {
      const forms = [...redactionVariants([char], false, 3).keys()];
      // One program covers every encoding level, including mixed spellings.
      // This is a conservative filter, never a replacement instruction.
      const pattern = char.charCodeAt(0) < 128
        ? forms.length === 1 ? escapePattern(char) : `(?:${forms.map(escapePattern).join("|")})`
        // jsonb serialization doubles decoded backslashes. SQL deliberately
        // accepts a superset; the JS replacement bound remains {1,8}.
        : `(?:${escapePattern(char)}|${char.split("").map((unit) => `\\\\+u${hexUnit(unit)}`).join("")})`;
      const nextStates = states + pattern.length;
      const atomColors = new Set(pattern);
      const nextColorCount = colors.size + [...atomColors].filter((unit) => !colors.has(unit)).length;
      if (piece && (nextStates > MAX_PG_REGEX_SOURCE_UNITS || nextStates * nextColorCount > MAX_PG_REGEX_COMPLEXITY)) {
        pieces.push(piece); piece = ""; states = 0; colors = new Set();
      }
      piece += pattern; states += pattern.length;
      for (const unit of pattern) colors.add(unit);
    }
    if (piece) pieces.push(piece);
    // Combine complete ordinary targets as well as their encoding forms. Keep
    // long-piece conjunctions separate and preserve the compiler-work bounds.
    const combinedColors = new Set([...mergedColors, ...colors]);
    const mergedSize = mergedStates + states + 4 + (merged ? 1 : 0);
    if (pieces.length === 1 && mergedSize <= MAX_PG_REGEX_SOURCE_UNITS
      && mergedSize * combinedColors.size <= MAX_PG_REGEX_COMPLEXITY) {
      merged += `${merged ? "|" : ""}(?:${piece})`; mergedStates = mergedSize;
      for (const unit of colors) mergedColors.add(unit);
    } else alternatives.push(pieces);
  }
  if (merged) alternatives.unshift([merged]);
  return Object.freeze(alternatives.map((parts) => Object.freeze(parts)));
}

// Only escapes of this selection's own UTF-16 units can introduce a spelling
// absent from the literal forms. Sharing an escaped unit only enables the full
// spelling test; it never creates a modification candidate by itself.
function postgresUnicodePrechecks(targets: Iterable<string>) {
  const units = [...new Set([...targets].flatMap((target) => target.split("").filter((unit) => unit.charCodeAt(0) >= 128)))];
  const patterns: string[] = [];
  // Four hex positions have a fixed alphabet; 1024 alternatives bounds compiler
  // state even at the API maximum of 20 selections of 2000 UTF-16 units.
  for (let offset = 0; offset < units.length; offset += 1024) {
    patterns.push(`\\\\u(?:${units.slice(offset, offset + 1024).map(hexUnit).join("|")})`);
  }
  return Object.freeze(patterns);
}

export class OperationalJsonLimitError extends Error {}
export type CommentCopySource = { commentId: string; originalBody: string; redactedBody: string; activity?: boolean };

export type RedactionEdit = { start: number; length: number; replacement: string };
const applyEdits = (text: string, edits: RedactionEdit[]) => {
  let cursor = 0;
  let output = "";
  for (const edit of edits) {
    output += text.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.start + edit.length;
  }
  return output + text.slice(cursor);
};

/** Request-local matching data, never retained in a process-wide cache. */
export type PreparedCommentRedaction = Readonly<{
  targets: readonly string[];
  keepLast4: boolean;
  candidateForms: readonly string[];
  unicodeCandidatePatterns: readonly (readonly string[])[];
  unicodeEdgeCandidatePatterns: readonly (readonly string[])[];
  unicodePrechecks: readonly string[];
  unicodeEdgePrechecks: readonly string[];
  edgeCandidateForms: readonly string[];
  edits: (text: string, serialized?: boolean) => RedactionEdit[];
  edgeMatches: (view: string) => number;
}>;

function prefixLengths(chars: readonly string[]) {
  const lengths = new Uint32Array(chars.length);
  for (let i = 1; i < chars.length; i++) {
    let j = lengths[i - 1]!;
    while (j && chars[i] !== chars[j]) j = lengths[j - 1]!;
    if (chars[i] === chars[j]) j++;
    lengths[i] = j;
  }
  return lengths;
}
function boundaryOverlap(text: string, chars: readonly string[], lengths: Uint32Array) {
  let matched = 0;
  for (const char of text) {
    while (matched && (matched === chars.length || char !== chars[matched])) matched = lengths[matched - 1]!;
    if (char === chars[matched]) matched++;
  }
  return matched;
}

export function prepareCommentRedaction(targets: readonly string[], keepLast4: boolean, normalLevel = 2): PreparedCommentRedaction {
  const uniqueTargets = Object.freeze([...new Set(targets)]);
  const normalForms = new Set<string>();
  const allForms = new Map<string, string>();
  for (const target of uniqueTargets) {
    const replacement = commentRedactionReplacement(target, keepLast4);
    let form = target;
    for (let level = 0; level <= Math.max(normalLevel, 3); level++) {
      allForms.set(form, replacement);
      if (level <= normalLevel) normalForms.add(form);
      form = JSON.stringify(form).slice(1, -1);
    }
  }
  // Build each encoded alternative once, including the extra transport level
  // used by residual checks. Each call resets the private matching cursors.
  const choices = [...allForms.entries()].sort(([a], [b]) => b.length - a.length)
    .map(([form, replacement]) => ({ form, replacement, pattern: `(${encodedPattern(form)})` }));
  // V8 can defer compilation until the first match. One enormous alternation
  // then throws for valid 20 x 2000-unit requests, after SQL has succeeded.
  // Retain complete forms, but compile bounded groups once per request.
  const compile = (items: typeof choices) => {
    const programs: Array<{ items: typeof choices; pattern: RegExp }> = [];
    let group: typeof choices = [], size = 0;
    const flush = () => {
      if (!group.length) return;
      programs.push({ items: group, pattern: new RegExp(group.map((item) => item.pattern).join("|"), "g") });
      group = []; size = 0;
    };
    for (const item of items) {
      if (size + item.pattern.length > 48_000) flush();
      group.push(item); size += item.pattern.length + 1;
    }
    flush();
    return programs;
  };
  const normal = compile(choices.filter((item) => normalForms.has(item.form)));
  const serialized = compile(choices);
  const edges = [...normalForms].map((form) => {
    const chars = Array.from(form);
    const reverse = [...chars].reverse();
    return { form, chars, prefix: prefixLengths(chars), reverse, reversePrefix: prefixLengths(reverse) };
  });
  return Object.freeze({
    targets: uniqueTargets, keepLast4,
    candidateForms: Object.freeze([...allForms.keys()]),
    unicodeCandidatePatterns: postgresEncodedPatterns(uniqueTargets),
    unicodeEdgeCandidatePatterns: postgresEncodedPatterns(redactionCandidateFragments(uniqueTargets)),
    unicodePrechecks: postgresUnicodePrechecks(uniqueTargets),
    unicodeEdgePrechecks: postgresUnicodePrechecks(redactionCandidateFragments(uniqueTargets)),
    edgeCandidateForms: Object.freeze([...redactionVariants(redactionCandidateFragments(uniqueTargets), keepLast4, 3).keys()]),
    edits(text: string, transport = false) {
      const programs = transport ? serialized : normal;
      // Keep only one pending match per program. Never accumulate every
      // overlapping candidate from every target. Earliest position, followed
      // by the original longest-form priority, preserves the single-regex rule.
      const pending = programs.map(({ pattern }) => { pattern.lastIndex = 0; return pattern.exec(text); });
      const edits: RedactionEdit[] = [];
      let cursor = 0;
      try {
        while (true) {
          let selected = -1, first: RegExpExecArray | null = null;
          for (let index = 0; index < programs.length; index++) {
            const program = programs[index]!;
            if (pending[index] && pending[index]!.index < cursor) {
              // An overlapping match that lost to another program must restart
              // at the accepted cursor, rather than skipping its entire span.
              program.pattern.lastIndex = cursor;
              pending[index] = program.pattern.exec(text);
            }
            const match = pending[index];
            if (match && (!first || match.index < first.index)) { first = match; selected = index; }
          }
          if (!first) break;
          const program = programs[selected]!;
          edits.push({ start: first.index, length: first[0].length,
            replacement: program.items[first.slice(1).findIndex((group) => group !== undefined)]!.replacement });
          cursor = first.index + Math.max(1, first[0].length);
        }
      } finally { for (const { pattern } of programs) pattern.lastIndex = 0; }
      return edits;
    },
    edgeMatches(view: string) {
      let start = false;
      let end = false;
      for (const edge of edges) {
        if (!edge.form.includes(view.slice(0, 4)) && !edge.form.includes(view.slice(-4))) continue;
        const head = boundaryOverlap(Array.from(view.slice(0, edge.form.length)).reverse().join(""), edge.reverse, edge.reversePrefix);
        const tail = boundaryOverlap(view.slice(-edge.form.length), edge.chars, edge.prefix);
        start ||= head >= 4 && head < edge.chars.length;
        end ||= tail >= 4 && tail < edge.chars.length;
      }
      return Number(start) + Number(end);
    },
  });
}

/** Human text stays content even when it contains serialized JSON. */
export function operationalTextEdits(text: string, targets: readonly string[], keepLast4: boolean, maxLevel = 2, prepared = prepareCommentRedaction(targets, keepLast4, maxLevel)): RedactionEdit[] {
  return prepared.edits(text);
}
export function redactOperationalText(text: string, targets: readonly string[], keepLast4: boolean, prepared = prepareCommentRedaction(targets, keepLast4)) {
  return applyEdits(text, prepared.edits(text));
}

/** Adapter frames have operational ids. Arbitrary JSON pasted into output is text. */
export function logContentEdits(text: string, targets: readonly string[], keepLast4: boolean, prepared = prepareCommentRedaction(targets, keepLast4), onSkippedLine?: () => void): RedactionEdit[] {
  let offset = 0;
  let plainStart = 0;
  const edits: RedactionEdit[] = [];
  const plain = (end: number) => edits.push(...prepared.edits(text.slice(plainStart, end)).map((edit) => ({ ...edit, start: edit.start + plainStart })));
  for (const line of text.split("\n")) {
    let frame = false;
    try { frame = typeof JSON.parse(line)?.type === "string"; } catch { /* Plain output. */ }
    if (frame && !targets.includes(line)) {
      plain(offset);
      try {
        edits.push(...operationalJsonEdits(line, prepared).map((edit) => ({ ...edit, start: edit.start + offset })));
      } catch (error) {
        if (!(error instanceof OperationalJsonLimitError)) throw error;
        // Skip only this provider frame. A plain fallback would rewrite its
        // operational keys/ids. Other output lines still receive exact cleanup.
        onSkippedLine?.();
      }
      plainStart = offset + line.length + 1;
    }
    offset += line.length + 1;
  }
  plain(text.length);
  return edits;
}

/** SQL uses these necessary fragments; JS checks edges before reporting them. */
export function redactionCandidateFragments(targets: readonly string[]) {
  return [...new Set(targets.flatMap((target) => {
    const chars = Array.from(target);
    return [chars.slice(0, 4).join(""), chars.slice(-4).join("")];
  }))];
}

// Consume even an unclosed token once. Retrying at its escaped quotes makes a
// malformed provider stream quadratic. JSON.parse still rejects invalid tokens.
export function* quotedJsonTokens(text: string) {
  let pos = 0;
  while (pos < text.length) {
    const start = text.indexOf('"', pos);
    if (start < 0) return;
    pos = start + 1;
    while (pos < text.length) {
      const char = text[pos++];
      if (char === "\\") pos = Math.min(pos + 1, text.length);
      else if (char === '"') {
        yield { index: start, text: text.slice(start, pos) };
        break;
      }
    }
  }
}

// Only heartbeat's fixed producer markers create additional observation edges.
// Include serialized newlines for clipped/malformed nested provider strings.
const truncationMarkers = [0, 1, 2, 3].map((level) => {
  let newline = "\n";
  for (let i = 0; i < level; i++) newline = JSON.stringify(newline).slice(1, -1);
  const nl = escapePattern(newline);
  return new RegExp(`${nl}\\[truncated [1-9][0-9]* chars\\]$|${nl}\\[paperclip truncated run log chunk: omitted [1-9][0-9]* chars\\]${nl}`, "g");
});

/** Counts exact/encoded selections and conservative cut-off pieces, never deletes guesses. */
export function redactionResidualMatches(text: string, targets: readonly string[], keepLast4: boolean, serialized = false, prepared = prepareCommentRedaction(targets, keepLast4)) {
  let count = prepared.edits(text, serialized).length;
  const views = [text];
  let levelStart = 0;
  // A provider string can itself hold serialized API JSON. Inspect string
  // boundaries through the supported encoding levels without changing content.
  for (let level = 0; level < 3; level++) {
    const levelEnd = views.length;
    for (let i = levelStart; i < levelEnd; i++) {
      for (const token of quotedJsonTokens(views[i]!)) {
        try { views.push(JSON.parse(token.text)); } catch { /* A clipped token is not a field. */ }
      }
    }
    levelStart = levelEnd;
  }
  for (let view of views) {
    if (Array.from(view.slice(0, 8)).length < 4) continue;
    for (let level = 0; level < 3; level++) view = view.replace(/\\{1,8}u([a-fA-F0-9]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    // Split observations only; partial text is never a replacement directive.
    let pieces = [view];
    for (const marker of truncationMarkers) pieces = pieces.flatMap((piece) => piece.split(marker));
    for (const piece of pieces) count += prepared.edgeMatches(piece);
  }
  return count;
}

/**
 * Work on JSON string tokens only. JSON numbers (including integers above 2^53),
 * keys, formatting and structural values retain their exact serialized bytes.
 * PostgreSQL provides valid JSON; this never decodes a document into JS numbers.
 */
function operationalJsonEdits(serialized: string, prepared: PreparedCommentRedaction, source?: CommentCopySource): RedactionEdit[] {
  let pos = 0;
  const edits: Array<{ start: number; end: number; text: string }> = [];
  function space() { while (/\s/.test(serialized[pos] ?? "") && pos < serialized.length) pos++; }
  function stringToken() {
    const start = pos++;
    while (pos < serialized.length) {
      const char = serialized[pos++];
      if (char === "\\") pos++;
      else if (char === '"') break;
    }
    return { start, end: pos, value: JSON.parse(serialized.slice(start, pos)) as string };
  }
  function value(blocked: boolean, depth: number, route: string[] = []): ReturnType<typeof stringToken> | undefined {
    if (depth > 128) throw new OperationalJsonLimitError("Operational JSON nesting limit exceeded");
    space();
    if (serialized[pos] === "{") {
      pos++; space();
      const properties = new Map<string, ReturnType<typeof stringToken>>();
      while (serialized[pos] !== "}") {
        const key = stringToken().value;
        space(); pos++; // colon
        const token = value(blocked || structural.test(key), depth + 1, [...route, key]);
        if (token) properties.set(key, token);
        space();
        if (serialized[pos] !== ",") break;
        pos++; space();
      }
      pos++;
      const wake = route.at(-1) === "paperclipWakeComment" || route.slice(-3).join(".") === "paperclipWake.comments.*";
      const bodyKey = source?.activity && route.length === 0 ? "bodySnippet" : wake ? "body" : null;
      const identityKey = bodyKey === "bodySnippet" ? "commentId" : "id";
      const body = bodyKey ? properties.get(bodyKey) : undefined;
      if (!blocked && source && body && properties.get(identityKey)?.value === source.commentId && source.originalBody.startsWith(body.value)) {
        // Respect both the producer's limit and any smaller shared wake budget.
        const producerBound = bodyKey === "bodySnippet" ? 120 : route.at(-1) === "paperclipWakeComment" ? Infinity : 4000;
        const bound = Math.min(producerBound, body.value.length < source.originalBody.length ? body.value.length : Infinity);
        let next = source.redactedBody.slice(0, bound);
        // PostgreSQL JSON rejects lone surrogates. Keep the existing UTF-16
        // bound, dropping only the high half when it splits a valid pair.
        const last = next.charCodeAt(next.length - 1);
        const following = source.redactedBody.charCodeAt(next.length);
        if (last >= 0xd800 && last <= 0xdbff && following >= 0xdc00 && following <= 0xdfff) next = next.slice(0, -1);
        const previous = edits.findIndex((edit) => edit.start === body.start);
        if (previous >= 0) edits.splice(previous, 1);
        if (next !== body.value) edits.push({ ...body, text: JSON.stringify(next) });
      }
    } else if (serialized[pos] === "[") {
      pos++; space();
      while (serialized[pos] !== "]") {
        value(blocked, depth + 1, [...route, "*"]); space();
        if (serialized[pos] !== ",") break;
        pos++; space();
      }
      pos++;
    } else if (serialized[pos] === '"') {
      const token = stringToken();
      if (!blocked) {
        const next = applyEdits(token.value, prepared.edits(token.value));
        if (next !== token.value) edits.push({ ...token, text: JSON.stringify(next) });
      }
      return token;
    } else {
      while (pos < serialized.length && !/[\s,}\]]/.test(serialized[pos]!)) pos++;
    }
  }
  value(false, 0);
  return edits.sort((a, b) => a.start - b.start).map((edit) => ({ start: edit.start, length: edit.end - edit.start, replacement: edit.text }));
}
export function redactOperationalJson(serialized: string, targets: readonly string[], keepLast4: boolean, source?: CommentCopySource, prepared = prepareCommentRedaction(targets, keepLast4)) {
  return applyEdits(serialized, operationalJsonEdits(serialized, prepared, source));
}
