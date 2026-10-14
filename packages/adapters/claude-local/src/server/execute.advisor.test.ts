import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const runChildProcess = vi.hoisted(() => vi.fn());
vi.mock("@paperclipai/adapter-utils/server-utils", async () => ({
  ...await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>("@paperclipai/adapter-utils/server-utils"),
  runChildProcess, ensureCommandResolvable: async () => {}, resolveCommandForLogs: async (command: string) => command,
}));
vi.mock("@paperclipai/adapter-utils/execution-target", async () => ({
  ...await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>("@paperclipai/adapter-utils/execution-target"),
  ensureAdapterExecutionTargetCommandResolvable: async () => {},
  ensureAdapterExecutionTargetRuntimeCommandInstalled: async () => {},
  resolveAdapterExecutionTargetCommandForLogs: async (command: string) => command,
}));
import { execute } from "./execute.js";

const nativeUsage = { inputTokens: 10, outputTokens: 4, cacheReadInputTokens: 20, cacheCreationInputTokens: 3, costUSD: 0.004 };
function output(options: { observed?: boolean; map?: unknown; failedResume?: boolean } = {}) {
  return [
    { type: "system", subtype: "init", model: "light-primary", session_id: "saved-session" },
    { type: "assistant", advisorModel: "resolved-advisor", message: { content: [], usage: {
      iterations: options.observed ? [{ type: "advisor_message", model: "resolved-advisor" }] : [],
    } } },
    { type: "result", session_id: "saved-session", result: options.failedResume ? "No conversation found with session ID saved-session" : "Done.",
      is_error: options.failedResume ?? false, total_cost_usd: 0.008,
      usage: { input_tokens: 20, output_tokens: 8, cache_read_input_tokens: 40, cache_creation_input_tokens: 6 },
      modelUsage: options.map === undefined ? { "light-primary": nativeUsage, "resolved-advisor": nativeUsage } : options.map },
  ].map(row => JSON.stringify(row)).join("\n");
}

describe("opt-in native Claude advisor invocation", () => {
  let root: string;
  const originalHome = process.env.PAPERCLIP_HOME;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-advisor-"));
    process.env.PAPERCLIP_HOME = root;
    runChildProcess.mockReset().mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, stdout: output(), stderr: "", pid: 123, startedAt: new Date().toISOString() });
  });
  afterEach(async () => {
    if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalHome;
    await fs.rm(root, { recursive: true, force: true });
  });
  const ctx = (advisorModel?: unknown, resumed = false): AdapterExecutionContext => ({
    runId: "advisor-run", agent: { id: "agent-1", companyId: "company-1", name: "Writer", adapterType: "claude_local", adapterConfig: {}, forbiddenWritePaths: ["private/**"] },
    config: { cwd: root, model: "light-primary", ...(advisorModel === undefined ? {} : { advisorModel }),
      maxTurnsPerRun: 17, timeoutSec: 45, promptTemplate: "Custom task text.", paperclipRuntimeSkills: [], paperclipSkillSync: { desiredSkills: [] } },
    runtime: { sessionId: resumed ? "saved-session" : null, sessionParams: resumed ? { cwd: root } : null, sessionDisplayId: null, taskKey: null },
    context: { paperclipWorkspace: { cwd: root, source: "project_primary" } }, onLog: async () => {},
  });

  it.each([undefined, "", "  "])("keeps advice disabled by default (%s), including inherited settings", async advisor => {
    const result = await execute(ctx(advisor));
    const [, , args, options] = runChildProcess.mock.calls[0];
    expect(args).not.toContain("--advisor");
    expect(options.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBe("1");
    expect(options.stdin).not.toContain("An advisor model was requested");
    expect(result.resultJson).not.toHaveProperty("paperclipAdvisor");
  });

  it.each([false, true])("sends explicit advice for fresh/resumed=%s while retaining security and run limits", async resumed => {
    const input = ctx("opus", resumed);
    input.config.env = { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1" };
    const result = await execute(input);
    const [, , args, options] = runChildProcess.mock.calls[0];
    expect(args.filter((arg: string) => arg === "--advisor")).toHaveLength(1);
    expect(args[args.indexOf("--advisor") + 1]).toBe("opus");
    expect(args[args.indexOf("--model") + 1]).toBe("light-primary");
    expect(args.includes("--resume")).toBe(resumed);
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--disallowedTools");
    expect(args[args.indexOf("--settings") + 1]).toContain("private/**");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("17");
    expect(options.timeoutSec).toBe(45);
    expect(options.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBe("1");
    expect(options.env).not.toHaveProperty("CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL");
    expect(options.stdin).toContain("Custom task text.");
    expect(options.stdin).toContain("If the native advisor tool is available");
    expect(result.usage).toEqual({ inputTokens: 26, outputTokens: 8, cachedInputTokens: 40 });
    expect(result.resultJson?.paperclipAdvisor).toMatchObject({ requestedModel: "opus", resolvedModel: "resolved-advisor", status: "model_observed", consultation: "unknown" });
    expect(result.resultJson?.paperclipAdvisor).toHaveProperty("availability", "disabled_by_policy");
  });

  it("reports native observed consultations separately from model totals", async () => {
    runChildProcess.mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, stdout: output({ observed: true }), stderr: "" });
    const result = await execute(ctx("opus"));
    expect(result.resultJson?.paperclipAdvisor).toMatchObject({ consultation: "observed", accounting: "native_per_model_totals" });
    expect(result.modelUsage?.["resolved-advisor"].costUsd).toBe(0.004);
    expect(result.billingType).toBe("subscription");
  });
  it("observes native advisor iterations when no advisorModel announcement is present", async () => {
    const stdout = output({ observed: true }).split("\n").map(line => {
      const event = JSON.parse(line); delete event.advisorModel; return JSON.stringify(event);
    }).join("\n");
    runChildProcess.mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, stdout, stderr: "" });
    expect((await execute(ctx("opus"))).resultJson?.paperclipAdvisor).toMatchObject({ resolvedModel: "resolved-advisor", consultation: "observed", status: "model_observed" });
  });
  it("retains an observed native consultation even when its model identity is unavailable", async () => {
    const stdout = output({ observed: true }).split("\n").map(line => {
      const event = JSON.parse(line); delete event.advisorModel;
      if (event.type === "assistant") delete event.message.usage.iterations[0].model;
      return JSON.stringify(event);
    }).join("\n");
    runChildProcess.mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, stdout, stderr: "" });
    expect((await execute(ctx("opus"))).resultJson?.paperclipAdvisor).toMatchObject({ resolvedModel: null, consultation: "observed", status: "unconfirmed" });
  });
  it("does not persist its default-off environment flag into the next opted-in run", async () => {
    await execute(ctx()); await execute(ctx("opus"));
    expect(runChildProcess.mock.calls[0][3].env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBe("1");
    expect(runChildProcess.mock.calls[1][3].env).not.toHaveProperty("CLAUDE_CODE_DISABLE_ADVISOR_TOOL");
  });
  it.each([true, false])("retains consumed native usage on timeout=%s failures", async timedOut => {
    runChildProcess.mockResolvedValue({ exitCode: 1, signal: timedOut ? "SIGTERM" : null, timedOut, stdout: output(), stderr: "failed" });
    const result = await execute(ctx("opus"));
    expect(result.usage).toEqual({ inputTokens: 26, outputTokens: 8, cachedInputTokens: 40 });
    expect(result.modelUsage?.["resolved-advisor"].costUsd).toBe(0.004);
    expect(result.costUsd).toBe(0.008);
    expect(result.provider).toBe("anthropic");
    expect(result.billingType).toBe("subscription");
  });

  it.each([null, { "light-primary": { ...nativeUsage, costUSD: "bad" } }])("retains aggregate usage and marks incomplete attribution unknown", async map => {
    runChildProcess.mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, stdout: output({ map }), stderr: "" });
    const result = await execute(ctx("opus"));
    expect(result.modelUsage).toBeUndefined();
    expect(result.costUsd).toBe(0.008);
    expect(result.resultJson?.paperclipAdvisor).toMatchObject({ status: "unconfirmed", accounting: "unknown_advisor_consumption" });
  });

  it.each([42, "--model evil", "opus\n--resume secret"])("rejects invalid advisor config before invocation (%s)", async advisor => {
    expect((await execute(ctx(advisor))).errorCode).toBe("claude_advisor_invalid");
    expect(runChildProcess).not.toHaveBeenCalled();
  });
  it("rejects extraArgs bypass of explicit advice", async () => {
    const input = ctx(); input.config.extraArgs = ["--advisor=opus"];
    expect((await execute(input)).errorCode).toBe("claude_advisor_invalid");
    expect(runChildProcess).not.toHaveBeenCalled();
  });
  it("accounts for a consumed failed resume plus its fresh retry once each", async () => {
    runChildProcess.mockResolvedValueOnce({ exitCode: 1, signal: null, timedOut: false, stdout: output({ failedResume: true }), stderr: "" });
    const result = await execute(ctx("opus", true));
    expect(runChildProcess).toHaveBeenCalledTimes(2);
    expect(runChildProcess.mock.calls[0][2]).toContain("--resume");
    expect(runChildProcess.mock.calls[1][2]).not.toContain("--resume");
    expect(result.costUsd).toBe(0.016);
    expect(result.usage).toEqual({ inputTokens: 52, outputTokens: 16, cachedInputTokens: 80 });
    expect(result.modelUsage?.["resolved-advisor"].costUsd).toBe(0.008);
  });
  it("retains a paid failed attempt's known subtotal when its retry times out without a report", async () => {
    runChildProcess.mockResolvedValueOnce({ exitCode: 1, signal: null, timedOut: false, stdout: output({ failedResume: true }), stderr: "" })
      .mockResolvedValueOnce({ exitCode: null, signal: "SIGTERM", timedOut: true, stdout: "", stderr: "" });
    const result = await execute(ctx("opus", true));
    expect(result.timedOut).toBe(true);
    expect(result.costUsd).toBe(0.008);
    expect(result.usage).toEqual({ inputTokens: 26, outputTokens: 8, cachedInputTokens: 40 });
    expect(result.modelUsage).toBeUndefined();
    expect(result.resultJson).toMatchObject({ paperclipUsageReporting: { costComplete: false, usageComplete: false },
      paperclipAdvisor: { accounting: "unknown_advisor_consumption" } });
    expect(result.resultJson?.availableModelUsageReports).toHaveLength(1);
  });
});
