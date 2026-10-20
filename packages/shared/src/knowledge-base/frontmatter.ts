import { MEMORY_DESCRIPTION_MAX, MEMORY_KINDS, MEMORY_NAME_MAX } from "../validators/memory.js";
import { declaredDriveFileId } from "../validators/document-links.js";

const NOTE_STATUSES = new Set(["active", "superseded", "archived"]);

interface StrictFrontmatter {
  fields: Record<string, string>;
  lines: Record<string, number>;
  problems: string[];
  bodyStartLine: number;
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
