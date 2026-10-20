import path from "node:path";
import {
  documentLink as sharedDocumentLink,
  documentPath as sharedDocumentPath,
  relativeDocumentTarget as sharedRelativeDocumentTarget,
} from "@paperclipai/shared";

export { documentReferences, driveIdFromUrl } from "@paperclipai/shared";
export type { DocumentReference } from "@paperclipai/shared";

// Keep host filesystem case and working-directory semantics at the server boundary.
export function relativeDocumentTarget(notePath: string, raw: string, wiki: boolean, files: Map<string, string>): { resolved: string | null; valid: boolean } {
  return sharedRelativeDocumentTarget(notePath, raw, wiki, files, process.platform === "win32");
}

export function documentPath(source: string, target: string): string {
  return sharedDocumentPath(source, target, path.posix.resolve("."));
}

export function documentLink(label: string, source: string, target: string, id: string, suffix = ""): string {
  return sharedDocumentLink(label, source, target, id, suffix, path.posix.resolve("."));
}
