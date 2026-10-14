import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterSkillContext } from "@paperclipai/adapter-utils";
import { buildEphemeralProcedureSkillSnapshot, type EphemeralProcedure } from "@paperclipai/adapter-utils/ephemeral-skills";
export const procedureModuleDir = path.dirname(fileURLToPath(import.meta.url));
export function listSkills(ctx: AdapterSkillContext) {
  return buildEphemeralProcedureSkillSnapshot(ctx, procedureModuleDir, { applicationDetail: "Complete text is staged outside the workspace and passed to Aider as read-only files next local run.", warnings: ["Local text resources only. No persistent skill installation or remote environment support." ] });
}
export function syncSkills(ctx: AdapterSkillContext, _desiredSkills: string[]) { return listSkills(ctx); }
export async function stageAiderProcedures(procedures: EphemeralProcedure[]): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
  if (!procedures.length) return { paths: [], cleanup: async () => {} };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-aider-procedures-"));
  const cleanup = async () => { await fs.rm(directory, { recursive: true, force: true }); };
  const paths: string[] = [];
  try {
    for (const [index, procedure] of procedures.entries()) for (const file of procedure.files) {
      const destination = path.join(directory, String(index), file.path);
      const relative = path.relative(directory, destination);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Invalid staged procedure path.");
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, file.content, { mode: 0o600, flag: "wx" });
      paths.push(destination);
    }
    return { paths, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
