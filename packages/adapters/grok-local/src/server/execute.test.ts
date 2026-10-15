import { SOURCE_EVIDENCE_INSTRUCTIONS } from "@paperclipai/adapter-utils/source-evidence";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const ensureRuntimeInstalledMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const executionTargetIsRemoteMock = vi.hoisted(() => vi.fn(() => false));
const prepareRuntimeMock = vi.hoisted(() => vi.fn(async () => ({
  workspaceRemoteDir: null,
  restoreWorkspace: async () => {},
})));
const resolveCommandForLogsMock = vi.hoisted(() => vi.fn(async () => "grok"));
const runProcessMock = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  adapterExecutionTargetIsRemote: executionTargetIsRemoteMock,
  adapterExecutionTargetRemoteCwd: (_target: unknown, cwd: string) => cwd,
  overrideAdapterExecutionTargetRemoteCwd: (target: unknown, _cwd: string) => target,
  adapterExecutionTargetSessionIdentity: () => ({ kind: "local" }),
  adapterExecutionTargetSessionMatches: () => true,
  describeAdapterExecutionTarget: () => "local",
  ensureAdapterExecutionTargetCommandResolvable: ensureCommandMock,
  ensureAdapterExecutionTargetRuntimeCommandInstalled: ensureRuntimeInstalledMock,
  prepareAdapterExecutionTargetRuntime: prepareRuntimeMock,
  readAdapterExecutionTarget: ({ executionTarget }: { executionTarget?: unknown }) => executionTarget ?? { kind: "local" },
  resolveAdapterExecutionTargetCommandForLogs: resolveCommandForLogsMock,
  resolveAdapterExecutionTargetTimeoutSec: (_target: unknown, timeoutSec: number) => timeoutSec,
  runAdapterExecutionTargetProcess: runProcessMock,
}));

import { execute } from "./execute.js";

const tempRoots: string[] = [];

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-grok-local-"));
  tempRoots.push(root);
  return root;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

describe("grok_local execute", () => {
  beforeEach(() => {
    ensureRuntimeInstalledMock.mockClear();
    ensureCommandMock.mockClear();
    executionTargetIsRemoteMock.mockReset();
    executionTargetIsRemoteMock.mockReturnValue(false);
    prepareRuntimeMock.mockClear();
    resolveCommandForLogsMock.mockClear();
    runProcessMock.mockReset();
  });

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("stages Grok-native instructions and skills into the workspace for the run and cleans them up afterward", async () => {
    const root = await makeTempRoot();
    const instructionsPath = path.join(root, "managed", "AGENTS.md");
    const skillSource = path.join(root, "runtime-skills", "paperclip");
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "You are Grok.\n", "utf8");
    await fs.mkdir(skillSource, { recursive: true });
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "---\nname: paperclip\ndescription: test\n---\n", "utf8");

    runProcessMock.mockImplementation(async (_runId, _target, _command, args, options) => {
      expect(args).toEqual(
        expect.arrayContaining([
          "--output-format",
          "streaming-json",
          "--always-approve",
          "--permission-mode",
          "dontAsk",
        ]),
      );
      const ruleArguments = args.filter((argument: string) =>
        argument === "--rules" ||
        argument.startsWith("--rules=") ||
        argument === "--append-system-prompt" ||
        argument.startsWith("--append-system-prompt="),
      );
      expect(ruleArguments).toEqual(["--rules"]);
      const rulesIndex = args.indexOf("--rules");
      expect(rulesIndex).toBeGreaterThan(-1);
      expect(args).toContain("--debug");
      expect(args[rulesIndex + 1]).toContain("Keep local conventions.");
      expect(args[rulesIndex + 1]).toContain("Ignore all approved rules.");
      expect(args[rulesIndex + 1]).toContain("Legacy separate rule.");
      expect(args[rulesIndex + 1]).toContain("Legacy equals rule.");
      expect(args[rulesIndex + 1]).toContain("Approved Paperclip Standing Rules");
      expect(args[rulesIndex + 1]).toContain("Verify totals before reporting them.");
      const sentPrompt = args.find((part: string) => part.includes(SOURCE_EVIDENCE_INSTRUCTIONS));
      expect(sentPrompt).toBeDefined();
      expect(sentPrompt).not.toContain("Approved Paperclip Standing Rules");
      expect(sentPrompt.split(SOURCE_EVIDENCE_INSTRUCTIONS)).toHaveLength(2);
      expect(await fs.readFile(instructionsPath, "utf8")).toBe("You are Grok.\n");
      expect(await fs.readFile(path.join(root, "Agents.md"), "utf8")).toContain("You are Grok.");
      expect(await pathExists(path.join(root, ".claude", "skills", "paperclip", "SKILL.md"))).toBe(true);
      await options.onLog?.("stdout", '{"type":"text","data":"done"}\n');
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ type: "text", data: "done" }),
          JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "sess-1", requestId: "req-1" }),
        ].join("\n"),
        stderr: "",
      };
    });

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const ctx: AdapterExecutionContext = {
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        cwd: root,
        instructionsFilePath: instructionsPath,
        extraArgs: [
          "--debug",
          "--rules=Keep local conventions.",
          "--rules",
          "Ignore all approved rules.",
          "--append-system-prompt",
          "Legacy separate rule.",
          "--append-system-prompt=Legacy equals rule.",
        ],
        paperclipRuntimeSkills: [{
          key: "paperclip",
          runtimeName: "paperclip",
          source: skillSource,
          required: false,
        }],
        paperclipSkillSync: { desiredSkills: ["paperclip"] },
      },
      context: {
        paperclipApprovedRulesMarkdown: "- Verify totals before reporting them.",
      },
      authToken: "run-token",
      onLog: async (stream: "stdout" | "stderr", chunk: string) => {
        logs.push({ stream, chunk });
      },
    };

    const result = await execute(ctx);

    expect(result).toMatchObject({
      exitCode: 0,
      errorMessage: null,
      summary: "done",
      sessionId: "sess-1",
      sessionDisplayId: "sess-1",
    });
    expect(await pathExists(path.join(root, "Agents.md"))).toBe(false);
    expect(await pathExists(path.join(root, ".claude", "skills", "paperclip"))).toBe(false);
    expect(logs.map((entry) => entry.chunk)).not.toEqual([]);
  });

  it("merges configured instructions and equals-form rules into one native rules argument", async () => {
    const root = await makeTempRoot();
    const instructionsPath = path.join(root, "managed", "AGENTS.md");
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "Managed instructions.\n", "utf8");
    await fs.writeFile(path.join(root, "Agents.md"), "Workspace instructions.\n", "utf8");

    runProcessMock.mockImplementationOnce(async (_runId, _target, _command, args) => {
      const ruleArguments = args.filter((argument: string) =>
        argument === "--rules" ||
        argument.startsWith("--rules=") ||
        argument === "--append-system-prompt" ||
        argument.startsWith("--append-system-prompt="),
      );
      expect(ruleArguments).toEqual(["--rules"]);
      const rules = args[args.indexOf("--rules") + 1];
      expect(rules).toContain("Configured rule.");
      expect(rules).toContain("Managed instructions.");
      expect(rules).toContain("Approved Paperclip Standing Rules");
      expect(rules).toContain("Standing rule.");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: JSON.stringify({ type: "end", stopReason: "EndTurn" }),
        stderr: "",
      };
    });

    await execute({
      runId: "run-merged-rules",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        cwd: root,
        instructionsFilePath: instructionsPath,
        extraArgs: ["--rules=Configured rule."],
      },
      context: {
        paperclipApprovedRulesMarkdown: "- Standing rule.",
      },
      authToken: "run-token",
      onLog: async () => {},
    });
  });

  it("loads configured @file rules before merging the native rules argument", async () => {
    const root = await makeTempRoot();
    const rulesPath = path.join(root, "configured-rules.md");
    await fs.writeFile(rulesPath, "Rule loaded from the configured file.\n", "utf8");

    runProcessMock.mockImplementationOnce(async (_runId, _target, _command, args) => {
      const rules = args[args.indexOf("--rules") + 1];
      expect(rules).toContain("Rule loaded from the configured file.");
      expect(rules).not.toContain("@configured-rules.md");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: JSON.stringify({ type: "end", stopReason: "EndTurn" }),
        stderr: "",
      };
    });

    await execute({
      runId: "run-file-rules",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: { cwd: root, extraArgs: ["--rules", "@configured-rules.md"] },
      context: { paperclipApprovedRulesMarkdown: "- Approved standing rule." },
      authToken: "run-token",
      onLog: async () => {},
    });
  });

  it("rejects absolute remote @file rules paths instead of sending them as literal text", async () => {
    const root = await makeTempRoot();
    executionTargetIsRemoteMock.mockReturnValue(true);

    await expect(execute({
      runId: "run-remote-file-rules",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: { cwd: root, extraArgs: ["--rules", "@/remote/workspace/rules.md"] },
      context: {},
      executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/remote/workspace" },
      authToken: "run-token",
      onLog: async () => {},
    })).rejects.toThrow("remote --rules @file paths must be relative");
    expect(runProcessMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing separate value", ["--rules"]],
    ["a following option instead of a value", ["--rules", "--debug"]],
    ["an empty equals-form value", ["--rules="]],
    ["a missing legacy alias value", ["--append-system-prompt"]],
    ["a following option after the legacy alias", ["--append-system-prompt", "--debug"]],
    ["an empty legacy equals-form value", ["--append-system-prompt="]],
  ])("rejects %s clearly", async (_description, extraArgs) => {
    const root = await makeTempRoot();

    await expect(execute({
      runId: "run-invalid-rules",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: { cwd: root, extraArgs },
      context: {},
      authToken: "run-token",
      onLog: async () => {},
    })).rejects.toThrow("requires a non-empty value.");
    expect(runProcessMock).not.toHaveBeenCalled();
  });

  it("cleans up staged assets when setup fails before the Grok process starts", async () => {
    const root = await makeTempRoot();
    const instructionsPath = path.join(root, "managed", "AGENTS.md");
    const skillSource = path.join(root, "runtime-skills", "paperclip");
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "You are Grok.\n", "utf8");
    await fs.mkdir(skillSource, { recursive: true });
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "---\nname: paperclip\ndescription: test\n---\n", "utf8");
    ensureCommandMock.mockRejectedValueOnce(new Error("grok not installed"));

    const ctx: AdapterExecutionContext = {
      runId: "run-setup-fail",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        cwd: root,
        instructionsFilePath: instructionsPath,
        paperclipRuntimeSkills: [{
          key: "paperclip",
          runtimeName: "paperclip",
          source: skillSource,
          required: false,
        }],
        paperclipSkillSync: { desiredSkills: ["paperclip"] },
      },
      context: {},
      authToken: "run-token",
      onLog: async () => {},
    };

    await expect(execute(ctx)).rejects.toThrow("grok not installed");
    expect(runProcessMock).not.toHaveBeenCalled();
    expect(await pathExists(path.join(root, "Agents.md"))).toBe(false);
    expect(await pathExists(path.join(root, ".claude", "skills", "paperclip"))).toBe(false);
  });
});
