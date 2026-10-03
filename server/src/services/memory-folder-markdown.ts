import path from "node:path";
import type { Memory, MemoryKind } from "@paperclipai/shared";
import { MEMORY_KINDS } from "@paperclipai/shared";

/**
 * Pure helpers for the on-disk shape of a company's memory folder.
 *
 * One Markdown file per memory, with a small front-matter block, plus a
 * `MEMORY.md` index. The format is deliberately plain so any AI tool or
 * person can read and edit it without Paperclip.
 */

export const INDEX_FILE = "MEMORY.md";

export interface MemoryFileFrontMatter {
  name: string;
  kind: MemoryKind;
  description: string | null;
  /** Agent name when the memory is scoped to one agent, else null. */
  agent: string | null;
  /** Memory id when the file was written by Paperclip, else null. */
  paperclipId: string | null;
}

export interface ParsedMemoryFile extends MemoryFileFrontMatter {
  content: string;
}

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug.length > 0 ? slug : "memory";
}

/**
 * Stable file name for a memory. Agent-scoped memories get the agent's name
 * appended because the same memory name may exist once per agent.
 */
export function memoryFileName(memory: Pick<Memory, "name">, agentName: string | null): string {
  const base = slugify(memory.name);
  return agentName ? `${base}--${slugify(agentName)}.md` : `${base}.md`;
}

function yamlScalar(value: string): string {
  // Quote anything YAML could misread; keep simple words bare for readability.
  if (/^[A-Za-z0-9_][A-Za-z0-9_ .-]*$/.test(value) && !/^(true|false|null|yes|no)$/i.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

export function serializeMemoryFile(memory: Memory, agentName: string | null): string {
  const lines = [
    "---",
    `name: ${yamlScalar(memory.name)}`,
    `kind: ${memory.kind}`,
  ];
  if (memory.description) lines.push(`description: ${yamlScalar(memory.description)}`);
  if (agentName) lines.push(`agent: ${yamlScalar(agentName)}`);
  lines.push(`paperclip_id: ${memory.id}`);
  lines.push(`updated: ${new Date(memory.updatedAt).toISOString()}`);
  lines.push("---", "", memory.content.replace(/\r\n/g, "\n").trimEnd(), "");
  return lines.join("\n");
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isMemoryKind(value: string): value is MemoryKind {
  return (MEMORY_KINDS as readonly string[]).includes(value);
}

/**
 * Parse a memory file. Front matter is optional: a bare Markdown file becomes
 * a company-wide `reference` memory named after the file.
 */
export function parseMemoryFile(fileName: string, text: string): ParsedMemoryFile {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const fallbackName = path.basename(fileName, path.extname(fileName));
  let body = normalized;
  const fields: Record<string, string> = {};

  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  if (match) {
    body = normalized.slice(match[0].length);
    for (const line of match[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      fields[key] = unquote(line.slice(idx + 1));
    }
  }

  const name = (fields.name ?? "").trim() || fallbackName;
  const kindRaw = (fields.kind ?? "").trim().toLowerCase();
  const kind: MemoryKind = isMemoryKind(kindRaw) ? kindRaw : "reference";
  const description = (fields.description ?? "").trim() || null;
  const agent = (fields.agent ?? "").trim() || null;
  const idRaw = (fields.paperclip_id ?? fields.paperclipid ?? "").trim();
  const paperclipId = /^[0-9a-f-]{36}$/i.test(idRaw) ? idRaw : null;

  return { name, kind, description, agent, paperclipId, content: body.trim() };
}

/**
 * Files the import must leave alone: the index, hidden files, and the
 * duplicate copies that Google Drive, Dropbox and OneDrive leave behind
 * when two machines edit the same file.
 */
export function isSkippedFileName(fileName: string): boolean {
  if (!fileName.toLowerCase().endsWith(".md")) return true;
  if (fileName.startsWith(".") || fileName.startsWith("~$")) return true;
  if (fileName === INDEX_FILE || fileName.toLowerCase() === "readme.md") return true;
  if (/conflicted copy/i.test(fileName)) return true;
  if (/\(conflict(ed)?( \d+)?\)/i.test(fileName)) return true;
  if (/-[A-Za-z0-9-]+'s conflicted/i.test(fileName)) return true;
  return false;
}

export interface IndexEntry {
  fileName: string;
  name: string;
  kind: MemoryKind;
  description: string | null;
  agentName: string | null;
}

export function serializeIndex(companyName: string, entries: IndexEntry[]): string {
  const lines = [
    `# ${companyName} memories`,
    "",
    "One file per memory. Edit a file or add a new `.md` file here and Paperclip imports it on the next sync.",
    "",
  ];
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sorted) {
    const scope = entry.agentName ? ` (agent: ${entry.agentName})` : "";
    const desc = entry.description ? ` - ${entry.description}` : "";
    lines.push(`- [${entry.name}](${entry.fileName}) [${entry.kind}]${scope}${desc}`);
  }
  lines.push("");
  return lines.join("\n");
}
