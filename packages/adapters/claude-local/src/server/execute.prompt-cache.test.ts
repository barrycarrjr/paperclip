import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      JSON.stringify({ type: "result", session_id: "claude-session-1", result: "done", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "claude"),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, ensureCommandResolvable, resolveCommandForLogs, runChildProcess };
});

import { execute } from "./execute.js";

describe("Claude prompt cache session safety", () => {
  const cleanupDirs: string[] = [];
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  afterEach(async () => {
    vi.clearAllMocks();
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalInstanceId;
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("starts a fresh session after repairing altered cached instructions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-session-cache-"));
    cleanupDirs.push(root);
    process.env.PAPERCLIP_HOME = path.join(root, "home");
    process.env.PAPERCLIP_INSTANCE_ID = "session-cache-test";
    const workspace = path.join(root, "workspace");
    const instructions = path.join(root, "instructions.md");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(instructions, "Follow the approved instructions.\n", "utf8");

    const common = {
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      config: { command: "claude", cwd: workspace, instructionsFilePath: instructions },
      context: { paperclipApprovedRulesMarkdown: "- Verify totals before reporting them." },
      onLog: vi.fn(async () => {}),
    };
    const first = await execute({
      ...common,
      runId: "run-1",
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    });
    const promptBundleKey = String(first.sessionParams?.promptBundleKey ?? "");
    expect(promptBundleKey).not.toBe("");
    const cachedInstructions = path.join(
      process.env.PAPERCLIP_HOME,
      "instances",
      process.env.PAPERCLIP_INSTANCE_ID,
      "companies",
      "company-1",
      "claude-prompt-cache",
      promptBundleKey,
      "agent-instructions.md",
    );
    await fs.writeFile(cachedInstructions, "altered by the agent\n", "utf8");
    runChildProcess.mockClear();

    await execute({
      ...common,
      runId: "run-2",
      runtime: {
        sessionId: "claude-session-1",
        sessionParams: first.sessionParams ?? null,
        sessionDisplayId: "claude-session-1",
        taskKey: null,
      },
    });

    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    expect(call?.[2]).not.toContain("--resume");
    expect(call?.[2]).toContain("--append-system-prompt-file");
    expect(common.onLog).toHaveBeenCalledWith(
      "stdout",
      expect.stringContaining("had altered cached instructions"),
    );
    await expect(fs.readFile(cachedInstructions, "utf8")).resolves.toContain(
      "Follow the approved instructions.",
    );
  });

  it("merges configured append-system-prompt text into the owned prompt file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-prompt-merge-"));
    cleanupDirs.push(root);
    process.env.PAPERCLIP_HOME = path.join(root, "home");
    process.env.PAPERCLIP_INSTANCE_ID = "prompt-merge-test";
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });

    await execute({
      runId: "run-prompt-merge",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "claude",
        cwd: workspace,
        extraArgs: ["--append-system-prompt", "Keep the configured instruction.", "--debug"],
      },
      context: { paperclipApprovedRulesMarkdown: "- Verify totals before reporting them." },
      onLog: vi.fn(async () => {}),
    });

    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    const args = call?.[2] ?? [];
    expect(args).not.toContain("--append-system-prompt");
    expect(args).toContain("--debug");
    expect(args.filter((arg) => arg === "--append-system-prompt-file")).toHaveLength(1);
    const promptFile = args[args.indexOf("--append-system-prompt-file") + 1];
    await expect(fs.readFile(promptFile, "utf8")).resolves.toContain("Keep the configured instruction.");
    await expect(fs.readFile(promptFile, "utf8")).resolves.toContain("Verify totals before reporting them.");
  });

  it("starts fresh when migrating a keyless session with a configured append prompt", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-prompt-migrate-"));
    cleanupDirs.push(root);
    process.env.PAPERCLIP_HOME = path.join(root, "home");
    process.env.PAPERCLIP_INSTANCE_ID = "prompt-migrate-test";
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });

    await execute({
      runId: "run-prompt-migrate",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "legacy-session",
        sessionParams: { sessionId: "legacy-session", cwd: workspace },
        sessionDisplayId: "legacy-session",
        taskKey: null,
      },
      config: {
        command: "claude",
        cwd: workspace,
        extraArgs: ["--append-system-prompt=Keep this configured instruction."],
      },
      context: {},
      onLog: vi.fn(async () => {}),
    });

    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    expect(call?.[2]).not.toContain("--resume");
    expect(call?.[2]).toContain("--append-system-prompt-file");
  });
});
