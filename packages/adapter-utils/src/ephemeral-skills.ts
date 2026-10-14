import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { AdapterSkillContext, AdapterSkillSnapshot } from "./types.js";
import { readPaperclipRuntimeSkillEntries, resolvePaperclipDesiredSkillNames, type PaperclipSkillEntry } from "./server-utils.js";

export const EPHEMERAL_PROCEDURE_LIMITS = { procedures: 8, files: 64, depth: 4, fileBytes: 65_536, totalBytes: 131_072 };
export interface EphemeralProcedure { key: string; runtimeName: string; files: Array<{ path: string; content: string }>; bytes: number }
export interface EphemeralProcedureBundle {
  availableEntries: PaperclipSkillEntry[]; desiredSkills: string[]; requestedKeys: string[];
  procedures: EphemeralProcedure[]; errors: Array<{ key: string; code: string; message: string }>;
}
export class EphemeralProcedureError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = "EphemeralProcedureError"; }
}
const fail = (message: string): never => { throw new EphemeralProcedureError("procedure_incomplete", message); };
const bundled = (entry: PaperclipSkillEntry) => entry.key.startsWith("paperclipai/paperclip/");
const textExtensions = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".csv", ".tsv", ".xml", ".html"]);

async function readProcedure(entry: PaperclipSkillEntry, budget: { bytes: number; files: number }): Promise<EphemeralProcedure> {
  const source = path.resolve(entry.source);
  if ((await fs.lstat(source)).isSymbolicLink()) fail("Procedure source must be a real directory, not a link.");
  const root = await fs.realpath(source);
  const files: EphemeralProcedure["files"] = [];
  async function visit(relative: string, depth: number): Promise<void> {
    if (depth > EPHEMERAL_PROCEDURE_LIMITS.depth) fail("Procedure directory depth exceeds the supported limit.");
    const directory = path.join(root, relative);
    const entries = await fs.opendir(directory);
    for await (const item of entries) {
      const rel = path.join(relative, item.name);
      const absolute = path.join(root, rel);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) fail("Procedure contains a linked resource; complete loading cannot be verified.");
      if (++budget.files > EPHEMERAL_PROCEDURE_LIMITS.files) fail("Procedure resource count exceeds the supported limit.");
      if (stat.isDirectory()) { await visit(rel, depth + 1); continue; }
      if (!stat.isFile() || !textExtensions.has(path.extname(rel).toLowerCase())) fail("Procedure contains a script, binary, or unsupported resource. This adapter loads text only.");
      const canonical = await fs.realpath(absolute);
      const within = path.relative(root, canonical);
      if (within.startsWith("..") || path.isAbsolute(within)) fail("Procedure resource escapes its source directory.");
      const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let bytes: Buffer;
      try {
        const before = await handle.stat();
        if (!before.isFile()) fail("Procedure resource is not a regular text file.");
        if (before.dev !== stat.dev || before.ino !== stat.ino || before.size !== stat.size || before.mtimeMs !== stat.mtimeMs) fail("Procedure changed while it was being opened. Retry with a stable source.");
        const openedPath = path.relative(root, await fs.realpath(absolute));
        if (openedPath.startsWith("..") || path.isAbsolute(openedPath)) fail("Procedure resource escapes its source directory.");
        const buffer = Buffer.alloc(EPHEMERAL_PROCEDURE_LIMITS.fileBytes + 1);
        let count = 0;
        while (count < buffer.length) {
          const read = await handle.read(buffer, count, buffer.length - count, count);
          if (!read.bytesRead) break;
          count += read.bytesRead;
        }
        if (count > EPHEMERAL_PROCEDURE_LIMITS.fileBytes) fail("Procedure text exceeds the per-file limit.");
        const after = await handle.stat();
        if (count !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail("Procedure changed while it was being read. Retry with a stable source.");
        bytes = buffer.subarray(0, count);
      } finally { await handle.close(); }
      budget.bytes += bytes.length;
      if (budget.bytes > EPHEMERAL_PROCEDURE_LIMITS.totalBytes) fail("Complete procedure text exceeds the total limit.");
      let content: string;
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail("Procedure resources must contain valid UTF-8 text."); }
      if (content!.includes("\0")) fail("Procedure contains a binary resource.");
      files.push({ path: rel.split(path.sep).join("/"), content: content! });
    }
  }
  await visit("", 0);
  files.sort((left, right) => left.path === "SKILL.md" ? -1 : right.path === "SKILL.md" ? 1 : left.path.localeCompare(right.path));
  if (!files.some(file => file.path === "SKILL.md")) fail("Procedure SKILL.md is missing.");
  const paths = new Set(files.map(file => file.path));
  for (const file of files) {
    // Local Markdown links and conventional backtick resource paths must resolve
    // inside this complete text bundle. Web citations do not imply web access.
    const references = [...file.content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1]!.split(/\s+["']/)[0]!);
    references.push(...[...file.content.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(<[^>]+>|\S+)/gm)].map(match => match[1]!));
    references.push(...[...file.content.matchAll(/`((?:references|resources|scripts|assets)\/[^`\s]+)`/g)].map(match => match[1]!));
    for (const raw of references) {
      const target = raw.replace(/^<|>$/g, "");
      if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
      let reference: string;
      try { reference = decodeURIComponent(target.split("#")[0]!); } catch { fail("Procedure contains an invalid resource reference."); }
      if (!reference!) continue;
      if (path.isAbsolute(reference!) || /^[a-z]+:/i.test(reference!) || reference!.includes("\\")) fail("Procedure references an unavailable or escaping resource.");
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), reference!));
      if (resolved.startsWith("../") || !paths.has(resolved)) fail("Procedure references a missing or unsupported local resource.");
    }
  }
  return { key: entry.key, runtimeName: entry.runtimeName, files, bytes: files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) };
}

export async function loadEphemeralProcedures(config: Record<string, unknown>, moduleDir: string): Promise<EphemeralProcedureBundle> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const requestedKeys = desiredSkills.filter(key => !availableEntries.some(entry => entry.key === key && bundled(entry)));
  const bundle: EphemeralProcedureBundle = { availableEntries, desiredSkills, requestedKeys, procedures: [], errors: [] };
  const budget = { bytes: 0, files: 0 };
  for (const key of requestedKeys) {
    const entry = availableEntries.find(candidate => candidate.key === key);
    try {
      if (requestedKeys.length > EPHEMERAL_PROCEDURE_LIMITS.procedures) fail("Too many attached procedures for complete loading.");
      if (!entry) fail("The selected procedure is unavailable.");
      bundle.procedures.push(await readProcedure(entry!, budget));
    } catch (error) {
      bundle.errors.push({ key, code: "procedure_incomplete", message: error instanceof EphemeralProcedureError ? error.message : "Procedure files could not be read completely. Check the company procedure source." });
    }
  }
  return bundle;
}
export function requireCompleteEphemeralProcedures(bundle: EphemeralProcedureBundle): void {
  if (bundle.errors.length) throw new EphemeralProcedureError(bundle.errors[0]!.code, bundle.errors[0]!.message);
}
export function renderEphemeralProcedureContext(procedures: EphemeralProcedure[]): string {
  if (!procedures.length) return "";
  return "Attached company procedures (complete text context; this does not add tools or script execution):\n" + procedures.map(procedure =>
    `Procedure ${procedure.key}\n` + procedure.files.map(file => `Resource ${file.path}\n${file.content}`).join("\n\n")).join("\n\n");
}
export async function buildEphemeralProcedureSkillSnapshot(ctx: AdapterSkillContext, moduleDir: string, options: { applicationDetail: string; warnings?: string[] }): Promise<AdapterSkillSnapshot> {
  const bundle = await loadEphemeralProcedures(ctx.config, moduleDir);
  return { adapterType: ctx.adapterType, supported: true, mode: "ephemeral", desiredSkills: bundle.desiredSkills,
    warnings: [...(options.warnings ?? []), ...bundle.errors.map(error => error.message)],
    entries: [...bundle.availableEntries, ...bundle.requestedKeys.filter(key => !bundle.availableEntries.some(entry => entry.key === key)).map((key): PaperclipSkillEntry => ({ key, runtimeName: key, source: "" }))].map(entry => {
      const error = bundle.errors.find(error => error.key === entry.key);
      const selected = bundle.requestedKeys.includes(entry.key);
      return { key: entry.key, runtimeName: entry.runtimeName, desired: bundle.desiredSkills.includes(entry.key), managed: true, required: entry.required,
        requiredReason: entry.requiredReason, state: error ? "missing" : selected ? "configured" : "available", origin: bundled(entry) ? undefined : "company_managed", originLabel: bundled(entry) ? "Native Paperclip instructions" : "Company procedure",
        sourcePath: null, targetPath: null, detail: error?.message ?? (bundled(entry) ? "Uses the existing native wake contract. The bundled skill body is not newly loaded." : selected ? options.applicationDetail : "Available company procedure, not attached to this agent.") };
    }) };
}
