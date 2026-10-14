import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";
import { SOURCE_EVIDENCE_INSTRUCTIONS } from "@paperclipai/adapter-utils/source-evidence";
const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function context() {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ollama-procedure-")); roots.push(source);
  await fs.mkdir(path.join(source, "references"));
  await fs.writeFile(path.join(source, "SKILL.md"), "Company approval procedure: read [terms](references/terms.md).");
  await fs.writeFile(path.join(source, "references", "terms.md"), "Approval requires the complete final paragraph.");
  return { runId: "test", agent: { id: "a", companyId: "c", name: "Analyst", adapterConfig: {} }, config: { model: "fixture:latest", numPredict: 100, paperclipRuntimeSkills: [{ key: "company/approval", runtimeName: "approval", source }], paperclipSkillSync: { desiredSkills: ["company/approval"] } }, context: {}, runtime: {}, onLog: vi.fn() } as unknown as AdapterExecutionContext;
}
function provider(options: { contextLength?: number; models?: unknown[]; version?: string } = {}) {
  const requests: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); const body = init?.body ? JSON.parse(String(init.body)) : null; requests.push({ url, body });
    if (url.endsWith("/api/version")) return Response.json({ version: options.version ?? "0.14.0" });
    if (url.endsWith("/api/ps")) return Response.json({ models: options.models ?? [{ name: "fixture:latest", context_length: options.contextLength ?? 16_384 }] });
    if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "fixture:latest" }] });
    if (url.endsWith("/api/chat")) return Response.json({ model: "fixture:latest", message: { content: "Fixture answer." }, done: true });
    throw new Error("Unexpected request " + url);
  }); vi.stubGlobal("fetch", mock); return requests;
}
describe("Ollama attached procedure execution", () => {
  it("sends complete selected procedure and evidence guidance with no truncation, shift, or num_ctx", async () => {
    const ctx = await context(); const requests = provider(); expect((await execute(ctx)).exitCode).toBe(0);
    const request = requests.find(request => request.url.endsWith("/api/chat"))!.body!;
    expect(JSON.stringify(request.messages)).toContain("complete final paragraph");
    expect((request.messages as Array<{ content: string }>)[0]!.content).toContain(SOURCE_EVIDENCE_INSTRUCTIONS);
    expect(request.truncate).toBe(false); expect(request.shift).toBe(false); expect(request.options).not.toHaveProperty("num_ctx");
    expect(requests.some(request => request.url.endsWith("/api/pull"))).toBe(false);
  });
  it.each([{ models: [] }, { models: [{ name: "other", context_length: 32768 }] }, { models: [{ name: "fixture:latest", context_length: null }] }, { models: [{ name: "fixture", context_length: 32768 }, { name: "fixture:latest", context_length: 32768 }] }, { version: "0.13.9" }, { version: "0.14.0-rc1" }, { version: "unverifiable" }, { contextLength: 2048 }])("stops before any inference or model pull when fit cannot be verified %s", async options => {
    const ctx = await context(); const requests = provider(options);
    const result = await execute(ctx); expect(result.exitCode).toBe(1); expect(result.errorCode).toMatch(/^procedure_context/);
    expect(requests.some(request => /\/api\/(chat|pull|tags)$/.test(request.url))).toBe(false);
  });
  it.each([null, []])("returns an explanatory failure for malformed runtime observations %s", async response => {
    const ctx = await context(); const mock = vi.fn(async () => Response.json(response)); vi.stubGlobal("fetch", mock);
    const result = await execute(ctx); expect(result.errorCode).toBe("procedure_context_unknown"); expect(result.errorMessage).toContain("Cannot verify"); expect(mock).toHaveBeenCalledTimes(1);
  });
  it("keeps compact native wake and skips runtime context probes without explicit company attachments", async () => {
    const ctx = await context(); ctx.config.paperclipSkillSync = { desiredSkills: [] }; const requests = provider();
    expect((await execute(ctx)).exitCode).toBe(0);
    expect(requests.map(request => request.url.split("/").pop())).toEqual(["tags", "chat"]);
    const request = requests[1]!.body!; expect(request).not.toHaveProperty("truncate"); expect(JSON.stringify(request.messages)).not.toContain("Company approval procedure");
  });
  it("accepts the actual server-shaped local execution target", async () => {
    const ctx = await context(); ctx.executionTarget = { kind: "local", environmentId: "local-environment", leaseId: "local-lease" }; ctx.context.paperclipEnvironment = { driver: "local" };
    const requests = provider(); expect((await execute(ctx)).exitCode).toBe(0); expect(requests.some(request => request.url.endsWith("/api/chat"))).toBe(true);
  });
  it("counts the full source-evidence guidance and all final message bytes for admission", async () => {
    const ctx = await context(); const first = provider(); await execute(ctx);
    const messages = first.find(request => request.url.endsWith("/api/chat"))!.body!.messages as Array<{ content: string }>;
    const required = messages.reduce((sum, message) => sum + Buffer.byteLength(message.content), 0) + 1024 + 100;
    const second = provider({ contextLength: required - 1 }); expect((await execute(ctx)).errorCode).toBe("procedure_context_too_small");
    expect(second.some(request => request.url.endsWith("/api/chat"))).toBe(false);
  });
  it("stops on missing content without contacting a provider", async () => {
    const ctx = await context(); await fs.rm(path.join((ctx.config.paperclipRuntimeSkills as Array<{ source: string }>)[0]!.source, "references/terms.md")); const requests = provider();
    expect((await execute(ctx)).errorCode).toBe("procedure_incomplete"); expect(requests).toEqual([]);
  });
  it("runs the real HTTP path against a local mocked provider", async () => {
    const received: Record<string, unknown>[] = []; const ctx = await context();
    const server = http.createServer(async (req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/version") res.end(JSON.stringify({ version: "0.14.0" }));
      else if (req.url === "/api/ps") res.end(JSON.stringify({ models: [{ name: "fixture:latest", context_length: 16384 }] }));
      else if (req.url === "/api/tags") res.end(JSON.stringify({ models: [{ name: "fixture:latest" }] }));
      else if (req.url === "/api/chat") { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); received.push(JSON.parse(Buffer.concat(chunks).toString())); res.end(JSON.stringify({ message: { content: "HTTP verified answer." } })); }
      else { res.statusCode = 500; res.end("{}"); }
    }); server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      ctx.config.ollamaBaseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const result = await execute(ctx); expect(result.summary).toBe("HTTP verified answer."); expect(received[0]?.truncate).toBe(false); expect(JSON.stringify(received)).toContain("complete final paragraph");
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
