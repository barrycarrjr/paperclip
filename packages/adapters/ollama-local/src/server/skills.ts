import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterSkillContext } from "@paperclipai/adapter-utils";
import { buildEphemeralProcedureSkillSnapshot, EphemeralProcedureError } from "@paperclipai/adapter-utils/ephemeral-skills";
export const procedureModuleDir = path.dirname(fileURLToPath(import.meta.url));
export function listSkills(ctx: AdapterSkillContext) {
  return buildEphemeralProcedureSkillSnapshot(ctx, procedureModuleDir, {
    applicationDetail: "Complete attached procedure text is sent next run after observed model context admission. No tools are added.",
    warnings: ["Text only. Attached procedures require a running model with verifiable context and Ollama 0.14.0 or newer. Nothing is persistently installed."],
  });
}
export function syncSkills(ctx: AdapterSkillContext, _desiredSkills: string[]) { return listSkills(ctx); }

/** Runtime observation is not a reservation. The provider must also refuse truncation. */
export async function assertOllamaProtectedContext(baseUrl: string, model: string, contents: string[], numPredict: number): Promise<void> {
  async function get(endpoint: string): Promise<Record<string, unknown>> {
    try {
      const response = await fetch(`${baseUrl}${endpoint}`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error();
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    } catch { throw new EphemeralProcedureError("procedure_context_unknown", "Cannot verify the running Ollama model context. Start the selected model with a suitable context before retrying; Paperclip will not warm it or increase GPU memory."); }
  }
  const version = await get("/api/version");
  const match = typeof version.version === "string" ? /^(\d+)\.(\d+)\.(\d+)$/.exec(version.version) : null;
  if (!match || (Number(match[1]) === 0 && Number(match[2]) < 14)) throw new EphemeralProcedureError("procedure_context_unknown", "Protected instructions require Ollama 0.14.0 or newer with supported no-truncation controls.");
  const running = await get("/api/ps");
  const normalize = (name: string) => name.includes(":") ? name : `${name}:latest`;
  const matches = Array.isArray(running.models) ? running.models.filter(item => {
    if (!item || typeof item !== "object") return false;
    const row = item as Record<string, unknown>;
    return [row.name, row.model].some(name => typeof name === "string" && normalize(name) === normalize(model));
  }) as Record<string, unknown>[] : [];
  const contextLength = matches.length === 1 ? matches[0]!.context_length : null;
  if (typeof contextLength !== "number" || !Number.isSafeInteger(contextLength) || contextLength <= 0) throw new EphemeralProcedureError("procedure_context_unknown", "The selected model is cold or its running context is unknown. Start it with enough context and retry; Paperclip will not load it or increase GPU memory for protected instructions.");
  // One token per UTF-8 byte plus template allowance is deliberately conservative,
  // not an exact tokenizer measurement. The provider's actual refusal is authoritative.
  const required = contents.reduce((sum, content) => sum + Buffer.byteLength(content), 0) + 1024 + (numPredict > 0 ? Math.ceil(numPredict) : 512);
  if (required > contextLength) throw new EphemeralProcedureError("procedure_context_too_small", "Complete approved rules, corrections, attached procedures, and the full prompt exceed the observed model context allowance. Use a suitable running model or reduce the protected context; Paperclip will not truncate it or increase GPU memory.");
}
