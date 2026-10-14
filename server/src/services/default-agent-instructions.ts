import { appendSourceEvidenceInstructions } from "@paperclipai/adapter-utils/source-evidence";
import fs from "node:fs/promises";

const DEFAULT_AGENT_BUNDLE_FILES = {
  default: ["AGENTS.md"],
  ceo: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
} as const;

const SHARED_REFERENCE_FILES = [
  "references/coordination.md",
  "references/capabilities.md",
  "references/messaging.md",
  "references/memory.md",
] as const;

type DefaultAgentBundleRole = keyof typeof DEFAULT_AGENT_BUNDLE_FILES;

function resolveDefaultAgentBundleUrl(role: DefaultAgentBundleRole | "shared", fileName: string) {
  return new URL(`../onboarding-assets/${role}/${fileName}`, import.meta.url);
}

export async function loadDefaultAgentInstructionsBundle(role: DefaultAgentBundleRole): Promise<Record<string, string>> {
  const core = await fs.readFile(resolveDefaultAgentBundleUrl("shared", "CORE.md"), "utf8");
  const fileNames = [...DEFAULT_AGENT_BUNDLE_FILES[role], ...SHARED_REFERENCE_FILES,
    ...(role === "ceo" ? ["references/leadership.md"] : [])];
  const entries = await Promise.all(
    fileNames.map(async (fileName) => {
      const sourceRole = SHARED_REFERENCE_FILES.some((reference) => reference === fileName) ? "shared" : role;
      const content = await fs.readFile(resolveDefaultAgentBundleUrl(sourceRole, fileName), "utf8");
      return [fileName, fileName === "AGENTS.md" ? appendSourceEvidenceInstructions(`${content}\n${core}`) : content] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export function resolveDefaultAgentInstructionsBundleRole(role: string): DefaultAgentBundleRole {
  return role === "ceo" ? "ceo" : "default";
}
