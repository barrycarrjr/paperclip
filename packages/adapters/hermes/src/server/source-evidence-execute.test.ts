import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { appendSourceEvidenceInstructions, SOURCE_EVIDENCE_INSTRUCTIONS } from "@paperclipai/adapter-utils/source-evidence";

const runChildProcess = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0, signal: null, timedOut: false, stdout: "Done.\nsession_id: test-session", stderr: "", pid: 123, startedAt: null,
})));
vi.mock("@paperclipai/adapter-utils/server-utils", async () => ({
  ...await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>("@paperclipai/adapter-utils/server-utils"),
  runChildProcess,
}));
import { execute } from "./execute.js";

const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("Hermes final instruction composition", () => {
  it.each([
    ["default", false], ["default", true],
    ["custom", false], ["custom", true],
    ["custom_with_rule", false], ["custom_with_rule", true],
  ] as const)("sends one evidence rule with %s instructions and resumed=%s", async (kind, resumed) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-source-evidence-"));
    roots.push(root);
    const custom = "CUSTOM INSTRUCTIONS\n  Keep this indentation and this text.\n";
    const original = kind === "default"
      ? appendSourceEvidenceInstructions("Default agent instructions.")
      : kind === "custom_with_rule" ? appendSourceEvidenceInstructions(custom) : custom;
    const instructionsFilePath = path.join(root, "AGENTS.md");
    await fs.writeFile(instructionsFilePath, original);
    await execute({
      runId: "run-evidence", agent: { id: "agent-1", companyId: "company-1", name: "Hermes", adapterType: "hermes_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: resumed ? { sessionId: "existing-session" } : null, sessionDisplayId: null, taskKey: null },
      config: { cwd: root, provider: "auto", instructionsFilePath, promptTemplate: "Custom task prompt {{agentName}}" },
      context: { paperclipTaskMarkdown: "Answer the notes question.", paperclipWake: { issue: { id: "issue-1", title: "Read the notes" } } },
      onLog: async () => {},
    } satisfies AdapterExecutionContext);
    const args = (runChildProcess.mock.calls as unknown as Array<[string, string, string[]]>)[0]![2];
    const prompt = args[args.indexOf("-q") + 1]!;
    expect(prompt.startsWith(original)).toBe(true);
    expect(prompt).toContain("Custom task prompt Hermes");
    expect(prompt).toContain("Answer the notes question.");
    expect(prompt.split(SOURCE_EVIDENCE_INSTRUCTIONS)).toHaveLength(2);
    expect(await fs.readFile(instructionsFilePath, "utf8")).toBe(original);
    expect(args.includes("--resume")).toBe(resumed);
  });
});
