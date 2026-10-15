import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), pull: vi.fn(), run: vi.fn() }));
vi.mock("./prepare.js", () => ({ ensureAiderInstalled: mocks.prepare, ensureOllamaModelPulled: mocks.pull }));
vi.mock("@paperclipai/adapter-utils/execution-target", () => ({ runAdapterExecutionTargetProcess: mocks.run }));
import { execute } from "./execute.js";
const roots: string[] = [];
afterEach(async () => { vi.resetAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-aider-procedure-test-")); roots.push(root);
  const source = path.join(root, "source"); const cwd = path.join(root, "workspace"); await fs.mkdir(source); await fs.mkdir(cwd);
  await fs.writeFile(path.join(source, "SKILL.md"), "Complete company coding procedure.");
  const ctx = { runId: "r", agent: { id: "a", companyId: "c", name: "Coder" }, config: { cwd, paperclipRuntimeSkills: [{ key: "company/code", runtimeName: "code", source }], paperclipSkillSync: { desiredSkills: ["company/code"] } }, context: {}, runtime: {}, authToken: "synthetic-secret", onLog: vi.fn(), onMeta: vi.fn() } as unknown as AdapterExecutionContext;
  return { ctx, source, cwd };
}
describe("Aider complete read-only procedure staging", () => {
  it.each([undefined, "Custom task for {{agentName}}", "Custom task {{ paperclipWake }}"])("delivers counts to actual CLI stdin with default or custom template %s", async (promptTemplate) => {
    const { ctx } = await fixture();
    if (promptTemplate) ctx.config.promptTemplate = promptTemplate;
    ctx.context.paperclipWake = { issue: { id: "issue-1", title: "Read notes" }, runCountsRequired: true, runCountsRetryReason: "invalid_run_counts" };
    mocks.run.mockImplementation(async (_run, _target, _command, _args, options) => {
      expect(options.stdin).toContain("corrected final task comment");
      expect(options.stdin).toContain("preceding run's actual work");
      expect(options.stdin.match(/Run count reporting:/g)).toHaveLength(1);
      expect(options.stdin).toContain("Counts: items read 0; entries added 0; changes proposed 0.");
      return { stdout: "reported", stderr: "", exitCode: 0, signal: null, timedOut: false };
    });
    expect((await execute(ctx)).exitCode).toBe(0);
  });
  it.each(["success", "failure", "timeout"])("uses actual native --read files outside cwd and removes them after %s", async outcome => {
    const { ctx, cwd } = await fixture(); let paths: string[] = [];
    mocks.run.mockImplementation(async (_run, target, _command, args, options) => {
      expect(target).toBeNull(); paths = args.flatMap((arg: string, i: number) => arg === "--read" ? [args[i + 1]] : []);
      expect(paths).toHaveLength(1); expect(paths[0]!.startsWith(cwd)).toBe(false);
      expect(await fs.readFile(paths[0]!, "utf8")).toBe("Complete company coding procedure.");
      expect(options.stdin).toContain("Source evidence and coverage");
      if (outcome === "failure") throw new Error("CLI failed");
      return { stdout: "Fixture coding result.", stderr: "", exitCode: outcome === "timeout" ? 1 : 0, signal: null, timedOut: outcome === "timeout" };
    });
    if (outcome === "failure") await expect(execute(ctx)).rejects.toThrow("CLI failed"); else await execute(ctx);
    await expect(fs.stat(paths[0]!)).rejects.toThrow(); expect(await fs.readdir(cwd)).toEqual([]);
    const meta = vi.mocked(ctx.onMeta!).mock.calls[0]![0]; expect(JSON.stringify(meta.env)).not.toContain("synthetic-secret");
  });
  it("does not prepare or spawn on missing resources", async () => {
    const { ctx, source } = await fixture(); await fs.writeFile(path.join(source, "SKILL.md"), "Read [missing](references/missing.md).");
    await expect(execute(ctx)).rejects.toThrow("missing"); expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
  });
  it("places native read flags before a custom end-of-options delimiter", async () => {
    const { ctx } = await fixture(); ctx.config.extraArgs = ["--", "user-file.txt"];
    mocks.run.mockImplementation(async (_run, _target, _command, args) => {
      expect(args.indexOf("--read")).toBeLessThan(args.indexOf("--"));
      return { stdout: "ok", stderr: "", exitCode: 0, signal: null, timedOut: false };
    }); await execute(ctx);
  });
  it("cleans staged files when preparation fails", async () => {
    const { ctx } = await fixture(); mocks.prepare.mockRejectedValue(new Error("synthetic prep failure"));
    await expect(execute(ctx)).rejects.toThrow("synthetic prep failure");
    const meta = vi.mocked(ctx.onMeta!).mock.calls[0]![0]; const args = meta.commandArgs!;
    await expect(fs.stat(args[args.indexOf("--read") + 1]!)).rejects.toThrow(); expect(mocks.run).not.toHaveBeenCalled();
  });
  it("rejects remote context rather than staging host-only procedure paths", async () => {
    const { ctx } = await fixture(); ctx.context.paperclipEnvironment = { driver: "ssh" };
    await expect(execute(ctx)).rejects.toThrow("local execution only"); expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it("accepts the actual server-shaped local execution target", async () => {
    const { ctx } = await fixture(); ctx.executionTarget = { kind: "local", environmentId: "local-environment", leaseId: "local-lease" }; ctx.context.paperclipEnvironment = { driver: "local" };
    mocks.run.mockResolvedValue({ stdout: "local accepted", stderr: "", exitCode: 0, signal: null, timedOut: false });
    expect((await execute(ctx)).exitCode).toBe(0); expect(mocks.run).toHaveBeenCalled();
  });
  it("runs a real synthetic CLI subprocess that reads the staged files and stdin", async () => {
    const { ctx } = await fixture();
    const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>("@paperclipai/adapter-utils/execution-target");
    let capture: { text: string; prompt: string } | undefined;
    let stagedPath = "";
    mocks.run.mockImplementation(async (runId, target, _command, args, options) => {
      stagedPath = args[args.indexOf("--read") + 1];
      const script = "const fs=require('node:fs');let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>console.log(JSON.stringify({text:fs.readFileSync(process.argv[1],'utf8'),prompt:input})));";
      const result = await actual.runAdapterExecutionTargetProcess(runId, target, process.execPath, ["-e", script, stagedPath], options);
      capture = JSON.parse(result.stdout); return result;
    });
    const result = await execute(ctx); expect(result.exitCode).toBe(0);
    expect(capture?.text).toBe("Complete company coding procedure."); expect(capture?.prompt).toContain("Source evidence and coverage");
    await expect(fs.stat(stagedPath)).rejects.toThrow();
  });
});
