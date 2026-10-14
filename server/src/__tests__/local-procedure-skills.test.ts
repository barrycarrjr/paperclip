import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getServerAdapter } from "../adapters/registry.js";
import { agentSkillSnapshotSchema } from "@paperclipai/shared/validators/adapter-skills";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
describe("registered ephemeral procedure adapters", () => {
  it.each(["ollama_local", "aider_local", "openclaw_gateway", "hermes_gateway", "cursor_cloud"])("%s reports complete configured text without claiming install", async type => {
    const source = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-registry-procedure-")); roots.push(source);
    await fs.writeFile(path.join(source, "SKILL.md"), "Complete procedure.");
    const adapter = getServerAdapter(type);
    expect(adapter.requiresMaterializedRuntimeSkills).toBe(true);
    const config = { paperclipRuntimeSkills: [{ key: "company/guide", runtimeName: "guide", source }, { key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", source: "not-materialized-native", required: true }], paperclipSkillSync: { desiredSkills: ["company/guide"] } };
    const context = { agentId: "agent", companyId: "company", adapterType: type, config };
    const snapshot = await adapter.listSkills!(context);
    expect(agentSkillSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.mode).toBe("ephemeral"); expect(snapshot.entries[0]).toMatchObject({ state: "configured", sourcePath: null, targetPath: null });
    expect(snapshot.entries[1]?.state).toBe("available");
    expect(await adapter.syncSkills!(context, ["company/guide"])).toEqual(snapshot);
    expect(await fs.readdir(source)).toEqual(["SKILL.md"]);
  });
});
