import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, memories, memoryFolders } from "@paperclipai/db";
import type { DocumentLinkApplyResult, DocumentLinkChange, DocumentLinkPreview, KnowledgeBaseValidationResult } from "@paperclipai/shared";
import { DRIVE_FILE_ID_PATTERN, MEMORY_CONTENT_MAX, documentReferences, driveIdFromUrl } from "@paperclipai/shared";
import { conflict, unprocessable } from "../errors.js";
import { encryptTextAtRest, decryptTextAtRest } from "../secrets/local-encrypted-provider.js";
import { documentLink, documentPath, relativeDocumentTarget } from "./document-links.js";
import { parseMemoryFile } from "./memory-folder-markdown.js";
import { DEFAULT_ACTIVE_NOTE_STALE_DAYS, MEMORY_FOLDER_FILE_MAX_BYTES, inspectKnowledgeBase, readMemoryFolderFileSafely, validateKnowledgeBase, writeMemoryFolderFileAtomically, type Inspection, type ScannedNote } from "./memory-folder-validator.js";

type Folder = typeof memoryFolders.$inferSelect;
interface RootIdentity { real: string; dev: number; ino: number }
interface ApplyItem {
  path: string;
  beforeHash: string;
  afterHash: string;
  afterText: string;
  memory: null | {
    id: string;
    beforeVersion: string;
    beforeHash: string;
    afterHash: string;
    afterContent: string;
    driveFileId: string | null;
    afterVersion: string | null;
  };
}
interface ApplyReceipt {
  version: 1;
  companyId: string;
  folderPath: string;
  root: RootIdentity;
  planHash: string;
  status: "pending" | "completed";
  items: ApplyItem[];
  evidence: Array<{ path: string; hash: string }>;
  memoryEvidence: Array<{ id: string; version: string; hash: string }>;
  result: DocumentLinkApplyResult;
}

const MAX_MIGRATION_BYTES = 8 * 1024 * 1024;
const MAX_MIGRATION_ITEMS = 100;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const normalized = (value: string) => value.replace(/\r\n/g, "\n").trim();
const memoryHash = (content: string, id: string | null) => digest(JSON.stringify([content, id]));

function readReceipt(value: string | null): ApplyReceipt | null {
  if (!value) return null;
  try {
    const plaintext = decryptTextAtRest(value);
    if (Buffer.byteLength(plaintext) > 32 * 1024 * 1024) throw new Error("Oversized receipt");
    const receipt = JSON.parse(plaintext) as ApplyReceipt;
    const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
    const relativePath = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length < 1000 && !value.includes("\\") && !value.includes("\0") && !value.includes(":") && !value.startsWith("/") && !value.split("/").some((part) => part === ".." || part === "." || !part);
    const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
    const iso = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
    if (!receipt || receipt.version !== 1 || !hash(receipt.planHash) || !uuid(receipt.companyId) || typeof receipt.folderPath !== "string" || !path.isAbsolute(receipt.folderPath) || !["pending", "completed"].includes(receipt.status) || !Array.isArray(receipt.items) || receipt.items.length > MAX_MIGRATION_ITEMS || !Array.isArray(receipt.evidence) || receipt.evidence.length > 5000 || !Array.isArray(receipt.memoryEvidence) || receipt.memoryEvidence.length > 5000 || !receipt.root || typeof receipt.root.real !== "string" || !path.isAbsolute(receipt.root.real) || !Number.isFinite(receipt.root.dev) || !Number.isFinite(receipt.root.ino)) throw new Error("Unsupported receipt");
    if (new Set(receipt.items.map((item) => item.path)).size !== receipt.items.length || new Set(receipt.evidence.map((item) => item.path)).size !== receipt.evidence.length) throw new Error("Duplicate receipt paths");
    for (const item of receipt.evidence) if (!relativePath(item.path) || !hash(item.hash)) throw new Error("Invalid evidence");
    for (const item of receipt.memoryEvidence) if (!uuid(item.id) || !iso(item.version) || !hash(item.hash)) throw new Error("Invalid memory evidence");
    for (const item of receipt.items) {
      if (!relativePath(item.path) || !hash(item.beforeHash) || !hash(item.afterHash) || typeof item.afterText !== "string" || Buffer.byteLength(item.afterText) > MEMORY_FOLDER_FILE_MAX_BYTES || digest(item.afterText) !== item.afterHash || receipt.evidence.find((evidence) => evidence.path === item.path)?.hash !== item.beforeHash) throw new Error("Invalid item");
      if (item.memory && (!uuid(item.memory.id) || !iso(item.memory.beforeVersion) || !hash(item.memory.beforeHash) || !hash(item.memory.afterHash) || typeof item.memory.afterContent !== "string" || item.memory.afterContent.length > MEMORY_CONTENT_MAX || (item.memory.driveFileId !== null && (typeof item.memory.driveFileId !== "string" || !DRIVE_FILE_ID_PATTERN.test(item.memory.driveFileId))) || item.memory.afterVersion !== null || memoryHash(item.memory.afterContent, item.memory.driveFileId) !== item.memory.afterHash || parseMemoryFile(item.path, item.afterText).paperclipId !== item.memory.id || normalized(item.memory.afterContent) !== parseMemoryFile(item.path, item.afterText).content)) throw new Error("Invalid memory item");
    }
    if (!receipt.result || receipt.result.planHash !== receipt.planHash || receipt.result.status !== receipt.status || !Number.isInteger(receipt.result.filesChanged) || !Number.isInteger(receipt.result.memoriesChanged) || receipt.result.filesChanged < 0 || receipt.result.memoriesChanged < 0 || !iso(receipt.result.before?.scannedAt) || !Array.isArray(receipt.result.before?.findings) || (receipt.result.after !== null && !Array.isArray(receipt.result.after?.findings))) throw new Error("Invalid result");
    if (receipt.status === "completed" && (receipt.items.length !== 0 || receipt.evidence.length !== 0 || receipt.memoryEvidence.length !== 0 || receipt.result.after === null)) throw new Error("Incomplete result");
    return receipt;
  } catch { throw conflict("The saved link migration receipt cannot be read. Restore its encrypted recovery record before changing this folder."); }
}

export function migrationSummary(value: string | null) {
  const receipt = readReceipt(value);
  return receipt ? { planHash: receipt.planHash, status: receipt.status } : null;
}

export function assertNoPendingLinkMigration(value: string | null): void {
  if (migrationSummary(value)?.status === "pending") throw conflict("A link migration is pending. Retry its apply before syncing or changing the folder.");
}

/** Call while holding this company's folder row lock, before mutating an affected memory. */
export function assertMemoryOutsidePendingMigration(value: string | null, memoryId: string): void {
  const receipt = readReceipt(value);
  if (receipt?.status === "pending" && (receipt.items.some((item) => item.memory?.id === memoryId) || receipt.memoryEvidence.some((item) => item.id === memoryId))) throw conflict("This memory has a pending link migration. Retry its apply before editing or deleting the memory.");
}

async function rootIdentity(root: string): Promise<RootIdentity> {
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw conflict("The memory folder must be an ordinary directory");
  return { real: await fs.realpath(root), dev: stat.dev, ino: stat.ino };
}

async function assertRoot(root: string, expected: RootIdentity) {
  const current = await rootIdentity(root);
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw conflict("The memory folder changed since preview. No further migration writes were made.");
}

function validation(inspected: Inspection, now: Date): KnowledgeBaseValidationResult {
  return { trigger: "manual", scannedAt: now.toISOString(), filesScanned: inspected.filesScanned, findings: inspected.findings, error: null };
}

function rewrite(text: string, note: ScannedNote, inspection: Inspection, targets: { byPath: Map<string, ScannedNote>; byIdentity: Map<string, ScannedNote[]> }): { text: string; changes: DocumentLinkChange[]; skipped: DocumentLinkPreview["skipped"] } {
  const changes: DocumentLinkChange[] = [];
  const skipped: DocumentLinkPreview["skipped"] = [];
  const patches: Array<{ start: number; end: number; value: string }> = [];
  const references = documentReferences(text, text === note.text ? note.bodyStartLine : 1);
  for (const reference of references) {
    if (reference.image || reference.kind === "definition") continue;
    const resolved = relativeDocumentTarget(note.path, reference.target, reference.kind === "wiki", inspection.regularFiles);
    const urlId = driveIdFromUrl(reference.target);
    if (resolved.resolved === null && !urlId && reference.driveFileId === null) continue;
    const skip = (reason: string) => skipped.push({ path: note.path, line: reference.line, reason });
    if (reference.driveFileId !== null && !DRIVE_FILE_ID_PATTERN.test(reference.driveFileId)) { skip("The existing paired Drive-ID is malformed; it was not replaced"); continue; }
    if (urlId && reference.driveFileId && urlId !== reference.driveFileId) { skip("The Drive URL and authoritative paired ID disagree"); continue; }
    const declared = reference.driveFileId ?? urlId;
    let target: ScannedNote | undefined;
    let id = declared;
    if (declared) {
      const candidates = targets.byIdentity.get(declared) ?? [];
      if (candidates.length !== 1) { skip("The authoritative Drive-ID has no unique local target"); continue; }
      target = candidates[0]!;
    } else {
      target = resolved.resolved ? targets.byPath.get(resolved.resolved) : undefined;
      id = target?.driveFileId ?? null;
      if (!target || !id || targets.byIdentity.get(id)?.length !== 1) { skip("The target has no unambiguous declared Drive identity"); continue; }
    }
    const targetMatches = resolved.valid && resolved.resolved === target.path;
    if (reference.kind === "inline" && targetMatches && reference.driveFileId === id) continue;
    let replacement: string;
    const rawTarget = reference.target.replace(/^<|>$/g, "");
    const suffixAt = rawTarget.search(/[?#]/);
    const suffix = !urlId && suffixAt >= 0 ? rawTarget.slice(suffixAt) : "";
    if (reference.kind === "inline" && targetMatches) replacement = `${text.slice(reference.start, reference.end)} (Drive-ID: ${id})`;
    else if (reference.kind === "inline" && reference.targetStart !== null && reference.targetEnd !== null) {
      const repaired = documentPath(note.path, target.path) + suffix;
      const destination = reference.target.startsWith("<") ? `<${repaired}>` : repaired;
      replacement = `${text.slice(reference.start, reference.targetStart)}${destination}${text.slice(reference.targetEnd, reference.end)} (Drive-ID: ${id})`;
    }
    else {
      const label = reference.kind === "wiki" ? reference.label.replace(/\\/g, "\\\\").replace(/([\[\]])/g, "\\$1") : reference.label;
      replacement = documentLink(label, note.path, target.path, id!, suffix);
    }
    patches.push({ start: reference.start, end: reference.markerEnd, value: replacement });
    changes.push({ path: note.path, line: reference.line, target: reference.target, replacement, driveFileId: id!, evidence: declared ? "existing_identity" : "target_frontmatter" });
  }
  let rewritten = text;
  for (const patch of patches.reverse()) rewritten = rewritten.slice(0, patch.start) + patch.value + rewritten.slice(patch.end);
  return { text: rewritten, changes, skipped };
}

async function prepare(db: Pick<Db, "select">, folder: Folder, now: Date, lockMemories = false) {
  if (!folder.driveLinkMode) throw unprocessable("Enable Drive-link mode for this company's folder before previewing a migration");
  const root = await rootIdentity(folder.path);
  const inspection = await inspectKnowledgeBase(folder.path, now, DEFAULT_ACTIVE_NOTE_STALE_DAYS, undefined, { driveLinkMode: true });
  const query = db.select().from(memories).where(eq(memories.companyId, folder.companyId));
  const rows = await (lockMemories ? query.for("update") : query);
  const companyAgents = await db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.companyId, folder.companyId));
  const byId = new Map(rows.map((row) => [row.id, { ...row, content: decryptTextAtRest(row.content) }]));
  const skipped: DocumentLinkPreview["skipped"] = [];
  const memoryFiles = new Map<string, number>();
  for (const note of inspection.notes) {
    const id = parseMemoryFile(note.path, note.text).paperclipId;
    if (id) memoryFiles.set(id, (memoryFiles.get(id) ?? 0) + 1);
  }
  const eligible = inspection.notes.filter((note) => {
    const parsed = parseMemoryFile(note.path, note.text);
    const memory = parsed.paperclipId ? byId.get(parsed.paperclipId) : null;
    const namedAgents = parsed.agent ? companyAgents.filter((agent) => agent.name.trim().toLowerCase() === parsed.agent!.trim().toLowerCase()) : [];
    const agentAgrees = memory && (parsed.agent ? namedAgents.length === 1 && namedAgents[0]!.id === memory.agentId : memory.agentId === null);
    const metadataAgrees = !memory || (parsed.name === memory.name && parsed.kind === memory.kind && parsed.description === memory.description && agentAgrees);
    if (!note.valid || (parsed.paperclipId && (!memory || memoryFiles.get(parsed.paperclipId)! > 1)) || !metadataAgrees || (memory && normalized(memory.content) !== parsed.content) || (memory?.driveFileId && memory.driveFileId !== note.driveFileId)) {
      skipped.push({ path: note.path, line: null, reason: "Malformed note, unknown company memory, or file/database evidence disagreement; import or resolve it before migration" });
      return false;
    }
    return true;
  });
  const changes: DocumentLinkChange[] = [];
  const targets = { byPath: new Map(eligible.map((note) => [note.path, note])), byIdentity: new Map<string, ScannedNote[]>() };
  for (const note of eligible) if (note.driveFileId) targets.byIdentity.set(note.driveFileId, [...(targets.byIdentity.get(note.driveFileId) ?? []), note]);
  const items: ApplyItem[] = [];
  const afterTexts = new Map<string, string>();
  for (const note of eligible) {
    const rewritten = rewrite(note.text, note, inspection, targets);
    if (Buffer.byteLength(rewritten.text) > MEMORY_FOLDER_FILE_MAX_BYTES) throw unprocessable(`Migrating ${note.path} would exceed the ${MEMORY_FOLDER_FILE_MAX_BYTES}-byte note limit; shorten the note first`);
    changes.push(...rewritten.changes);
    skipped.push(...rewritten.skipped);
    afterTexts.set(note.path, rewritten.text);
    const parsed = parseMemoryFile(note.path, note.text);
    const memory = parsed.paperclipId ? byId.get(parsed.paperclipId) : null;
    const afterContent = memory ? rewrite(memory.content, note, inspection, targets).text : null;
    if (afterContent !== null && afterContent.length > MEMORY_CONTENT_MAX) {
      throw unprocessable(`Migrating ${note.path} would exceed the memory content limit; shorten the note first`);
    }
    const memoryChanged = memory && (afterContent !== memory.content || (memory.driveFileId ?? null) !== note.driveFileId);
    if (rewritten.text !== note.text || memoryChanged) items.push({
      path: note.path, beforeHash: digest(note.text), afterHash: digest(rewritten.text), afterText: rewritten.text,
      memory: memoryChanged && memory ? { id: memory.id, beforeVersion: memory.updatedAt.toISOString(), beforeHash: memoryHash(memory.content, memory.driveFileId), afterHash: memoryHash(afterContent!, note.driveFileId), afterContent: afterContent!, driveFileId: note.driveFileId, afterVersion: null } : null,
    });
  }
  if (items.length > MAX_MIGRATION_ITEMS || Buffer.byteLength(JSON.stringify(items)) > MAX_MIGRATION_BYTES) throw unprocessable("The migration exceeds its recovery limit (100 changed notes or 8 MiB). Split the knowledge base before applying.");
  const evidence = inspection.notes.map((note) => ({ path: note.path, hash: digest(note.text) }));
  const memoryEvidence = eligible.filter((note) => note.driveFileId).flatMap((note) => {
    const id = parseMemoryFile(note.path, note.text).paperclipId;
    const row = id ? byId.get(id) : null;
    return row ? [{ id: row.id, version: row.updatedAt.toISOString(), hash: memoryHash(row.content, row.driveFileId) }] : [];
  });
  const source = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)).map((row) => [row.id, row.updatedAt.toISOString(), memoryHash(row.content, row.driveFileId)]);
  const planHash = digest(JSON.stringify([1, folder.companyId, folder.path, folder.driveLinkMode, root, evidence, [...inspection.regularFiles].sort(), source, items]));
  const before = validation(inspection, now);
  const after = await validateKnowledgeBase(folder.path, "manual", { now, driveLinkMode: true, texts: afterTexts });
  await assertRoot(folder.path, root);
  const preview: DocumentLinkPreview = { planHash, memoriesChanged: items.filter((item) => item.memory).length, changes, skipped, before, after };
  return { preview, items, evidence, memoryEvidence, root };
}

async function persistReceipt(tx: Pick<Db, "update">, companyId: string, receipt: ApplyReceipt) {
  const serialized = JSON.stringify(receipt);
  if (Buffer.byteLength(serialized) > 32 * 1024 * 1024) throw unprocessable("The migration recovery record exceeds 32 MiB. Resolve findings or split the folder before applying.");
  const encrypted = encryptTextAtRest(serialized);
  readReceipt(encrypted);
  await tx.update(memoryFolders).set({ linkMigration: encrypted }).where(eq(memoryFolders.companyId, companyId));
}

export function documentLinkMigrationService(db: Db, hooks: { beforeReceiptPersist?: () => Promise<void>; afterReceiptPersist?: () => Promise<void>; afterFileWrite?: (path: string) => Promise<void> } = {}) {
  return {
    previewLinks: async (companyId: string): Promise<DocumentLinkPreview> => {
      const [folder] = await db.select().from(memoryFolders).where(eq(memoryFolders.companyId, companyId));
      if (!folder) throw unprocessable("No memory folder is configured for this company");
      assertNoPendingLinkMigration(folder.linkMigration);
      return (await prepare(db, folder, new Date())).preview;
    },
    applyLinks: async (companyId: string, planHash: string): Promise<DocumentLinkApplyResult> => {
      // Commit recovery data before the first filesystem change.
      await db.transaction(async (tx) => {
        const [folder] = await tx.select().from(memoryFolders).where(eq(memoryFolders.companyId, companyId)).for("update");
        if (!folder) throw unprocessable("No memory folder is configured for this company");
        const existing = readReceipt(folder.linkMigration);
        if (existing?.planHash === planHash) return;
        assertNoPendingLinkMigration(folder.linkMigration);
        const prepared = await prepare(tx, folder, new Date(), true);
        if (prepared.preview.planHash !== planHash) throw conflict("The folder or memory evidence changed since preview. Preview again before applying.");
        if (prepared.preview.before.findings.some((finding) => finding.kind === "unsafe_entry") || prepared.preview.after.error) throw conflict("Resolve unsafe entries or validation errors before applying a migration");
        const previousFindings = new Set(prepared.preview.before.findings.map((finding) => finding.fingerprint));
        if (prepared.preview.after.findings.some((finding) => !previousFindings.has(finding.fingerprint))) throw conflict("The proposed migration adds validation findings. Resolve them and preview again before applying.");
        await hooks.beforeReceiptPersist?.();
        await persistReceipt(tx, companyId, { version: 1, companyId, folderPath: folder.path, root: prepared.root, planHash, status: "pending", items: prepared.items, evidence: prepared.evidence, memoryEvidence: prepared.memoryEvidence,
          result: { planHash, status: "pending", filesChanged: prepared.items.filter((item) => item.beforeHash !== item.afterHash).length, memoriesChanged: prepared.items.filter((item) => item.memory).length, before: prepared.preview.before, after: null } });
      });
      await hooks.afterReceiptPersist?.();
      return db.transaction(async (tx) => {
        const [folder] = await tx.select().from(memoryFolders).where(eq(memoryFolders.companyId, companyId)).for("update");
        if (!folder) throw conflict("The configured memory folder was removed during apply");
        const receipt = readReceipt(folder.linkMigration);
        if (!receipt || receipt.companyId !== companyId || receipt.planHash !== planHash || receipt.folderPath !== folder.path || !folder.driveLinkMode) throw conflict("The stored migration does not match this company and folder");
        if (receipt.status === "completed") return receipt.result;
        await assertRoot(folder.path, receipt.root);
        // Validate every item and all target evidence before any further writes.
        const currentInspection = await inspectKnowledgeBase(folder.path, new Date(), DEFAULT_ACTIVE_NOTE_STALE_DAYS, undefined, { driveLinkMode: true });
        if (currentInspection.findings.some((finding) => finding.kind === "unsafe_entry")) throw conflict("The folder contains unsafe paths; no further migration writes were made");
        const currentNotes = new Map(currentInspection.notes.map((note) => [note.path, digest(note.text)]));
        if (currentNotes.size !== receipt.evidence.length) throw conflict("The note set changed during migration");
        for (const evidence of receipt.evidence) {
          const item = receipt.items.find((entry) => entry.path === evidence.path);
          const hash = currentNotes.get(evidence.path);
          if (hash !== evidence.hash && hash !== item?.afterHash) throw conflict(`The note ${evidence.path} changed during migration. Its edits were preserved.`);
        }
        const lockedRows = await tx.select().from(memories).where(eq(memories.companyId, companyId)).for("update");
        const currentRows = new Map(lockedRows.map((row) => [row.id, row]));
        for (const evidence of receipt.memoryEvidence) {
          const current = currentRows.get(evidence.id);
          if (!current || current.updatedAt.toISOString() !== evidence.version || memoryHash(decryptTextAtRest(current.content), current.driveFileId) !== evidence.hash) throw conflict("A declared target memory changed during migration. Its edits were preserved.");
        }
        for (const item of receipt.items) {
          if (!item.memory) continue;
          const current = currentRows.get(item.memory.id);
          const expectedVersion = item.memory.afterVersion ?? item.memory.beforeVersion;
          const expectedHash = item.memory.afterVersion ? item.memory.afterHash : item.memory.beforeHash;
          if (!current || current.updatedAt.toISOString() !== expectedVersion || memoryHash(decryptTextAtRest(current.content), current.driveFileId) !== expectedHash) throw conflict(`The memory for ${item.path} changed during migration. Its edits were preserved.`);
        }
        for (const item of receipt.items) {
          const full = path.join(folder.path, ...item.path.split("/"));
          const current = (await readMemoryFolderFileSafely(folder.path, full)).text;
          const hash = digest(current);
          if (hash !== item.beforeHash && hash !== item.afterHash) throw conflict(`The note ${item.path} changed before its write. Its edits were preserved.`);
          if (hash !== item.afterHash) {
            await assertRoot(folder.path, receipt.root);
            await writeMemoryFolderFileAtomically(path.dirname(full), full, item.afterText);
            await hooks.afterFileWrite?.(item.path);
            if (digest((await readMemoryFolderFileSafely(folder.path, full)).text) !== item.afterHash) throw conflict(`The note ${item.path} changed after its migration write`);
          }
          if (item.memory && !item.memory.afterVersion) {
            const updatedAt = new Date();
            await tx.update(memories).set({ content: encryptTextAtRest(item.memory.afterContent), driveFileId: item.memory.driveFileId, updatedAt }).where(and(eq(memories.id, item.memory.id), eq(memories.companyId, companyId)));
            item.memory.afterVersion = updatedAt.toISOString();
          }
        }
        for (const item of receipt.items) {
          const full = path.join(folder.path, ...item.path.split("/"));
          if (digest((await readMemoryFolderFileSafely(folder.path, full)).text) !== item.afterHash) throw conflict(`The note ${item.path} changed before migration completion. Its edits were preserved.`);
        }
        await assertRoot(folder.path, receipt.root);
        // DB writes and the completed receipt commit together. On a crash, exact after-file bytes
        // plus the unchanged DB version allow the same pending receipt to finish safely.
        receipt.result.after = await validateKnowledgeBase(folder.path, "manual", { driveLinkMode: true, now: new Date(receipt.result.before.scannedAt) });
        const previousFindings = new Set(receipt.result.before.findings.map((finding) => finding.fingerprint));
        if (receipt.result.after.error || receipt.result.after.findings.some((finding) => !previousFindings.has(finding.fingerprint))) throw conflict("Validation changed during apply. The pending migration must be reviewed before retrying.");
        receipt.status = "completed";
        receipt.result.status = "completed";
        receipt.items = [];
        receipt.evidence = [];
        receipt.memoryEvidence = [];
        await persistReceipt(tx, companyId, receipt);
        return receipt.result;
      });
    },
  };
}
