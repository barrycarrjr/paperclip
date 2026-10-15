import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterSkillContext } from "@paperclipai/adapter-utils";
import { SOURCE_EVIDENCE_INSTRUCTIONS } from "@paperclipai/adapter-utils/source-evidence";
import * as openclawSkills from "@paperclipai/adapter-openclaw-gateway/server";
import * as hermesSkills from "@paperclipai/hermes-paperclip-adapter/gateway/server";
import * as cursorSkills from "@paperclipai/adapter-cursor-cloud/server";

const transport = vi.hoisted(() => ({
  connections: 0, agentParams: [] as Record<string, unknown>[],
  create: vi.fn(), resume: vi.fn(), getRun: vi.fn(),
}));
vi.mock("../../../packages/adapters/cursor-cloud/node_modules/@cursor/sdk/dist/esm/index.js", () => ({ Agent: { create: transport.create, resume: transport.resume, getRun: transport.getRun } }));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class WebSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    constructor() {
      super(); transport.connections++;
      queueMicrotask(() => {
        this.emit("open");
        this.emit("message", JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "synthetic-nonce" } }));
      });
    }
    send(raw: string) {
      const frame = JSON.parse(raw);
      if (frame.method === "agent") transport.agentParams.push(frame.params);
      queueMicrotask(() => this.emit("message", JSON.stringify({
        type: "res", id: frame.id, ok: true,
        payload: frame.method === "connect" ? { protocol: 3 } : { status: "ok", runId: "remote-run", text: "done" },
      })));
    }
    close() { this.readyState = 3; this.emit("close", 1000, Buffer.from("complete")); }
  }
  return { WebSocket };
});

const adapters = [
  { name: "openclaw_gateway", execute: openclawSkills.execute, skills: openclawSkills, config: { url: "wss://gateway.example.invalid", disableDeviceAuth: true, token: "synthetic-auth", timeoutSec: 2 } },
  { name: "hermes_gateway", execute: hermesSkills.execute, skills: hermesSkills, config: { apiBaseUrl: "https://hermes.example.invalid", apiKey: "synthetic-auth", timeoutSec: 2 } },
  { name: "cursor_cloud", execute: cursorSkills.execute, skills: cursorSkills, config: { env: { CURSOR_API_KEY: "synthetic-auth" }, repoUrl: "https://example.invalid/repository.git", runtimeEnvType: "cloud" } },
];
let root: string;
let fixtureConfig: Record<string, unknown>;
let sdkAgent: { agentId: string; send: ReturnType<typeof vi.fn>; [Symbol.asyncDispose]: ReturnType<typeof vi.fn> };
let fetchMock: ReturnType<typeof vi.fn>;
const skillText = "# Company procedure\nRead [checks](references/checks.md).\nExecute the complete selected instructions.\n";
const resourceText = "# Checks\nExact final resource line: COMPLETE_RESOURCE_END\n";

function context(adapter: typeof adapters[number], config: Record<string, unknown>): AdapterExecutionContext {
  return {
    runId: "run-1", agent: { id: "agent-1", companyId: "company-1", name: "Agent", adapterType: adapter.name, adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { ...adapter.config, ...fixtureConfig, ...config },
    context: { issueId: "issue-1", wakeReason: "manual", paperclipWake: { issue: { identifier: "EX-1", title: "Work" } } },
    onLog: vi.fn(async () => {}), onMeta: vi.fn(async () => {}),
  };
}
function outbound(adapter: typeof adapters[number]): string {
  if (adapter.name === "openclaw_gateway") return String(transport.agentParams[0]?.message);
  if (adapter.name === "cursor_cloud") return String(sdkAgent.send.mock.calls[0]?.[0]);
  const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/v1/runs"));
  return JSON.parse(String(call?.[1]?.body)).input;
}
function assertNoTransport() {
  expect(transport.connections).toBe(0);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(transport.create).not.toHaveBeenCalled();
  expect(transport.resume).not.toHaveBeenCalled();
  expect(transport.getRun).not.toHaveBeenCalled();
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-remote-procedures-"));
  await fs.mkdir(path.join(root, "selected", "references"), { recursive: true });
  await fs.mkdir(path.join(root, "unselected"));
  await fs.writeFile(path.join(root, "selected", "SKILL.md"), skillText);
  await fs.writeFile(path.join(root, "selected", "references", "checks.md"), resourceText);
  await fs.writeFile(path.join(root, "unselected", "SKILL.md"), "PRIVATE_UNSELECTED_PROCEDURE");
  fixtureConfig = {
    paperclipRuntimeSkills: [
      { key: "company/selected", runtimeName: "selected", source: path.join(root, "selected") },
      { key: "company/unselected", runtimeName: "unselected", source: path.join(root, "unselected") },
      { key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", source: path.join(root, "unselected"), required: true },
    ],
    paperclipSkillSync: { desiredSkills: ["company/selected"] },
  };
  transport.connections = 0; transport.agentParams = [];
  transport.create.mockReset(); transport.resume.mockReset(); transport.getRun.mockReset();
  const run = { id: "remote-run", agentId: "remote-agent", status: "finished", supports: (capability: string) => capability === "wait", wait: async () => ({ id: "remote-run", status: "finished", result: "done" }) };
  sdkAgent = { agentId: "remote-agent", send: vi.fn(async () => run), [Symbol.asyncDispose]: vi.fn(async () => {}) };
  transport.create.mockResolvedValue(sdkAgent); transport.resume.mockResolvedValue(sdkAgent);
  transport.getRun.mockResolvedValue(run);
  fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).endsWith("/v1/runs")) return Response.json({ run_id: "remote-run", status: "started" });
    if (String(url).endsWith("/events")) return new Response("event: run.completed\ndata: {\"status\":\"completed\",\"output\":\"done\"}\n\n", { headers: { "content-type": "text/event-stream" } });
    return Response.json({ status: "completed", output: "done" });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => { vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true }); });

it("delivers trusted count reporting through an OpenClaw custom message payload", async () => {
  const adapter = adapters[0]!;
  const ctx = context(adapter, { payloadTemplate: { message: "Custom wake" } });
  ctx.context.paperclipWake = { issue: { id: "issue-1", title: "Read notes" }, runCountsRequired: true, runCountsRetryReason: "missing_run_counts" };
  expect((await adapter.execute(ctx)).exitCode).toBe(0);
  const prompt = outbound(adapter);
  expect(prompt).toContain("Custom wake");
  expect(prompt).toContain("corrected final task comment");
  expect(prompt).toContain("preceding run's actual work");
  expect(prompt).toContain("Counts: items read 0; entries added 0; changes proposed 0.");
});

describe.each(adapters)("$name complete procedure delivery", (adapter) => {
  it("delivers all selected text with the final outgoing prompt and preserves source evidence", async () => {
    const result = await adapter.execute(context(adapter, { payloadTemplate: { message: "Custom wake", input: "Custom input" } }));
    expect(result.exitCode, result.errorMessage ?? undefined).toBe(0);
    const prompt = outbound(adapter);
    expect(prompt).toContain(skillText);
    expect(prompt).toContain(resourceText);
    expect(prompt).toContain("Resource references/checks.md");
    expect(prompt).not.toContain("PRIVATE_UNSELECTED_PROCEDURE");
    expect(prompt).not.toContain(root);
    expect(prompt.endsWith(SOURCE_EVIDENCE_INSTRUCTIONS)).toBe(true);
    expect(prompt.split(SOURCE_EVIDENCE_INSTRUCTIONS)).toHaveLength(2);
    if (adapter.name === "hermes_gateway") expect(prompt).toContain("Custom input");
    if (adapter.name === "openclaw_gateway") {
      expect(prompt).toContain("Custom wake");
      expect(transport.agentParams[0]?.idempotencyKey).toBe("run-1");
    }
  });

  it.each(["missing", "script", "binary", "oversized", "unknown"])("rejects %s selected content before any remote call", async (kind) => {
    const override: Record<string, unknown> = {};
    if (kind === "missing") await fs.rm(path.join(root, "selected", "references", "checks.md"));
    if (kind === "script") await fs.writeFile(path.join(root, "selected", "run.py"), "print('unsupported')");
    if (kind === "binary") await fs.writeFile(path.join(root, "selected", "binary.txt"), Buffer.from([0, 1, 2]));
    if (kind === "oversized") await fs.writeFile(path.join(root, "selected", "large.md"), "x".repeat(65_537));
    if (kind === "unknown") override.paperclipSkillSync = { desiredSkills: ["company/unavailable"] };
    const result = await adapter.execute(context(adapter, override));
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("paperclip_procedure_unavailable");
    expect(result.errorMessage).toBeTruthy();
    expect(result.errorMessage).not.toContain(root);
    assertNoTransport();
  });

  it("reports next-run text context without claiming remote installation or contacting the provider", async () => {
    const ctx: AdapterSkillContext = { companyId: "company-1", agentId: "agent-1", adapterType: adapter.name, config: fixtureConfig };
    const before = await fs.readdir(root);
    const snapshot = await adapter.skills.listSkills(ctx);
    expect(await adapter.skills.syncSkills(ctx, ["company/selected"])).toEqual(snapshot);
    expect(snapshot).toMatchObject({ supported: true, mode: "ephemeral" });
    expect(snapshot.entries.find(entry => entry.key === "company/selected")).toMatchObject({ desired: true, state: "configured", sourcePath: null, targetPath: null });
    expect(snapshot.entries.find(entry => entry.key === "company/unselected")).toMatchObject({ desired: false, state: "available" });
    expect(snapshot.entries.every(entry => entry.state !== "installed")).toBe(true);
    expect(snapshot.warnings.join(" ")).toContain("not reported");
    expect(await fs.readdir(root)).toEqual(before);
    assertNoTransport();
  });

  it("leaves unattached company procedures out of the native wake", async () => {
    const result = await adapter.execute(context(adapter, { paperclipSkillSync: { desiredSkills: [] } }));
    expect(result.exitCode, result.errorMessage ?? undefined).toBe(0);
    expect(outbound(adapter)).not.toContain(skillText);
    expect(outbound(adapter)).not.toContain(resourceText);
    expect(outbound(adapter)).not.toContain("PRIVATE_UNSELECTED_PROCEDURE");
  });

  it("rejects the entire wake if any selected procedure is incomplete and reports it in the snapshot", async () => {
    await fs.writeFile(path.join(root, "unselected", "SKILL.md"), "Read [missing](missing.md).");
    const ctx = context(adapter, { paperclipSkillSync: { desiredSkills: ["company/selected", "company/unselected"] } });
    const result = await adapter.execute(ctx);
    expect(result.errorCode).toBe("paperclip_procedure_unavailable");
    assertNoTransport();
    const snapshot = await adapter.skills.listSkills({ companyId: "company-1", agentId: "agent-1", adapterType: adapter.name, config: ctx.config });
    expect(snapshot.entries.find(entry => entry.key === "company/unselected")).toMatchObject({ desired: true, state: "missing" });
    expect(snapshot.warnings.join(" ")).toContain("missing or unsupported");
  });
});

it("includes complete procedures when Cursor resumes a saved matching cloud session", async () => {
  const adapter = adapters[2]!;
  const ctx = context(adapter, {});
  ctx.runtime.sessionParams = { cursorAgentId: "previous-agent", latestRunId: "previous-run", runtime: "cloud", envType: "cloud", repos: [{ url: "https://example.invalid/repository.git" }] };
  const result = await adapter.execute(ctx);
  expect(result.exitCode, result.errorMessage ?? undefined).toBe(0);
  expect(transport.resume).toHaveBeenCalledOnce();
  expect(transport.create).not.toHaveBeenCalled();
  expect(outbound(adapter)).toContain(skillText);
  expect(outbound(adapter)).toContain(resourceText);
});
