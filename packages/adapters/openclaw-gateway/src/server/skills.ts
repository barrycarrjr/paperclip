import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterSkillContext } from "@paperclipai/adapter-utils";
import {
  buildEphemeralProcedureSkillSnapshot,
  loadEphemeralProcedures,
  renderEphemeralProcedureContext,
  requireCompleteEphemeralProcedures,
} from "@paperclipai/adapter-utils/ephemeral-skills";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export async function loadProcedureContext(config: Record<string, unknown>) {
  const bundle = await loadEphemeralProcedures(config, moduleDir);
  requireCompleteEphemeralProcedures(bundle);
  return renderEphemeralProcedureContext(bundle.procedures);
}

export function listSkills(ctx: AdapterSkillContext) {
  return buildEphemeralProcedureSkillSnapshot(ctx, moduleDir, {
    applicationDetail: "Complete supported company procedure text is included in the next OpenClaw wake message. Paperclip does not inspect or install skills on the gateway host.",
    warnings: ["Remote installed skills and tool availability are not reported by this adapter."],
  });
}

export function syncSkills(ctx: AdapterSkillContext, _desiredSkills: string[]) {
  return listSkills(ctx);
}
