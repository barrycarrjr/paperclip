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
function provider(options: { contextLength?: number; models?: unknown[]; version?: string; chatContent?: string; comments?: Record<string, Record<string, unknown>>; approvalStatus?: number; approvalStatuses?: number[]; resubmitStatuses?: number[]; approvalReadStatus?: string; approvalReadPayload?: Record<string, unknown>; approvalReadUpdatedAt?: string } = {}) {
  const requests: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  let approvalAttempt = 0;
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); const body = init?.body ? JSON.parse(String(init.body)) : null; requests.push({ url, body });
    if (url.endsWith("/api/version")) return Response.json({ version: options.version ?? "0.14.0" });
    if (url.endsWith("/api/ps")) return Response.json({ models: options.models ?? [{ name: "fixture:latest", context_length: options.contextLength ?? 16_384 }] });
    if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "fixture:latest" }] });
    if (url.endsWith("/api/chat")) return Response.json({ model: "fixture:latest", message: { content: options.chatContent ?? "Fixture answer." }, done: true });
    if (url.includes("/api/companies/") && url.endsWith("/approvals")) {
      const status = options.approvalStatuses?.[approvalAttempt++] ?? options.approvalStatus ?? 201;
      return Response.json(status >= 400 ? { error: "approval failed" } : { id: "approval-1", status: "pending" }, { status });
    }
    if (/\/api\/approvals\/[^/]+\/resubmit$/.test(url)) {
      const status = options.resubmitStatuses?.shift() ?? 200;
      return Response.json(status >= 400 ? { error: "resubmit failed" } : { id: "approval-1", status: "pending" }, { status });
    }
    if (/\/api\/approvals\/[^/]+$/.test(url)) {
      return Response.json({ id: "approval-1", status: options.approvalReadStatus ?? "pending", payload: options.approvalReadPayload ?? {}, updatedAt: options.approvalReadUpdatedAt });
    }
    const commentId = /\/api\/issues\/[^/]+\/comments\/([^/?]+)$/.exec(url)?.[1];
    if (commentId && options.comments?.[commentId]) return Response.json(options.comments[commentId]);
    if (url.includes("/api/issues/") && (url.endsWith("/comments") || init?.method === "PATCH")) return Response.json({ id: "issue-1" });
    throw new Error("Unexpected request " + url);
  }); vi.stubGlobal("fetch", mock); return requests;
}
describe("Ollama attached procedure execution", () => {
  it("delivers count correction guidance in the compact prompt and counts its bytes for admission", async () => {
    const ctx = await context();
    ctx.context.paperclipWake = { issue: { id: "issue-1", title: "Read notes" }, runCountsRequired: true, runCountsRetryReason: "missing_run_counts" };
    const first = provider(); expect((await execute(ctx)).exitCode).toBe(0);
    const messages = first.find(request => request.url.endsWith("/api/chat"))!.body!.messages as Array<{ content: string }>;
    expect(messages[1]!.content).toContain("corrected final task comment");
    expect(messages[1]!.content).toContain("preceding run's actual work");
    expect(messages[1]!.content).toContain("Counts: items read 0; entries added 0; changes proposed 0.");
    const required = messages.reduce((sum, message) => sum + Buffer.byteLength(message.content), 0) + 1024 + 100;
    const second = provider({ contextLength: required - 1 });
    expect((await execute(ctx)).errorCode).toBe("procedure_context_too_small");
    expect(second.some(request => request.url.endsWith("/api/chat"))).toBe(false);
  });
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
  it("keeps correction intent and approved rules in the no-MCP compact request", async () => {
    const ctx = await context();
    ctx.config.paperclipSkillSync = { desiredSkills: [] };
    ctx.authToken = "agent-token";
    ctx.context.paperclipApprovedRulesMarkdown = "- Verify totals before reporting them.";
    ctx.context.paperclipWake = {
      issue: { id: "11111111-1111-4111-8111-111111111111", title: "Correct behavior" },
      comments: [{
        id: "22222222-2222-4222-8222-222222222222",
        intent: "correction",
        body: "Always verify the total first.",
        authorUserName: "Board operator",
      }],
    };
    const requests = provider({ chatContent: JSON.stringify({ proposals: [{ sourceCommentId: "22222222-2222-4222-8222-222222222222", scope: "agent", rule: "Verify totals before reporting them.", rationale: "Prevents inaccurate totals." }] }) });
    expect((await execute(ctx)).exitCode).toBe(0);
    const messages = requests.find(request => request.url.endsWith("/api/chat"))!.body!.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.content).toContain("Approved Paperclip Standing Rules");
    expect(messages[0]!.content).toContain("Verify totals before reporting them.");
    expect(messages[1]!.content).toContain("CORRECTION comment 22222222-2222-4222-8222-222222222222");
    expect(messages[1]!.content).toContain("POST /api/companies/{companyId}/approvals");
    expect(messages[1]!.content).toContain("$PAPERCLIP_API_KEY");
    expect(messages[1]!.content).toContain("never apply the proposed rule directly");
    expect(messages[1]!.content).not.toContain('"reply":');
    const approvalRequest = requests.find(request => request.url.endsWith("/api/companies/c/approvals"));
    expect(approvalRequest?.body).toMatchObject({
      type: "instruction_change",
      issueIds: ["11111111-1111-4111-8111-111111111111"],
      payload: {
        sourceCommentId: "22222222-2222-4222-8222-222222222222",
        rule: "Verify totals before reporting them.",
      },
    });
    expect(requests.find(request => request.url.endsWith("/api/issues/11111111-1111-4111-8111-111111111111/comments"))?.body).toEqual({
      body: "Drafted 1 standing rule proposal for board approval. Approval: approval-1.",
      idempotencyKey: expect.stringMatching(/^ollama\.correction-receipt:v1_[a-f0-9]{64}$/),
    });
  });
  it("turns an instruction revision wake into a resubmit of the same approval", async () => {
    const ctx = await context();
    ctx.config.paperclipSkillSync = { desiredSkills: [] };
    ctx.authToken = "agent-token";
    const issueId = "11111111-1111-4111-8111-111111111111";
    const approvalId = "33333333-3333-4333-8333-333333333333";
    ctx.context.paperclipWake = {
      reason: "approval_revision_requested",
      issue: { id: issueId, title: "Correct behavior" },
      approvalRevision: {
        approvalId,
        approvalStatus: "revision_requested",
        decisionNote: "Require a cited source.",
        revisionCycle: "2026-10-15T10:00:00.000Z",
        sourceIssueId: issueId,
        sourceCommentId: "22222222-2222-4222-8222-222222222222",
        targetAgentId: "a",
        scope: "agent",
        rule: "Verify totals before reporting.",
      },
    };
    const requests = provider({
      chatContent: JSON.stringify({ revision: { approvalId, scope: "agent", rule: "Verify totals against a cited source before reporting.", rationale: "Adds the requested evidence requirement." } }),
    });

    expect((await execute(ctx)).exitCode).toBe(0);
    const chat = requests.find(request => request.url.endsWith("/api/chat"))!.body!;
    expect((chat.messages as Array<{ content: string }>)[1]!.content).toContain("Require a cited source.");
    expect((chat.messages as Array<{ content: string }>)[1]!.content).toContain(`approval ${approvalId}`);
    expect(chat.truncate).toBe(false);
    expect(chat.shift).toBe(false);
    expect(requests.find(request => request.url.endsWith(`/api/approvals/${approvalId}/resubmit`))?.body).toEqual({
      revisionCycle: "2026-10-15T10:00:00.000Z",
      payload: {
        version: 1,
        scope: "agent",
        targetAgentId: "a",
        sourceIssueId: issueId,
        sourceCommentId: "22222222-2222-4222-8222-222222222222",
        rule: "Verify totals against a cited source before reporting.",
        rationale: "Adds the requested evidence requirement.",
      },
    });
    expect(requests.some(request => request.url.endsWith("/api/companies/c/approvals"))).toBe(false);
    expect(requests.find(request => request.url.endsWith(`/api/issues/${issueId}/comments`))?.body).toEqual({
      body: `Revised standing rule approval ${approvalId} and resubmitted it for board review.`,
      idempotencyKey: expect.stringMatching(/^ollama\.instruction-revision-receipt:v1_[a-f0-9]{64}$/),
    });
  });
  it("accepts a retry when the instruction approval is already pending", async () => {
    const ctx = await context();
    ctx.config.paperclipSkillSync = { desiredSkills: [] };
    ctx.authToken = "agent-token";
    const issueId = "11111111-1111-4111-8111-111111111111";
    const approvalId = "33333333-3333-4333-8333-333333333333";
    ctx.context.paperclipWake = {
      reason: "approval_revision_requested",
      issue: { id: issueId },
      approvalRevision: {
        approvalId,
        decisionNote: "Clarify the source requirement.",
        revisionCycle: "2026-10-15T10:00:00.000Z",
        sourceIssueId: issueId,
        sourceCommentId: "22222222-2222-4222-8222-222222222222",
        targetAgentId: "a",
        scope: "agent",
        rule: "Verify totals.",
      },
    };
    const requests = provider({
      resubmitStatuses: [422],
      approvalReadStatus: "pending",
      approvalReadPayload: {
        version: 1,
        scope: "agent",
        targetAgentId: "a",
        sourceIssueId: issueId,
        sourceCommentId: "22222222-2222-4222-8222-222222222222",
        rule: "Verify totals against the cited source.",
      },
      chatContent: JSON.stringify({ revision: { approvalId, scope: "agent", rule: "Verify totals against the cited source." } }),
    });

    expect((await execute(ctx)).exitCode).toBe(0);
    expect(requests.some(request => request.url.endsWith(`/api/approvals/${approvalId}`))).toBe(true);
    expect(requests.filter(request => request.url.endsWith(`/api/issues/${issueId}/comments`))).toHaveLength(1);
  });
  it("accepts a lost-response retry when Ollama regenerates different wording", async () => {
    const ctx = await context();
    ctx.config.paperclipSkillSync = { desiredSkills: [] };
    ctx.authToken = "agent-token";
    const issueId = "11111111-1111-4111-8111-111111111111";
    const approvalId = "33333333-3333-4333-8333-333333333333";
    ctx.context.paperclipWake = {
      reason: "approval_revision_requested",
      issue: { id: issueId },
      approvalRevision: {
        approvalId,
        decisionNote: "Clarify the source requirement.",
        revisionCycle: "2026-10-15T10:00:00.000Z",
        sourceIssueId: issueId,
        sourceCommentId: "22222222-2222-4222-8222-222222222222",
        targetAgentId: "a",
        scope: "agent",
        rule: "Verify totals.",
      },
    };
    const requests = provider({
      resubmitStatuses: [422],
      approvalReadStatus: "pending",
      approvalReadUpdatedAt: "2026-10-15T10:00:00.001Z",
      approvalReadPayload: {
        version: 1,
        scope: "agent",
        targetAgentId: "a",
        sourceIssueId: issueId,
        sourceCommentId: "22222222-2222-4222-8222-222222222222",
        rule: "Previously generated wording that already landed.",
      },
      chatContent: JSON.stringify({ revision: { approvalId, scope: "agent", rule: "Different wording generated by the retry." } }),
    });

    expect((await execute(ctx)).exitCode).toBe(0);
    expect(requests.some(request => request.url.endsWith(`/api/approvals/${approvalId}`))).toBe(true);
    expect(requests.filter(request => request.url.endsWith(`/api/issues/${issueId}/comments`))).toHaveLength(1);
  });
  it("does not claim a resubmit when the board resolved the revision request first", async () => {
    const ctx = await context();
    ctx.config.paperclipSkillSync = { desiredSkills: [] };
    ctx.authToken = "agent-token";
    const issueId = "11111111-1111-4111-8111-111111111111";
    const approvalId = "33333333-3333-4333-8333-333333333333";
    ctx.context.paperclipWake = {
      reason: "approval_revision_requested",
      issue: { id: issueId },
      approvalRevision: {
        approvalId,
        decisionNote: "Clarify the source requirement.",
        revisionCycle: "2026-10-15T10:00:00.000Z",
        sourceIssueId: issueId,
        sourceCommentId: "22222222-2222-4222-8222-222222222222",
        targetAgentId: "a",
        scope: "agent",
        rule: "Verify totals.",
      },
    };
    const requests = provider({
      resubmitStatuses: [422],
      approvalReadStatus: "approved",
      approvalReadUpdatedAt: "2026-10-15T10:00:00.001Z",
      approvalReadPayload: { version: 1, scope: "agent", targetAgentId: "a", sourceIssueId: issueId, sourceCommentId: "22222222-2222-4222-8222-222222222222", rule: "Verify totals." },
      chatContent: JSON.stringify({ revision: { approvalId, scope: "agent", rule: "Different wording generated by the retry." } }),
    });

    expect((await execute(ctx)).exitCode).toBe(0);
    expect(requests.find(request => request.url.endsWith(`/api/issues/${issueId}/comments`))?.body?.body)
      .toBe(`Standing rule approval ${approvalId} is already approved; this retry made no further change.`);
  });
  it("uses a different receipt key for a later revision cycle", async () => {
    const ctx = await context();
    ctx.config.paperclipSkillSync = { desiredSkills: [] };
    ctx.authToken = "agent-token";
    const issueId = "11111111-1111-4111-8111-111111111111";
    const approvalId = "33333333-3333-4333-8333-333333333333";
    const revision = {
      approvalId,
      decisionNote: "Clarify the source requirement.",
      revisionCycle: "2026-10-15T10:00:00.000Z",
      sourceIssueId: issueId,
      sourceCommentId: "22222222-2222-4222-8222-222222222222",
      targetAgentId: "a",
      scope: "agent",
      rule: "Verify totals.",
    };
    ctx.context.paperclipWake = { reason: "approval_revision_requested", issue: { id: issueId }, approvalRevision: revision };
    const requests = provider({
      chatContent: JSON.stringify({ revision: { approvalId, scope: "agent", rule: "Verify totals against the cited source." } }),
    });

    expect((await execute(ctx)).exitCode).toBe(0);
    ctx.context.paperclipWake = {
      reason: "approval_revision_requested",
      issue: { id: issueId },
      approvalRevision: { ...revision, revisionCycle: "2026-10-15T11:00:00.000Z" },
    };
    expect((await execute(ctx)).exitCode).toBe(0);

    const receiptKeys = requests
      .filter(request => request.url.endsWith(`/api/issues/${issueId}/comments`))
      .map(request => request.body?.idempotencyKey);
    expect(receiptKeys).toHaveLength(2);
    expect(receiptKeys[0]).not.toBe(receiptKeys[1]);
  });
  it("submits a coalesced new correction before accepting an already resolved revision retry", async () => {
    const ctx = await context();
    ctx.config.paperclipSkillSync = { desiredSkills: [] };
    ctx.authToken = "agent-token";
    const issueId = "11111111-1111-4111-8111-111111111111";
    const approvalId = "33333333-3333-4333-8333-333333333333";
    const correctionId = "44444444-4444-4444-8444-444444444444";
    const revisedPayload = {
      version: 1,
      scope: "agent",
      targetAgentId: "a",
      sourceIssueId: issueId,
      sourceCommentId: "22222222-2222-4222-8222-222222222222",
      rule: "Verify totals against the cited source.",
    };
    ctx.context.paperclipWake = {
      reason: "approval_revision_requested",
      issue: { id: issueId },
      approvalRevision: {
        approvalId,
        decisionNote: "Clarify the source requirement.",
        revisionCycle: "2026-10-15T10:00:00.000Z",
        sourceIssueId: issueId,
        sourceCommentId: revisedPayload.sourceCommentId,
        targetAgentId: "a",
        scope: "agent",
        rule: "Verify totals.",
      },
      comments: [{ id: correctionId, issueId, intent: "correction", body: "Also verify dates." }],
    };
    const requests = provider({
      resubmitStatuses: [422],
      approvalReadStatus: "approved",
      approvalReadPayload: revisedPayload,
      chatContent: JSON.stringify({
        revision: { approvalId, scope: "agent", rule: revisedPayload.rule },
        proposals: [{ sourceCommentId: correctionId, scope: "agent", rule: "Verify dates before reporting." }],
      }),
    });

    expect((await execute(ctx)).exitCode).toBe(0);
    const correctionIndex = requests.findIndex(request => request.url.endsWith("/api/companies/c/approvals"));
    const resubmitIndex = requests.findIndex(request => request.url.endsWith(`/api/approvals/${approvalId}/resubmit`));
    expect(correctionIndex).toBeGreaterThan(-1);
    expect(correctionIndex).toBeLessThan(resubmitIndex);
    expect(requests.some(request => request.url.endsWith(`/api/approvals/${approvalId}`))).toBe(true);
  });
  it("checks approved rules against a small running context without attached procedures", async () => {
    const ctx = await context();
    ctx.config.paperclipSkillSync = { desiredSkills: [] };
    ctx.context.paperclipApprovedRulesMarkdown = `- ${"Always verify source evidence. ".repeat(80)}`;
    const requests = provider({ contextLength: 1_500 });
    const result = await execute(ctx);
    expect(result.errorCode).toBe("procedure_context_too_small");
    expect(result.errorMessage).toContain("approved rules");
    expect(requests.some(request => /\/api\/(chat|tags|pull)$/.test(request.url))).toBe(false);
  });
  it("supplies every correction without dropping older comments and disables provider truncation", async () => {
    const ctx = await context();
    ctx.config.paperclipSkillSync = { desiredSkills: [] };
    ctx.authToken = "agent-token";
    const issueId = "11111111-1111-4111-8111-111111111111";
    const comments = Array.from({ length: 7 }, (_, index) => ({
      id: `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`,
      issueId,
      intent: "correction" as const,
      body: `Complete correction ${index + 1}`,
    }));
    ctx.context.paperclipWake = {
      issue: { id: issueId, title: "Apply every correction" },
      commentIds: comments.map(comment => comment.id),
      correctionCommentSources: comments.map(comment => ({ id: comment.id, issueId })),
      commentWindow: { requestedCount: comments.length, includedCount: 5, missingCount: 0 },
      comments: comments.slice(0, 5),
      fallbackFetchNeeded: true,
    };
    const proposals = comments.map((comment, index) => ({
      sourceCommentId: comment.id,
      scope: "agent",
      rule: `Standing rule ${index + 1}`,
    }));
    const requests = provider({
      comments: Object.fromEntries(comments.slice(5).map(comment => [comment.id, comment])),
      chatContent: JSON.stringify({ proposals }),
    });
    expect((await execute(ctx)).exitCode).toBe(0);
    const request = requests.find(request => request.url.endsWith("/api/chat"))!.body!;
    const prompt = (request.messages as Array<{ content: string }>)[1]!.content;
    for (const comment of comments) expect(prompt).toContain(comment.body);
    expect(request.truncate).toBe(false);
    expect(request.shift).toBe(false);
    expect(requests.filter(request => request.url.endsWith("/api/companies/c/approvals"))).toHaveLength(7);
    expect(requests.filter(request => /\/api\/issues\/[^/]+\/comments\/[^/]+$/.test(request.url))).toHaveLength(2);
  });
  it("preserves an ordinary reply while submitting an omitted correction from a mixed wake", async () => {
    const ctx = await context();
    ctx.config.paperclipSkillSync = { desiredSkills: [] };
    ctx.authToken = "agent-token";
    const issueId = "11111111-1111-4111-8111-111111111111";
    const correctionId = "22222222-2222-4222-8222-222222222222";
    const comments = Array.from({ length: 8 }, (_, index) => ({
      id: `ordinary-${index}`,
      issueId,
      intent: "message" as const,
      body: index === 7 ? "Please also explain the corrected total." : "Ordinary message",
    }));
    ctx.context.paperclipWake = {
      issue: { id: issueId, title: "Discover the omitted correction" },
      commentIds: [...comments.map(comment => comment.id), correctionId],
      comments,
      correctionCommentSources: [{ id: correctionId, issueId }],
      commentWindow: { requestedCount: 9, includedCount: 8, missingCount: 0 },
      fallbackFetchNeeded: true,
    };
    const body = "Always verify the full source before reporting totals, including this required ending.";
    const requests = provider({
      comments: { [correctionId]: { id: correctionId, issueId, intent: "correction", body } },
      chatContent: JSON.stringify({ reply: "The corrected total is 42.", proposals: [{ sourceCommentId: correctionId, scope: "agent", rule: "Verify source totals before reporting." }] }),
    });
    expect((await execute(ctx)).exitCode).toBe(0);
    const chatIndex = requests.findIndex(request => request.url.endsWith("/api/chat"));
    expect(requests.findIndex(request => request.url.endsWith(`/comments/${correctionId}`))).toBeLessThan(chatIndex);
    const prompt = ((requests[chatIndex]!.body!.messages as Array<{ content: string }>)[1]!.content);
    expect(prompt).toContain(`CORRECTION comment ${correctionId}`);
    expect(prompt).toContain(body);
    expect(prompt).toContain("instruction_change");
    expect(prompt).toContain("This Ollama adapter has no tools");
    expect(prompt).toContain('"reply":"concise response that addresses the ordinary comments"');
    const approvalIndex = requests.findIndex(request => request.url.endsWith("/api/companies/c/approvals"));
    expect(requests[approvalIndex]?.body).toMatchObject({
      issueIds: [issueId], payload: { sourceCommentId: correctionId, sourceIssueId: issueId },
    });
    const ordinaryReplyIndex = requests.findIndex(request => request.url.endsWith(`/api/issues/${issueId}/comments`) && request.body?.body === "The corrected total is 42.");
    const approvalReceiptIndex = requests.findIndex(request => request.url.endsWith(`/api/issues/${issueId}/comments`) && request.body?.body === "Drafted 1 standing rule proposal for board approval. Approval: approval-1.");
    const statusIndex = requests.findIndex(request => request.url.endsWith(`/api/issues/${issueId}`));
    expect(ordinaryReplyIndex).toBeGreaterThan(chatIndex);
    expect(requests[ordinaryReplyIndex]?.body?.idempotencyKey).toMatch(/^ollama\.mixed:v1_[a-f0-9]{64}$/);
    expect(approvalIndex).toBeGreaterThan(ordinaryReplyIndex);
    expect(approvalReceiptIndex).toBeGreaterThan(approvalIndex);
    expect(statusIndex).toBeGreaterThan(approvalReceiptIndex);
  });
  it("uses one durable receipt across two successful correction executions", async () => {
    const ctx = await context();
    ctx.config.paperclipSkillSync = { desiredSkills: [] };
    ctx.authToken = "agent-token";
    const issueId = "11111111-1111-4111-8111-111111111111";
    const correctionId = "22222222-2222-4222-8222-222222222222";
    ctx.context.paperclipWake = {
      issue: { id: issueId },
      comments: [{ id: correctionId, issueId, intent: "correction", body: "Always verify the total." }],
    };
    const requests = provider({
      chatContent: JSON.stringify({ proposals: [{ sourceCommentId: correctionId, scope: "agent", rule: "Verify totals before reporting." }] }),
    });

    expect((await execute(ctx)).exitCode).toBe(0);
    expect((await execute(ctx)).exitCode).toBe(0);

    const receiptPosts = requests.filter(request =>
      request.url.endsWith(`/api/issues/${issueId}/comments`) &&
      String(request.body?.body ?? "").startsWith("Drafted 1 standing rule proposal"));
    expect(receiptPosts).toHaveLength(2);
    expect(receiptPosts[0]?.body?.idempotencyKey).toMatch(/^ollama\.correction-receipt:v1_[a-f0-9]{64}$/);
    expect(receiptPosts[1]?.body?.idempotencyKey).toBe(receiptPosts[0]?.body?.idempotencyKey);

    const statusPatches = requests.filter(request =>
      request.url.endsWith(`/api/issues/${issueId}`) && request.body?.status === "in_review");
    expect(statusPatches).toHaveLength(2);
  });
  it("rejects a mixed correction response that omits the ordinary reply", async () => {
    const ctx = await context();
    ctx.config.paperclipSkillSync = { desiredSkills: [] };
    ctx.authToken = "agent-token";
    const issueId = "11111111-1111-4111-8111-111111111111";
    const correctionId = "22222222-2222-4222-8222-222222222222";
    ctx.context.paperclipWake = {
      issue: { id: issueId },
      comments: [
        { id: "ordinary-1", issueId, intent: "message", body: "Please answer this request too." },
        { id: correctionId, issueId, intent: "correction", body: "Always verify the total." },
      ],
    };
    const requests = provider({
      chatContent: JSON.stringify({ proposals: [{ sourceCommentId: correctionId, scope: "agent", rule: "Verify totals before reporting." }] }),
    });
    const result = await execute(ctx);
    expect(result.errorCode).toBe("ollama_correction_draft_invalid");
    expect(result.errorMessage).toContain("non-empty ordinary reply");
    expect(requests.some(request => request.url.endsWith("/approvals"))).toBe(false);
    expect(requests.some(request => request.url.endsWith(`/api/issues/${issueId}/comments`))).toBe(false);
  });
  it("keeps the ordinary reply when a later mixed-wake approval fails", async () => {
    const ctx = await context();
    ctx.config.paperclipSkillSync = { desiredSkills: [] };
    ctx.authToken = "agent-token";
    const issueId = "11111111-1111-4111-8111-111111111111";
    const correctionId = "22222222-2222-4222-8222-222222222222";
    ctx.context.paperclipWake = {
      issue: { id: issueId },
      comments: [
        { id: "ordinary-1", issueId, intent: "message", body: "Please answer the ordinary request." },
        { id: correctionId, issueId, intent: "correction", body: "Always verify the total." },
      ],
    };
    const requests = provider({
      approvalStatus: 500,
      chatContent: JSON.stringify({ reply: "Here is the ordinary answer.", proposals: [{ sourceCommentId: correctionId, scope: "agent", rule: "Verify totals before reporting." }] }),
    });
    const result = await execute(ctx);
    expect(result.errorCode).toBe("ollama_correction_approval_failed");
    expect(result.summary).toBe("Here is the ordinary answer.");
    const ordinaryReplyIndex = requests.findIndex(request => request.url.endsWith(`/api/issues/${issueId}/comments`) && request.body?.body === "Here is the ordinary answer.");
    const approvalIndex = requests.findIndex(request => request.url.endsWith("/api/companies/c/approvals"));
    expect(ordinaryReplyIndex).toBeGreaterThan(-1);
    expect(approvalIndex).toBeGreaterThan(ordinaryReplyIndex);
    expect(requests.filter(request => request.url.endsWith(`/api/issues/${issueId}/comments`))).toHaveLength(1);
    expect(requests.some(request => String(request.body?.body ?? "").includes("Drafted 1 standing rule proposal"))).toBe(false);
    expect(requests.some(request => request.url.endsWith(`/api/issues/${issueId}`))).toBe(false);
  });
  it("uses the same ordinary-reply idempotency key when an approval failure retries the wake", async () => {
    const ctx = await context();
    ctx.config.paperclipSkillSync = { desiredSkills: [] };
    ctx.authToken = "agent-token";
    const issueId = "11111111-1111-4111-8111-111111111111";
    const correctionId = "22222222-2222-4222-8222-222222222222";
    ctx.context.paperclipWake = {
      issue: { id: issueId },
      commentIds: ["ordinary-1", correctionId],
      comments: [
        { id: "ordinary-1", issueId, intent: "message", body: "Please answer once." },
        { id: correctionId, issueId, intent: "correction", body: "Always verify the total." },
      ],
    };
    const requests = provider({
      approvalStatuses: [500, 201],
      chatContent: JSON.stringify({ reply: "One durable answer.", proposals: [{ sourceCommentId: correctionId, scope: "agent", rule: "Verify totals before reporting." }] }),
    });

    expect((await execute(ctx)).errorCode).toBe("ollama_correction_approval_failed");
    expect((await execute(ctx)).exitCode).toBe(0);
    const ordinaryPosts = requests.filter(request =>
      request.url.endsWith(`/api/issues/${issueId}/comments`) && request.body?.body === "One durable answer.");
    expect(ordinaryPosts).toHaveLength(2);
    expect(ordinaryPosts[0]?.body?.idempotencyKey).toMatch(/^ollama\.mixed:v1_[a-f0-9]{64}$/);
    expect(ordinaryPosts[1]?.body?.idempotencyKey).toBe(ordinaryPosts[0]?.body?.idempotencyKey);
    expect(requests.filter(request => String(request.body?.body ?? "").includes("Drafted 1 standing rule proposal"))).toHaveLength(1);
    expect(requests.filter(request => request.url.endsWith(`/api/issues/${issueId}`))).toHaveLength(1);
  });
  it("keeps ordinary wakes to the last five inline comments and 600 characters without fetching omitted comments", async () => {
    const ctx = await context();
    ctx.config.paperclipSkillSync = { desiredSkills: [] };
    ctx.authToken = "agent-token";
    const issueId = "11111111-1111-4111-8111-111111111111";
    const comments = Array.from({ length: 8 }, (_, index) => ({
      id: `ordinary-${index}`,
      issueId,
      intent: "message" as const,
      authorUserName: `Author ${index}`,
      body: index === 7 ? `${"x".repeat(600)}CUT-ME` : `Ordinary message ${index}`,
    }));
    ctx.context.paperclipWake = {
      issue: { id: issueId, title: "Keep the compact prompt" },
      commentIds: [...comments.map(comment => comment.id), "omitted-ordinary"],
      commentWindow: { requestedCount: 9, includedCount: 8, missingCount: 1 },
      comments,
      fallbackFetchNeeded: true,
    };
    const requests = provider();
    expect((await execute(ctx)).exitCode).toBe(0);
    const request = requests.find(request => request.url.endsWith("/api/chat"))!.body!;
    const prompt = (request.messages as Array<{ content: string }>)[1]!.content;
    expect(prompt).not.toContain("Ordinary message 2");
    expect(prompt).toContain("Ordinary message 3");
    expect(prompt).toContain(`- Author 7: ${"x".repeat(600)}`);
    expect(prompt).not.toContain("CUT-ME");
    expect(request).not.toHaveProperty("truncate");
    expect(request).not.toHaveProperty("shift");
    expect(requests.map(request => request.url.split("/").pop())).toEqual(["tags", "chat", "comments", "11111111-1111-4111-8111-111111111111"]);
  });
  it.each([
    { issueId: "another-issue" },
    { issueId: undefined },
    { intent: "message" },
    { bodyTruncated: true },
  ])("refuses incomplete or mismatched correction source responses before inference: %j", async (override) => {
    const ctx = await context();
    ctx.config.paperclipSkillSync = { desiredSkills: [] };
    ctx.authToken = "agent-token";
    const issueId = "11111111-1111-4111-8111-111111111111";
    const id = "22222222-2222-4222-8222-222222222222";
    ctx.context.paperclipWake = {
      issue: { id: issueId },
      commentIds: [id],
      correctionCommentSources: [{ id, issueId }],
      fallbackFetchNeeded: true,
    };
    const requests = provider({ comments: { [id]: { id, issueId, intent: "correction", body: "Complete body", ...override } } });
    expect((await execute(ctx)).errorCode).toBe("ollama_correction_context_incomplete");
    expect(requests.some(request => /\/api\/(chat|tags|version|ps)$/.test(request.url) || request.url.endsWith("/approvals"))).toBe(false);
  });
  it("fetches a truncated correction and supplies its complete text", async () => {
    const ctx = await context();
    ctx.config.paperclipSkillSync = { desiredSkills: [] };
    ctx.authToken = "agent-token";
    const issueId = "11111111-1111-4111-8111-111111111111";
    const commentId = "22222222-2222-4222-8222-222222222222";
    ctx.context.paperclipWake = {
      issue: { id: issueId, title: "Load the full correction" },
      commentIds: [commentId],
      commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
      comments: [{ id: commentId, issueId, intent: "correction", body: "Truncated start", bodyTruncated: true }],
      fallbackFetchNeeded: true,
    };
    const fullBody = `Truncated start plus the complete required ending ${"with detail ".repeat(80)}`;
    const requests = provider({
      comments: { [commentId]: { id: commentId, issueId, intent: "correction", body: fullBody } },
      chatContent: JSON.stringify({ proposals: [{ sourceCommentId: commentId, scope: "agent", rule: "Preserve the complete correction." }] }),
    });
    expect((await execute(ctx)).exitCode).toBe(0);
    const prompt = ((requests.find(request => request.url.endsWith("/api/chat"))!.body!.messages as Array<{ content: string }>)[1]!.content);
    expect(prompt).toContain(fullBody);
    expect(prompt).not.toContain("[comment body truncated]");
    expect(requests.some(request => request.url.endsWith(`/api/issues/${issueId}/comments/${commentId}`))).toBe(true);
  });
  it("stops clearly when a truncated correction cannot be fetched", async () => {
    const ctx = await context();
    ctx.config.paperclipSkillSync = { desiredSkills: [] };
    ctx.context.paperclipWake = {
      issue: { id: "11111111-1111-4111-8111-111111111111", title: "Incomplete correction" },
      comments: [{ id: "22222222-2222-4222-8222-222222222222", intent: "correction", body: "partial", bodyTruncated: true }],
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await execute(ctx);
    expect(result.errorCode).toBe("ollama_correction_context_incomplete");
    expect(result.errorMessage).toContain("cannot fetch");
    expect(fetchMock).not.toHaveBeenCalled();
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
  it("fetches an omitted correction and submits its exact source through real local HTTP", async () => {
    const ctx = await context();
    ctx.config.paperclipSkillSync = { desiredSkills: [] };
    ctx.authToken = "fixture-token";
    const issueId = "11111111-1111-4111-8111-111111111111";
    const id = "22222222-2222-4222-8222-222222222222";
    const body = "Verify the source before reporting any totals, including every required ending.";
    ctx.context.paperclipWake = { issue: { id: issueId }, correctionCommentSources: [{ id, issueId }], fallbackFetchNeeded: true };
    const received: Array<{ url: string; authorization?: string; runId?: string; body: Record<string, unknown> }> = [];
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const requestBody = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      received.push({ url: req.url!, authorization: req.headers.authorization, runId: req.headers["x-paperclip-run-id"] as string, body: requestBody });
      res.setHeader("Content-Type", "application/json");
      if (req.url === `/api/issues/${issueId}/comments/${id}`) res.end(JSON.stringify({ id, issueId, intent: "correction", body }));
      else if (req.url === "/api/version") res.end(JSON.stringify({ version: "0.14.0" }));
      else if (req.url === "/api/ps") res.end(JSON.stringify({ models: [{ name: "fixture:latest", context_length: 16384 }] }));
      else if (req.url === "/api/tags") res.end(JSON.stringify({ models: [{ name: "fixture:latest" }] }));
      else if (req.url === "/api/chat") res.end(JSON.stringify({ message: { content: JSON.stringify({ proposals: [{ sourceCommentId: id, scope: "agent", rule: "Verify source totals before reporting." }] }) } }));
      else if (req.url === "/api/companies/c/approvals") { res.statusCode = 201; res.end(JSON.stringify({ id: "approval-1" })); }
      else if (req.url === `/api/issues/${issueId}/comments` || req.url === `/api/issues/${issueId}`) res.end(JSON.stringify({ id: issueId }));
      else { res.statusCode = 404; res.end("{}"); }
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      ctx.config.ollamaBaseUrl = apiUrl;
      vi.stubEnv("PAPERCLIP_RUNTIME_API_URL", apiUrl);
      expect((await execute(ctx)).exitCode).toBe(0);
      expect(received[0]).toMatchObject({ url: `/api/issues/${issueId}/comments/${id}`, authorization: "Bearer fixture-token" });
      const chat = received.find(request => request.url === "/api/chat")!;
      expect((chat.body.messages as Array<{ content: string }>)[1]!.content).toContain(body);
      expect(chat.body).toMatchObject({ truncate: false, shift: false });
      expect(received.find(request => request.url === "/api/companies/c/approvals")).toMatchObject({
        authorization: "Bearer fixture-token", runId: "test",
        body: { type: "instruction_change", issueIds: [issueId], payload: { sourceIssueId: issueId, sourceCommentId: id } },
      });
    } finally {
      vi.unstubAllEnvs();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
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
