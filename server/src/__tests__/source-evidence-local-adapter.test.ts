import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { SOURCE_EVIDENCE_INSTRUCTIONS } from "@paperclipai/adapter-utils/source-evidence";
import { loadDefaultAgentInstructionsBundle } from "../services/default-agent-instructions.js";

const runChildProcess = vi.hoisted(() => vi.fn());
vi.mock("@paperclipai/adapter-utils/server-utils", async () => ({
  ...await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>("@paperclipai/adapter-utils/server-utils"),
  runChildProcess,
  ensureCommandResolvable: async () => {},
  resolveCommandForLogs: async (command: string) => command,
}));
vi.mock("@paperclipai/adapter-utils/execution-target", async () => ({
  ...await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>("@paperclipai/adapter-utils/execution-target"),
  ensureAdapterExecutionTargetCommandResolvable: async () => {},
  ensureAdapterExecutionTargetRuntimeCommandInstalled: async () => {},
  resolveAdapterExecutionTargetCommandForLogs: async (command: string) => command,
}));
vi.mock("../../../packages/adapters/pi-local/src/server/models.js", async () => ({
  ...await vi.importActual<typeof import("../../../packages/adapters/pi-local/src/server/models.js")>("../../../packages/adapters/pi-local/src/server/models.js"),
  ensurePiModelConfiguredAndAvailable: async () => {},
}));

import { execute as executeClaude } from "../../../packages/adapters/claude-local/src/server/execute.js";
import { execute as executePi } from "../../../packages/adapters/pi-local/src/server/execute.js";
import { execute as executeGrok } from "../../../packages/adapters/grok-local/src/server/execute.js";

const executors = { claude: executeClaude, pi: executePi, grok: executeGrok };
type Adapter = keyof typeof executors;
type Capture = { args: string[]; prompt: string; instructions: string };
const success = (command: string) => ({
  exitCode: 0, signal: null, timedOut: false, stderr: "", pid: 123,
  startedAt: new Date().toISOString(),
  stdout: command === "claude"
    ? JSON.stringify({ type: "result", session_id: "new-session", result: "done", usage: {} })
    : command === "pi"
      ? JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "done", usage: {} }, toolResults: [] })
      : JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "new-session", requestId: "request-1" }),
});

describe("delivered source guidance across native instruction and task channels", () => {
  let root: string;
  let captures: Capture[];
  let failResume: boolean;
  const originalHome = process.env.PAPERCLIP_HOME;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-source-channels-"));
    process.env.PAPERCLIP_HOME = root;
    captures = [];
    failResume = false;
    runChildProcess.mockReset();
    runChildProcess.mockImplementation(async (_runId: string, command: string, args: string[], options: { cwd: string; stdin?: string }) => {
      let instructions = "";
      let prompt = options.stdin ?? "";
      if (command === "claude") {
        const index = args.indexOf("--append-system-prompt-file");
        if (index >= 0) instructions = await fs.readFile(args[index + 1], "utf8");
      } else if (command === "pi") {
        instructions = args[args.indexOf("--append-system-prompt") + 1];
        prompt = args.at(-1)!;
      } else {
        prompt = args[args.indexOf("--single") + 1];
        const index = args.indexOf("--rules");
        const nativePath = index >= 0 ? args[index + 1].slice(1) : path.join(options.cwd, "Agents.md");
        instructions = await fs.readFile(nativePath, "utf8").catch(() => "");
      }
      captures.push({ args, prompt, instructions });
      if (command === "claude" && failResume && args.includes("--resume")) {
        return { ...success(command), exitCode: 1, stdout: JSON.stringify({ type: "result", is_error: true, result: "No conversation found with session ID saved-session" }), stderr: "" };
      }
      return success(command);
    });
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalHome;
    await fs.rm(root, { recursive: true, force: true });
  });

  async function context(adapter: Adapter, content: string | null, resumed: boolean): Promise<AdapterExecutionContext> {
    const instructionsFilePath = path.join(root, "managed", "AGENTS.md");
    await fs.mkdir(path.dirname(instructionsFilePath), { recursive: true });
    if (content !== null) await fs.writeFile(instructionsFilePath, content);
    // A pre-existing native file makes Grok select --rules, including the
    // unreadable configured-rule case, without overwriting the user's file.
    if (adapter === "grok" && content === null) await fs.writeFile(path.join(root, "Agents.md"), "Existing workspace rules.\n");
    return {
      runId: `run-${adapter}`, agent: { id: "agent-1", companyId: "company-1", name: "Test agent", adapterType: `${adapter}_local`, adapterConfig: {} },
      runtime: { sessionId: resumed ? "saved-session" : null, sessionParams: resumed ? { cwd: root } : null, sessionDisplayId: null, taskKey: null },
      config: { cwd: root, command: adapter, model: adapter === "pi" ? "openai/gpt-5.4-mini" : undefined, instructionsFilePath, promptTemplate: "Custom task instructions.\n  Keep this spacing.", paperclipRuntimeSkills: [], paperclipSkillSync: { desiredSkills: [] } },
      context: { paperclipWorkspace: { cwd: root, source: "project_primary" }, paperclipTaskMarkdown: "Perform the assigned task." },
      onLog: async () => {},
    };
  }

  describe.each(["claude", "pi", "grok"] as const)("%s", (adapter) => {
    it.each([
      ["default core", false], ["default core", true],
      ["custom without guidance", false], ["custom without guidance", true],
      ["custom with guidance", false], ["custom with guidance", true],
      ["missing file", false], ["missing file", true],
    ] as const)("sends one rule for %s (resumed %s), preserving source and task text", async (kind, resumed) => {
      const content = kind === "default core" ? (await loadDefaultAgentInstructionsBundle("default"))["AGENTS.md"]
        : kind === "custom without guidance" ? "Custom saved rules.\n  Preserve these bytes.\n"
          : kind === "custom with guidance" ? `Custom saved rules.\n\n${SOURCE_EVIDENCE_INSTRUCTIONS}` : null;
      const ctx = await context(adapter, content, resumed);
      const result = await executors[adapter](ctx);
      expect(result.exitCode).toBe(0);
      expect(captures).toHaveLength(1);
      const capture = captures[0];
      expect(`${capture.instructions}\n${capture.prompt}`.split(SOURCE_EVIDENCE_INSTRUCTIONS)).toHaveLength(2);
      expect(capture.prompt).toContain("Custom task instructions.\n  Keep this spacing.");
      if (content !== null) {
        expect(await fs.readFile(String(ctx.config.instructionsFilePath), "utf8")).toBe(content);
        if (!(adapter === "claude" && resumed)) expect(capture.instructions).toContain(content);
      }
      if (adapter === "claude") {
        expect(capture.args.includes("--append-system-prompt-file")).toBe(!resumed && content !== null);
        expect(capture.args.includes("--resume")).toBe(resumed);
        if (resumed) expect(capture.prompt).toContain(SOURCE_EVIDENCE_INSTRUCTIONS);
      }
    });

    it("preserves a user-authored full rule quotation in the task", async () => {
      const core = (await loadDefaultAgentInstructionsBundle("default"))["AGENTS.md"];
      const ctx = await context(adapter, core, false);
      const quotedTask = `Keep this quoted material unchanged:\n${SOURCE_EVIDENCE_INSTRUCTIONS}\nEnd quotation.`;
      ctx.config.promptTemplate = quotedTask;
      await executors[adapter](ctx);
      expect(captures[0].prompt).toContain(quotedTask);
      expect(`${captures[0].instructions}\n${captures[0].prompt}`.split(SOURCE_EVIDENCE_INSTRUCTIONS)).toHaveLength(3);
    });
  });

  it("recomputes Claude guidance when a missing saved session falls back to fresh instruction injection", async () => {
    const core = (await loadDefaultAgentInstructionsBundle("ceo"))["AGENTS.md"];
    const ctx = await context("claude", core, true);
    failResume = true;
    const result = await executeClaude(ctx);
    expect(result.exitCode).toBe(0);
    expect(captures).toHaveLength(2);
    expect(captures[0].args).toContain("--resume");
    expect(captures[0].instructions).toBe("");
    expect(captures[0].prompt).toContain(SOURCE_EVIDENCE_INSTRUCTIONS);
    expect(captures[1].args).not.toContain("--resume");
    expect(captures[1].instructions).toContain(core);
    expect(captures[1].prompt).not.toContain(SOURCE_EVIDENCE_INSTRUCTIONS);
    for (const capture of captures) expect(`${capture.instructions}\n${capture.prompt}`.split(SOURCE_EVIDENCE_INSTRUCTIONS)).toHaveLength(2);
    expect(await fs.readFile(String(ctx.config.instructionsFilePath), "utf8")).toBe(core);
  });

  it("counts Grok's actual --rules delivery when an existing native file must be preserved", async () => {
    const core = (await loadDefaultAgentInstructionsBundle("default"))["AGENTS.md"];
    const ctx = await context("grok", core, false);
    const nativePath = path.join(root, "Agents.md");
    await fs.writeFile(nativePath, "Existing workspace rules.\n");
    await executeGrok(ctx);
    expect(captures[0].args).toContain("--rules");
    expect(captures[0].instructions).toBe(core);
    expect(captures[0].prompt).not.toContain(SOURCE_EVIDENCE_INSTRUCTIONS);
    expect(await fs.readFile(nativePath, "utf8")).toBe("Existing workspace rules.\n");
  });
});
