import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";
import type {
  KnowledgeBaseFinding,
  KnowledgeBaseIndexResult,
  KnowledgeBaseValidationResult,
  MemoryKind,
} from "@paperclipai/shared";
import { MEMORY_DESCRIPTION_MAX, MEMORY_KINDS, MEMORY_NAME_MAX, DRIVE_FILE_ID_PATTERN, declaredDriveFileId } from "@paperclipai/shared";
import { INDEX_FILE, isSkippedFileName, parseMemoryFile } from "./memory-folder-markdown.js";
import { documentReferences, relativeDocumentTarget, driveIdFromUrl } from "./document-links.js";

export const DEFAULT_ACTIVE_NOTE_STALE_DAYS = 90;
const MAX_SCAN_FILES = 5_000;
export const MEMORY_FOLDER_FILE_MAX_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_DEPTH = 20;
const DRIVE_ID_RE = DRIVE_FILE_ID_PATTERN;
const NOTE_STATUSES = new Set(["active", "superseded", "archived"]);
const ARCHIVE_SEGMENTS = new Set(["archive", "archived", "archives", "superseded", "_superseded"]);

interface StrictFrontmatter {
  fields: Record<string, string>;
  lines: Record<string, number>;
  problems: string[];
  bodyStartLine: number;
}

export interface ScannedNote {
  path: string;
  text: string;
  fields: Record<string, string>;
  fieldLines: Record<string, number>;
  bodyStartLine: number;
  name: string;
  kind: MemoryKind;
  description: string | null;
  agent: string | null;
  status: string | null;
  updated: Date;
  valid: boolean;
  driveFileId: string | null;
}

export interface Inspection {
  filesScanned: number;
  findings: KnowledgeBaseFinding[];
  notes: ScannedNote[];
  regularFiles: Map<string, string>;
}

function slash(value: string): string {
  return value.split(path.sep).join("/");
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "string" ? parsed : value;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function strictFrontmatter(text: string): StrictFrontmatter {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const fields: Record<string, string> = {};
  const fieldLines: Record<string, number> = {};
  const problems: string[] = [];
  if (lines[0] !== "---") {
    return { fields, lines: fieldLines, problems: ["missing opening frontmatter delimiter"], bodyStartLine: 1 };
  }
  const closing = lines.indexOf("---", 1);
  if (closing < 0) {
    return { fields, lines: fieldLines, problems: ["missing closing frontmatter delimiter"], bodyStartLine: 1 };
  }
  for (let index = 1; index < closing; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) {
      problems.push(`line ${index + 1} is not a key: value field`);
      continue;
    }
    const key = match[1]!.toLowerCase();
    if (Object.hasOwn(fields, key)) {
      problems.push(`field ${key} is repeated`);
      continue;
    }
    fields[key] = unquote(match[2]!);
    fieldLines[key] = index + 1;
  }
  return { fields, lines: fieldLines, problems, bodyStartLine: closing + 2 };
}

function validUpdated(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface MemoryHeaderValidation {
  valid: boolean;
  problems: string[];
  fields: Record<string, string>;
  fieldLines: Record<string, number>;
  bodyStartLine: number;
  updated: Date | null;
}

/** Strict validation for the canonical note header. Legacy parsing stays lenient. */
export function validateMemoryFileHeader(text: string): MemoryHeaderValidation {
  const parsed = strictFrontmatter(text);
  const problems = [...parsed.problems];
  const name = (parsed.fields.name ?? "").trim();
  if (!name) problems.push("required field name is missing");
  else if (name.length > MEMORY_NAME_MAX) problems.push(`field name is longer than ${MEMORY_NAME_MAX} characters`);

  const kind = (parsed.fields.kind ?? "").trim().toLowerCase();
  if (!kind) problems.push("required field kind is missing");
  else if (!(MEMORY_KINDS as readonly string[]).includes(kind)) {
    problems.push(`field kind must be one of ${MEMORY_KINDS.join(", ")}`);
  }

  const updatedText = (parsed.fields.updated ?? "").trim();
  const updated = validUpdated(updatedText);
  if (!updatedText) problems.push("required field updated is missing");
  else if (!updated) problems.push("field updated must be an ISO date or timestamp");

  const description = parsed.fields.description;
  if (description && description.length > MEMORY_DESCRIPTION_MAX) {
    problems.push(`field description is longer than ${MEMORY_DESCRIPTION_MAX} characters`);
  }
  const status = (parsed.fields.status ?? "").trim().toLowerCase();
  if (status && !NOTE_STATUSES.has(status)) {
    problems.push("field status must be active, superseded, or archived");
  }
  const paperclipId = (parsed.fields.paperclip_id ?? parsed.fields.paperclipid ?? "").trim();
  if (paperclipId && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(paperclipId)) {
    problems.push("field paperclip_id must be a UUID");
  }
  const identity = declaredDriveFileId(parsed.fields);
  if (identity.problem) problems.push(identity.problem);
  return {
    valid: problems.length === 0,
    problems,
    fields: parsed.fields,
    fieldLines: parsed.lines,
    bodyStartLine: parsed.bodyStartLine,
    updated,
  };
}

function fingerprint(parts: Array<string | number | null>): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

function finding(
  kind: KnowledgeBaseFinding["kind"],
  severity: KnowledgeBaseFinding["severity"],
  relativePath: string,
  line: number | null,
  summary: string,
  details: Record<string, unknown>,
  identity: string,
): KnowledgeBaseFinding {
  return {
    kind,
    severity,
    path: relativePath,
    line,
    summary,
    details,
    fingerprint: fingerprint([kind, relativePath, line, identity]),
  };
}

function isMarkdown(name: string): boolean {
  return name.toLowerCase().endsWith(".md");
}

function fileSystemPathKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

async function listTree(root: string): Promise<{
  markdown: Array<{ relativePath: string; fullPath: string }>;
  regularFiles: Map<string, string>;
  findings: KnowledgeBaseFinding[];
}> {
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Configured memory folder must be an ordinary directory, not a linked path");
  }
  const rootReal = await fs.realpath(root);
  const markdown: Array<{ relativePath: string; fullPath: string }> = [];
  const regularFiles = new Map<string, string>();
  const findings: KnowledgeBaseFinding[] = [];
  let entriesSeen = 0;

  async function walk(folder: string, relativeFolder: string, depth: number): Promise<void> {
    if (depth > MAX_SCAN_DEPTH) throw new Error(`Knowledge-base folder is deeper than ${MAX_SCAN_DEPTH} levels`);
    const openedDirectory = await fs.lstat(folder);
    if (openedDirectory.isSymbolicLink() || !openedDirectory.isDirectory()) {
      throw new Error(`${relativeFolder || "."} changed while the knowledge base was being scanned`);
    }
    const folderReal = await fs.realpath(folder);
    const folderRelativeReal = path.relative(rootReal, folderReal);
    if (folderRelativeReal === ".." || folderRelativeReal.startsWith(`..${path.sep}`) || path.isAbsolute(folderRelativeReal)) {
      throw new Error(`${relativeFolder || "."} resolves outside the configured folder`);
    }
    const entries = await fs.readdir(folder, { withFileTypes: true });
    const currentDirectory = await fs.lstat(folder);
    if (
      currentDirectory.isSymbolicLink() ||
      !currentDirectory.isDirectory() ||
      currentDirectory.dev !== openedDirectory.dev ||
      currentDirectory.ino !== openedDirectory.ino
    ) {
      throw new Error(`${relativeFolder || "."} changed while the knowledge base was being scanned`);
    }
    entries.sort((a, b) => compareText(a.name, b.name));
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > MAX_SCAN_FILES) throw new Error(`Knowledge-base folder has more than ${MAX_SCAN_FILES} entries`);
      const relativePath = slash(path.join(relativeFolder, entry.name));
      const fullPath = path.join(folder, entry.name);
      const stat = await fs.lstat(fullPath);
      if (stat.isSymbolicLink()) {
        findings.push(finding(
          "unsafe_entry",
          "high",
          relativePath,
          null,
          `${relativePath} is a linked path and was not read`,
          { recommendation: "Replace the linked entry with an ordinary file or directory inside the configured folder" },
          "symbolic-link",
        ));
        continue;
      }
      if (stat.isDirectory()) {
        await walk(fullPath, relativePath, depth + 1);
        continue;
      }
      if (!stat.isFile()) continue;
      const real = await fs.realpath(fullPath);
      const relativeReal = path.relative(rootReal, real);
      if (relativeReal.startsWith(`..${path.sep}`) || relativeReal === ".." || path.isAbsolute(relativeReal)) {
        findings.push(finding("unsafe_entry", "high", relativePath, null, `${relativePath} resolves outside the configured folder`, {}, "outside-root"));
        continue;
      }
      regularFiles.set(fileSystemPathKey(relativePath), relativePath);
      if (isMarkdown(entry.name) && !isSkippedFileName(entry.name)) {
        if (stat.size > MEMORY_FOLDER_FILE_MAX_BYTES) {
          findings.push(finding(
            "unsafe_entry",
            "medium",
            relativePath,
            null,
            `${relativePath} is larger than the validator limit`,
            { bytes: stat.size, maximumBytes: MEMORY_FOLDER_FILE_MAX_BYTES },
            `oversize:${stat.size}`,
          ));
          continue;
        }
        markdown.push({ relativePath, fullPath });
      }
    }
  }

  await walk(root, "", 0);
  return { markdown, regularFiles, findings };
}

function markdownTargets(text: string, bodyStartLine: number): Array<{ target: string; line: number; wiki: boolean }> {
  const targets: Array<{ target: string; line: number; wiki: boolean }> = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const inline = /!?\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g;
  const reference = /^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/;
  const wiki = /\[\[([^\]]+)\]\]/g;
  let fence: "```" | "~~~" | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (index + 1 < bodyStartLine) continue;
    const trimmed = line.trimStart();
    if (fence) {
      if (trimmed.startsWith(fence)) fence = null;
      continue;
    }
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      fence = trimmed.slice(0, 3) as "```" | "~~~";
      continue;
    }
    const withoutInlineCode = line.replace(/(`+)(.*?)\1/g, (match) => " ".repeat(match.length));
    for (const match of withoutInlineCode.matchAll(inline)) targets.push({ target: match[1]!, line: index + 1, wiki: false });
    const ref = reference.exec(withoutInlineCode);
    if (ref) targets.push({ target: ref[1]!, line: index + 1, wiki: false });
    for (const match of withoutInlineCode.matchAll(wiki)) {
      targets.push({ target: match[1]!.split("|", 1)[0]!.trim(), line: index + 1, wiki: true });
    }
  }
  return targets;
}

async function readOrdinaryNote(
  rootReal: string,
  fullPath: string,
  afterOpen?: () => Promise<void>,
): Promise<{ text: string; stat: Stats }> {
  const handle = await fs.open(fullPath, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error("entry is not an ordinary file");
    if (opened.size > MEMORY_FOLDER_FILE_MAX_BYTES) throw new Error(`file is larger than ${MEMORY_FOLDER_FILE_MAX_BYTES} bytes`);
    await afterOpen?.();
    const current = await fs.lstat(fullPath);
    if (current.isSymbolicLink() || !current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new Error("file identity changed while it was being opened");
    }
    const currentReal = await fs.realpath(fullPath);
    const relativeReal = path.relative(rootReal, currentReal);
    if (relativeReal === ".." || relativeReal.startsWith(`..${path.sep}`) || path.isAbsolute(relativeReal)) {
      throw new Error("file resolves outside the configured folder");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > MEMORY_FOLDER_FILE_MAX_BYTES) throw new Error(`file is larger than ${MEMORY_FOLDER_FILE_MAX_BYTES} bytes`);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const after = await fs.lstat(fullPath);
    if (after.isSymbolicLink() || !after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error("file identity changed while it was being read");
    }
    return { text, stat: opened };
  } finally {
    await handle.close();
  }
}

/** Open a configured-folder note without following a swapped linked path. */
export async function readMemoryFolderFileSafely(
  root: string,
  fullPath: string,
): Promise<{ text: string; stat: Stats }> {
  const rootHandle = await fs.open(root, "r");
  const openedRoot = await rootHandle.stat();
  const rootReal = await fs.realpath(root);

  async function assertOriginalRoot(): Promise<void> {
    const current = await fs.lstat(root);
    const currentReal = await fs.realpath(root);
    const sameRealPath = process.platform === "win32"
      ? currentReal.toLowerCase() === rootReal.toLowerCase()
      : currentReal === rootReal;
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      !openedRoot.isDirectory() ||
      current.dev !== openedRoot.dev ||
      current.ino !== openedRoot.ino ||
      !sameRealPath
    ) {
      throw new Error("Configured memory folder changed while a file was being read");
    }
  }

  try {
    await assertOriginalRoot();
    const result = await readOrdinaryNote(rootReal, fullPath, assertOriginalRoot);
    await assertOriginalRoot();
    return result;
  } finally {
    await rootHandle.close();
  }
}

/** Write one direct child through a same-folder temporary file and atomic rename. */
export async function writeMemoryFolderFileAtomically(
  root: string,
  target: string,
  text: string,
): Promise<void> {
  const rootHandle = await fs.open(root, "r");
  const openedRoot = await rootHandle.stat();
  const rootReal = await fs.realpath(root);

  async function assertOriginalRoot(): Promise<void> {
    const current = await fs.lstat(root);
    const currentReal = await fs.realpath(root);
    const sameRealPath = process.platform === "win32"
      ? currentReal.toLowerCase() === rootReal.toLowerCase()
      : currentReal === rootReal;
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      !openedRoot.isDirectory() ||
      current.dev !== openedRoot.dev ||
      current.ino !== openedRoot.ino ||
      !sameRealPath
    ) {
      throw new Error("Configured memory folder changed while a file was being written");
    }
  }

  try {
    await assertOriginalRoot();
    if (path.relative(path.resolve(root), path.resolve(path.dirname(target))) !== "") {
      throw new Error("Memory folder writes must stay directly inside the configured folder");
    }
    await assertOriginalRoot();

    const temporary = path.join(root, `.memory-write.${process.pid}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    let openedTemporary: Stats | null = null;
    let renamed = false;

    async function assertOriginalTemporary(currentPath: string): Promise<void> {
      await assertOriginalRoot();
      const current = await fs.lstat(currentPath);
      const currentReal = await fs.realpath(currentPath);
      const relative = path.relative(rootReal, currentReal);
      if (
        !openedTemporary ||
        current.isSymbolicLink() ||
        !current.isFile() ||
        current.dev !== openedTemporary.dev ||
        current.ino !== openedTemporary.ino ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        throw new Error("Memory folder temporary file changed while it was being written");
      }
    }

    try {
      handle = await fs.open(temporary, "wx", 0o600);
      openedTemporary = await handle.stat();
      await assertOriginalTemporary(temporary);
      await handle.writeFile(text, "utf8");
      await handle.sync();
      await assertOriginalTemporary(temporary);
      await handle.close();
      handle = null;
      await assertOriginalTemporary(temporary);
      await fs.rename(temporary, target);
      renamed = true;
      await assertOriginalTemporary(target);
    } catch (err) {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // The original write or sync error is the useful failure.
        }
      }
      if (!renamed && openedTemporary) {
        try {
          await assertOriginalTemporary(temporary);
          await fs.rm(temporary, { force: true });
        } catch {
          // Never clean up through a path whose directory or file identity changed.
        }
      }
      throw err;
    }
  } finally {
    try {
      await rootHandle.close();
    } catch {
      // A completed mutation should not be reported as failed only because the directory handle did not close cleanly.
    }
  }
}

function cleanRelativeTarget(raw: string): string | null {
  let target = raw.trim();
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
  const windowsUncPath = target.startsWith("\\\\");
  target = target.replace(/\\/g, "/");
  if (!target || target.startsWith("#")) return null;
  if (windowsUncPath) return target;
  if (/^[A-Za-z]:\//.test(target)) return target;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) return null;
  target = target.split("#", 1)[0]!.split("?", 1)[0]!;
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function resolveTarget(notePath: string, raw: string, wiki: boolean, regularFiles: Map<string, string>): {
  resolved: string | null;
  valid: boolean;
} {
  const cleaned = cleanRelativeTarget(raw);
  if (cleaned === null) return { resolved: null, valid: true };
  if (cleaned.startsWith("/") || /^[A-Za-z]:\//.test(cleaned)) return { resolved: cleaned, valid: false };
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(notePath), cleaned));
  if (joined === ".." || joined.startsWith("../")) return { resolved: joined, valid: false };
  const candidates = [joined];
  if (wiki && !path.posix.extname(joined)) candidates.push(`${joined}.md`, `${joined}/index.md`);
  const matched = candidates.find((candidate) => regularFiles.has(fileSystemPathKey(candidate)));
  const resolved = matched ? regularFiles.get(fileSystemPathKey(matched))! : joined;
  return { resolved, valid: matched !== undefined };
}

function isArchived(note: ScannedNote): boolean {
  if (note.status === "archived" || note.status === "superseded") return true;
  return note.path.split("/").some((segment) => {
    const lower = segment.toLowerCase();
    const withoutPrefix = lower.replace(/^[_\d\s-]+/, "");
    return ARCHIVE_SEGMENTS.has(lower) || ARCHIVE_SEGMENTS.has(withoutPrefix);
  });
}

export async function inspectKnowledgeBase(
  root: string,
  now: Date,
  staleDays: number,
  afterFileOpen?: (relativePath: string) => Promise<void>,
  options: { driveLinkMode?: boolean; texts?: ReadonlyMap<string, string> } = {},
): Promise<Inspection> {
  const tree = await listTree(root);
  const rootReal = await fs.realpath(root);
  const findings = [...tree.findings];
  const notes: ScannedNote[] = [];
  const inbound = new Map<string, number>();

  for (const file of tree.markdown) {
    let text: string;
    try {
      text = (await readOrdinaryNote(
        rootReal,
        file.fullPath,
        afterFileOpen ? () => afterFileOpen(file.relativePath) : undefined,
      )).text;
    } catch (err) {
      findings.push(finding(
        "unsafe_entry",
        "high",
        file.relativePath,
        null,
        `${file.relativePath} was not read safely`,
        { reason: err instanceof Error ? err.message : String(err) },
        "unsafe-read",
      ));
      continue;
    }
    text = options.texts?.get(file.relativePath) ?? text;
    const header = validateMemoryFileHeader(text);
    const lenient = parseMemoryFile(path.posix.basename(file.relativePath), text);
    const identityProblem = declaredDriveFileId(header.fields).problem;
    const structuralProblems = header.problems.filter((problem) => problem !== identityProblem);
    if (structuralProblems.length > 0) {
      findings.push(finding(
        "malformed_frontmatter",
        "high",
        file.relativePath,
        1,
        `${file.relativePath} has malformed required frontmatter`,
        { problems: structuralProblems, recommendation: "Add valid name, kind, and updated fields before writing or importing this note" },
        structuralProblems.join(";"),
      ));
    }
    const status = (header.fields.status ?? "").trim().toLowerCase() || null;
    const note: ScannedNote = {
      path: file.relativePath,
      text,
      fields: header.fields,
      fieldLines: header.fieldLines,
      bodyStartLine: header.bodyStartLine,
      name: lenient.name,
      kind: lenient.kind,
      description: lenient.description,
      agent: lenient.agent,
      status,
      updated: header.updated ?? new Date(0),
      valid: header.valid,
      driveFileId: declaredDriveFileId(header.fields).id,
    };
    notes.push(note);
    inbound.set(file.relativePath, 0);

    if (identityProblem === "Drive identity fields disagree") {
      findings.push(finding("invalid_drive_id", "medium", file.relativePath, null, `${file.relativePath} declares conflicting Drive identities`, { reason: identityProblem }, identityProblem));
    }

    for (const driveKey of ["drive_file_id", "drivefileid", "drive_id", "driveid"]) {
      if (!Object.hasOwn(header.fields, driveKey)) continue;
      const driveId = header.fields[driveKey]!.trim();
      if (!DRIVE_ID_RE.test(driveId)) {
        findings.push(finding(
          "invalid_drive_id",
          "medium",
          file.relativePath,
          header.fieldLines[driveKey] ?? 1,
          `${file.relativePath} declares an invalid Drive file ID`,
          { field: driveKey, recommendation: "Copy the exact Drive file ID without a URL, spaces, or punctuation" },
          `${driveKey}:${driveId}`,
        ));
      }
    }

    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    let fence: "```" | "~~~" | null = null;
    for (let index = 0; index < lines.length; index += 1) {
      if (index + 1 < header.bodyStartLine) continue;
      const trimmed = lines[index]!.trimStart();
      if (fence) {
        if (trimmed.startsWith(fence)) fence = null;
        continue;
      }
      if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
        fence = trimmed.slice(0, 3) as "```" | "~~~";
        continue;
      }
      const match = /^\s*(?:[-*+]\s*)?(?:\[\s\]\s*)?(?:GAP:|\[GAP\])\s*(.*)$/i.exec(lines[index]!);
      if (!match) continue;
      findings.push(finding(
        "open_gap",
        "medium",
        file.relativePath,
        index + 1,
        match[1] ? `Open gap: ${match[1]}` : `Open gap in ${file.relativePath}`,
        { text: match[1] ?? "", recommendation: "Resolve the gap or mark it closed" },
        match[1] ?? "",
      ));
    }
  }

  const notesByPath = new Map(notes.map((note) => [note.path, note]));
  const notesByIdentity = new Map<string, ScannedNote[]>();
  for (const note of notes) if (note.valid && note.driveFileId) notesByIdentity.set(note.driveFileId, [...(notesByIdentity.get(note.driveFileId) ?? []), note]);
  for (const note of notes) {
    for (const link of documentReferences(note.text, note.bodyStartLine)) {
      const target = relativeDocumentTarget(note.path, link.target, link.kind === "wiki", tree.regularFiles);
      if (options.driveLinkMode && !link.image && link.kind !== "definition" && (target.resolved !== null || driveIdFromUrl(link.target) || link.driveFileId !== null)) {
        if (link.driveFileId === null) {
          findings.push(finding("missing_drive_id", "medium", note.path, link.line, `${note.path} has a document reference without a Drive-ID`, { target: link.target }, link.target));
        } else if (!DRIVE_ID_RE.test(link.driveFileId)) {
          findings.push(finding("invalid_drive_id", "medium", note.path, link.line, `${note.path} has an invalid paired Drive-ID`, { target: link.target }, `${link.target}:${link.driveFileId}`));
        } else {
          const byIdentity = notesByIdentity.get(link.driveFileId) ?? [];
          const targetNote = target.resolved ? notesByPath.get(target.resolved) : undefined;
          if (byIdentity.length !== 1) {
            findings.push(finding(byIdentity.length > 1 ? "duplicate_drive_id" : "unresolved_drive_id", "medium", note.path, link.line, `${note.path} refers to an ${byIdentity.length > 1 ? "ambiguous" : "unresolved"} Drive identity`, { driveFileId: link.driveFileId, paths: byIdentity.map((candidate) => candidate.path) }, link.driveFileId));
          }
          if (targetNote?.driveFileId !== link.driveFileId || !target.valid) {
            findings.push(finding("conflicting_drive_id", "high", note.path, link.line, `${note.path} has a path that does not identify its authoritative Drive-ID`, { target: link.target, driveFileId: link.driveFileId, targetDriveFileId: targetNote?.driveFileId ?? null, suggestedPath: byIdentity.length === 1 ? byIdentity[0]!.path : null }, `${link.target}:${link.driveFileId}`));
          }
        }
      }
      if (target.resolved === null) continue;
      if (!target.valid) {
        findings.push(finding(
          "broken_relative_link",
          "medium",
          note.path,
          link.line,
          `${note.path} links to missing ${link.target}`,
          { target: link.target, resolvedPath: target.resolved, recommendation: "Correct the relative path or remove the stale link" },
          link.target,
        ));
      } else if (target.resolved !== note.path && inbound.has(target.resolved)) {
        inbound.set(target.resolved, (inbound.get(target.resolved) ?? 0) + 1);
      }
    }
  }

  const staleBefore = now.getTime() - staleDays * 24 * 60 * 60 * 1_000;
  for (const note of notes) {
    if (isArchived(note)) continue;
    if ((note.status === null || note.status === "active") && note.updated.getTime() > 0 && note.updated.getTime() < staleBefore) {
      findings.push(finding(
        "stale_active_note",
        "medium",
        note.path,
        note.fieldLines.updated ?? 1,
        `${note.path} is active but has not been updated in ${staleDays} days`,
        { updated: note.updated.toISOString(), staleDays, recommendation: "Review the note, update it, or mark it archived or superseded" },
        note.updated.toISOString(),
      ));
    }
    if (!note.valid) continue;
    if ((inbound.get(note.path) ?? 0) === 0) {
      findings.push(finding(
        "orphan_note",
        "low",
        note.path,
        null,
        `${note.path} is not linked from another note`,
        { recommendation: "Link this note from the relevant active note or archive it" },
        "no-inbound-links",
      ));
    }
  }

  findings.sort((a, b) => compareText(a.path, b.path) || (a.line ?? 0) - (b.line ?? 0) || compareText(a.kind, b.kind) || compareText(a.fingerprint, b.fingerprint));
  notes.sort((a, b) => compareText(a.path, b.path));
  if (options.driveLinkMode) {
    const byId = new Map<string, string[]>();
    for (const note of notes) if (note.driveFileId) byId.set(note.driveFileId, [...(byId.get(note.driveFileId) ?? []), note.path]);
    for (const [id, paths] of byId) if (paths.length > 1) findings.push(finding("duplicate_drive_id", "medium", paths[0]!, null, "Multiple notes declare the same Drive identity", { driveFileId: id, paths }, id));
    findings.sort((a, b) => compareText(a.path, b.path) || (a.line ?? 0) - (b.line ?? 0) || compareText(a.kind, b.kind) || compareText(a.fingerprint, b.fingerprint));
  }
  return { filesScanned: tree.markdown.length, findings, notes, regularFiles: tree.regularFiles };
}

export async function validateKnowledgeBase(
  root: string,
  trigger: KnowledgeBaseValidationResult["trigger"],
  options: { now?: Date; staleDays?: number; afterFileOpen?: (relativePath: string) => Promise<void>; driveLinkMode?: boolean; texts?: ReadonlyMap<string, string> } = {},
): Promise<KnowledgeBaseValidationResult> {
  const now = options.now ?? new Date();
  try {
    const inspected = await inspectKnowledgeBase(
      root,
      now,
      options.staleDays ?? DEFAULT_ACTIVE_NOTE_STALE_DAYS,
      options.afterFileOpen,
      options,
    );
    return {
      trigger,
      scannedAt: now.toISOString(),
      filesScanned: inspected.filesScanned,
      findings: inspected.findings,
      error: null,
    };
  } catch (err) {
    return {
      trigger,
      scannedAt: now.toISOString(),
      filesScanned: 0,
      findings: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function markdownLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/\\/g, "\\\\").replace(/([\[\]])/g, "\\$1");
}

function markdownPath(value: string): string {
  return value.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function indexText(companyName: string, notes: ScannedNote[], driveLinkMode = false): string {
  const safeCompanyName = companyName.replace(/\s+/g, " ").trim() || "Company";
  const lines = [
    `# ${safeCompanyName} memories`,
    "",
    "Generated from each note's frontmatter. Run the knowledge-base check before replacing this index.",
    "",
  ];
  for (const note of notes) {
    const scope = note.agent ? ` (agent: ${note.agent})` : "";
    const description = note.description ? ` - ${note.description.replace(/\s+/g, " ").trim()}` : "";
    const identity = driveLinkMode && note.driveFileId ? ` (Drive-ID: ${note.driveFileId})` : "";
    lines.push(`- [${markdownLabel(note.name)}](${markdownPath(note.path)})${identity} [${note.kind}]${scope}${description}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Replace the generated index only when every note has valid frontmatter. */
export async function regenerateKnowledgeBaseIndex(
  root: string,
  companyName: string,
  now: Date = new Date(),
  driveLinkMode = false,
): Promise<KnowledgeBaseIndexResult> {
  const inspected = await inspectKnowledgeBase(root, now, DEFAULT_ACTIVE_NOTE_STALE_DAYS, undefined, { driveLinkMode });
  const malformed = inspected.findings.filter((item) => item.kind === "malformed_frontmatter" || item.kind === "unsafe_entry");
  if (malformed.length > 0) {
    throw new Error(`Index not replaced because ${malformed.length} note or path ${malformed.length === 1 ? "needs" : "need"} attention`);
  }
  const target = path.join(root, INDEX_FILE);
  try {
    const targetStat = await fs.lstat(target);
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) throw new Error("MEMORY.md must be an ordinary file");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const next = indexText(companyName, inspected.notes, driveLinkMode);
  let current: string | null = null;
  try {
    current = (await readMemoryFolderFileSafely(root, target)).text;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (current?.replace(/\r\n?/g, "\n") === next) {
    return { indexedAt: now.toISOString(), filesIndexed: inspected.notes.length, changed: false };
  }
  await writeMemoryFolderFileAtomically(root, target, next);
  return { indexedAt: now.toISOString(), filesIndexed: inspected.notes.length, changed: true };
}
