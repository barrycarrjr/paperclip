import type {
  AdapterAgent,
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { createHash } from "node:crypto";
import {
  asString,
  asNumber,
  parseObject,
  normalizePaperclipWakePayload,
  renderPaperclipApprovedRules,
  renderPaperclipCorrectionWorkflow,
} from "@paperclipai/adapter-utils/server-utils";
import {
  DEFAULT_OLLAMA_LOCAL_BASE_URL,
  DEFAULT_OLLAMA_LOCAL_MODEL,
} from "../index.js";
import { ensureOllamaModelPulled } from "./prepare.js";
import { appendSourceEvidenceInstructions } from "@paperclipai/adapter-utils/source-evidence";
import { runCountsPromptForWake } from "@paperclipai/adapter-utils/run-counts";
import { loadEphemeralProcedures, renderEphemeralProcedureContext, requireCompleteEphemeralProcedures, EphemeralProcedureError } from "@paperclipai/adapter-utils/ephemeral-skills";
import { assertOllamaProtectedContext, procedureModuleDir } from "./skills.js";

interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Resolve the URL of the Paperclip API that this adapter should call back into
 * to post comments. Mirrors the resolution order from buildPaperclipEnv so the
 * adapter and any spawned subprocess agree on which port to hit.
 */
function resolvePaperclipApiUrl(): string {
  const explicit = process.env.PAPERCLIP_RUNTIME_API_URL ?? process.env.PAPERCLIP_API_URL;
  if (explicit && explicit.trim().length > 0) return explicit.replace(/\/$/, "");
  const host = process.env.PAPERCLIP_LISTEN_HOST ?? process.env.HOST ?? "localhost";
  const port = process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100";
  // ::1 / 0.0.0.0 / loopback shorthands all fail to resolve as URLs; normalize.
  const safeHost = host === "0.0.0.0" || host === "::" || host === "::1" ? "localhost" : host;
  return `http://${safeHost}:${port}`;
}

interface PaperclipWakeIssueShape {
  id: string | null;
  identifier: string | null;
  title: string | null;
  status: string | null;
}

interface PaperclipWakeCommentShape {
  id?: string;
  issueId?: string;
  body?: string;
  bodyTruncated?: boolean;
  intent?: "message" | "correction";
  authorAgentName?: string | null;
  authorUserName?: string | null;
  createdAt?: string;
}

type InstructionRevisionWake = {
  approvalId: string;
  decisionNote: string | null;
  revisionCycle: string;
  sourceIssueId: string;
  sourceCommentId: string;
  targetAgentId: string;
  scope: "agent" | "company";
  rule: string;
};

function parseInstructionRevisionWake(wake: Record<string, unknown>): InstructionRevisionWake | null {
  if (asString(wake.reason, "") !== "approval_revision_requested") return null;
  const revision = parseObject(wake.approvalRevision);
  const approvalId = asString(revision.approvalId, "").trim();
  const revisionCycle = asString(revision.revisionCycle, "").trim();
  const sourceIssueId = asString(revision.sourceIssueId, "").trim();
  const sourceCommentId = asString(revision.sourceCommentId, "").trim();
  const targetAgentId = asString(revision.targetAgentId, "").trim();
  const scope = asString(revision.scope, "").trim();
  const rule = asString(revision.rule, "").trim();
  if (
    !approvalId || !revisionCycle || !sourceIssueId || !sourceCommentId || !targetAgentId || !rule ||
    (scope !== "agent" && scope !== "company")
  ) return null;
  return {
    approvalId,
    decisionNote: asString(revision.decisionNote, "").trim() || null,
    revisionCycle,
    sourceIssueId,
    sourceCommentId,
    targetAgentId,
    scope,
    rule,
  };
}

type CompleteWakeCommentsResult =
  | { ok: true; comments: PaperclipWakeCommentShape[] }
  | { ok: false; error: string };

async function loadCompleteWakeComments(input: {
  wake: Record<string, unknown>;
  issueId: string | null;
  apiUrl: string;
  authToken: string | null | undefined;
}): Promise<CompleteWakeCommentsResult> {
  const inlineComments = Array.isArray(input.wake.comments)
    ? (input.wake.comments as PaperclipWakeCommentShape[])
    : [];
  const inlineById = new Map(
    inlineComments
      .filter((comment): comment is PaperclipWakeCommentShape & { id: string } =>
        typeof comment.id === "string" && comment.id.length > 0)
      .map((comment) => [comment.id, comment]),
  );
  const correctionSources = normalizePaperclipWakePayload(input.wake)?.correctionCommentSources ?? [];
  const expectedCorrections = new Set(correctionSources.map((source) => source.id));
  for (const source of correctionSources) {
    if (source.issueId !== input.issueId) {
      return { ok: false, error: "A correction source does not belong to the wake issue, so Ollama cannot verify its provenance." };
    }
  }
  for (const comment of inlineComments) {
    if (comment.intent === "correction" && (!comment.id || typeof comment.id !== "string")) {
      return { ok: false, error: "A correction comment has no id, so Ollama cannot load its complete source text." };
    }
    if (comment.intent === "correction" && typeof comment.id === "string") expectedCorrections.add(comment.id);
    if (comment.intent === "correction" && comment.issueId && comment.issueId !== input.issueId) {
      return { ok: false, error: "A correction comment does not belong to the wake issue." };
    }
  }

  const idsToFetch = [...expectedCorrections].filter((id) => {
    const inline = inlineById.get(id);
    return !inline || (
      inline.intent !== "correction" ||
      inline.bodyTruncated === true || typeof inline.body !== "string" || inline.body.trim().length === 0
    );
  });
  if (idsToFetch.length > 0 && (!input.issueId || !input.authToken)) {
    return { ok: false, error: "The wake omitted or truncated comment text, and Ollama cannot fetch it without an issue id and agent API token." };
  }

  const fetched = new Map<string, PaperclipWakeCommentShape>();
  const fetchResults = await Promise.all(idsToFetch.map(async (commentId) => {
    try {
      const response = await fetch(
        `${input.apiUrl}/api/issues/${encodeURIComponent(input.issueId!)}/comments/${encodeURIComponent(commentId)}`,
        { headers: { Authorization: `Bearer ${input.authToken}` } },
      );
      if (!response.ok) return { commentId, error: `HTTP ${response.status}` } as const;
      const raw: unknown = await response.json();
      const comment = parseObject(raw);
      if (
        asString(comment.id, "") !== commentId ||
        comment.issueId !== input.issueId ||
        typeof comment.body !== "string" || comment.body.trim().length === 0 ||
        comment.bodyTruncated === true ||
        (expectedCorrections.has(commentId) && comment.intent !== "correction") ||
        (comment.intent !== "message" && comment.intent !== "correction")
      ) {
        return { commentId, error: "invalid comment response" } as const;
      }
      return {
        commentId,
        comment: {
          ...(comment as PaperclipWakeCommentShape),
          id: commentId,
          issueId: input.issueId!,
          body: comment.body,
          bodyTruncated: false,
          intent: comment.intent,
        },
      } as const;
    } catch (error) {
      return { commentId, error: error instanceof Error ? error.message : String(error) } as const;
    }
  }));
  for (const result of fetchResults) {
    if ("error" in result) {
      return { ok: false, error: `Cannot load complete comment ${result.commentId}: ${result.error}.` };
    }
    fetched.set(result.commentId, result.comment);
  }

  const comments = [...inlineComments];
  for (const correctionId of expectedCorrections) {
    const complete = fetched.get(correctionId);
    if (complete) {
      const inlineIndex = comments.findIndex((comment) => comment.id === correctionId);
      if (inlineIndex >= 0) comments[inlineIndex] = complete;
      else comments.push(complete);
    }
  }
  return { ok: true, comments };
}

/**
 * Build a tight, small-model-friendly prompt out of the wake context. The
 * default `renderPaperclipWakePrompt` produces ~1000 words of "execution
 * contract" boilerplate intended for frontier LLMs; a 7–14B local model
 * gets lost in it and ends up replying with generic acknowledgements
 * ("I'm ready to continue my Paperclip work…"). We extract just the parts
 * a thinking-class agent actually needs to write a useful reply.
 */
function buildLocalModelPrompt(input: {
  agent: AdapterAgent;
  context: Record<string, unknown>;
  comments: PaperclipWakeCommentShape[];
}): { issueId: string | null; issueIdentifier: string | null; correctionCommentIds: string[]; ordinaryReplyRequired: boolean; instructionRevision: InstructionRevisionWake | null; prompt: string } {
  const wake = parseObject(input.context.paperclipWake);
  const issue = parseObject(wake.issue) as Partial<PaperclipWakeIssueShape>;
  const comments = input.comments;
  const reason = typeof wake.reason === "string" ? wake.reason : null;
  const issueId = typeof issue.id === "string" ? issue.id : null;
  const issueIdentifier = typeof issue.identifier === "string" ? issue.identifier : null;
  const issueTitle = typeof issue.title === "string" ? issue.title : null;
  const issueStatus = typeof issue.status === "string" ? issue.status : null;
  const instructionRevision = parseInstructionRevisionWake(wake);

  const lines: string[] = [];
  if (issueIdentifier && issueTitle) {
    lines.push(`Issue ${issueIdentifier}: ${issueTitle}`);
  } else if (issueTitle) {
    lines.push(`Issue: ${issueTitle}`);
  }
  if (issueStatus) lines.push(`Status: ${issueStatus}`);
  if (reason && reason !== "manual_invoke") lines.push(`Wake reason: ${reason}`);

  const ordinaryComments = comments.filter((comment) => comment.intent !== "correction").slice(-5);
  const correctionComments = comments.filter((comment) => comment.intent === "correction");
  const ordinaryReplyRequired = ordinaryComments.some((comment) => (comment.body ?? "").trim().length > 0);
  if (ordinaryComments.length > 0 || correctionComments.length > 0) {
    lines.push("");
    lines.push("Recent comments:");
    for (const c of ordinaryComments) {
      const author = c.authorAgentName ?? c.authorUserName ?? "user";
      const body = (c.body ?? "").trim();
      if (body.length > 0) {
        lines.push(`- ${author}: ${body.slice(0, 600)}`);
      }
    }
    for (const c of correctionComments) {
      const author = c.authorAgentName ?? c.authorUserName ?? "user";
      const body = c.body ?? "";
      if (body.trim().length > 0) {
        lines.push(`- CORRECTION comment ${c.id ?? "unknown"} by ${author}: ${body}`);
      }
    }
  }

  const correctionCommentIds = comments
    .filter((comment) => comment.intent === "correction" && typeof comment.id === "string")
    .map((comment) => comment.id!);
  if (instructionRevision) {
    const proposalsExample = correctionCommentIds.length > 0
      ? `,"proposals":[{"sourceCommentId":"correction comment id","scope":"agent"|"company","rule":"exact proposed rule","rationale":"why this prevents the repeat"}]`
      : "";
    const responseExample = ordinaryReplyRequired
      ? `{"reply":"concise response that addresses the ordinary comments","revision":{"approvalId":"${instructionRevision.approvalId}","scope":"agent"|"company","rule":"exact revised rule","rationale":"why the revision addresses the request"}${proposalsExample}}`
      : `{"revision":{"approvalId":"${instructionRevision.approvalId}","scope":"agent"|"company","rule":"exact revised rule","rationale":"why the revision addresses the request"}${proposalsExample}}`;
    lines.push(
      "",
      `The board requested a revision to standing-rule approval ${instructionRevision.approvalId}.`,
      `Board request: ${instructionRevision.decisionNote ?? "Revise the proposal and resubmit it for approval."}`,
      `Current scope: ${instructionRevision.scope}`,
      `Current rule: ${instructionRevision.rule}`,
      "Revise the rule to address the board request. Paperclip will resubmit the same approval; do not create a new proposal.",
      ...(ordinaryReplyRequired ? ["This wake also contains ordinary comments. Answer those requests in the reply field."] : []),
      "Return only valid JSON in this form:",
      responseExample,
    );
    if (correctionCommentIds.length > 0) {
      lines.push(
        renderPaperclipCorrectionWorkflow(),
        "Include exactly one proposal for each correction comment listed above, alongside the revision.",
      );
    }
  } else if (correctionCommentIds.length > 0) {
    lines.push("", renderPaperclipCorrectionWorkflow());
    if (ordinaryReplyRequired) {
      lines.push(
        "",
        "This wake also contains ordinary comments. Answer those requests in the reply field and draft the correction approvals separately.",
        "This Ollama adapter has no tools. Return only valid JSON in this form so Paperclip can post the reply and submit the approvals through its HTTP API:",
        '`{"reply":"concise response that addresses the ordinary comments","proposals":[{"sourceCommentId":"correction comment id","scope":"agent"|"company","rule":"exact proposed rule","rationale":"why this prevents the repeat"}]}`',
        "The reply field is required and must address the ordinary comments. Include exactly one proposal for each correction comment listed above.",
      );
    } else {
      lines.push(
        "",
        "This Ollama adapter has no tools. Return only valid JSON in this form so Paperclip can submit the approval through its HTTP API:",
        '`{"proposals":[{"sourceCommentId":"correction comment id","scope":"agent"|"company","rule":"exact proposed rule","rationale":"why this prevents the repeat"}]}`',
        "Include exactly one proposal for each correction comment listed above.",
      );
    }
  }

  if (!instructionRevision && correctionCommentIds.length === 0) {
    lines.push("");
    lines.push(
      "Write a concise, helpful reply that addresses the issue. Your reply will be posted as a comment on this issue.",
    );
  }
  const countsInstructions = runCountsPromptForWake(wake);
  if (countsInstructions) lines.push("", countsInstructions);

  return {
    issueId,
    issueIdentifier,
    correctionCommentIds,
    ordinaryReplyRequired,
    instructionRevision,
    prompt: lines.join("\n"),
  };
}

type CorrectionProposal = {
  sourceCommentId: string;
  scope: "agent" | "company";
  rule: string;
  rationale?: string;
};

type InstructionRevisionProposal = {
  approvalId: string;
  scope: "agent" | "company";
  rule: string;
  rationale?: string;
};

function parseInstructionRevisionResponse(
  value: string,
  expectedApprovalId: string,
  ordinaryReplyRequired: boolean,
): { proposal: InstructionRevisionProposal; reply: string | null } | null {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const record = parseObject(parsed);
  const revision = parseObject(record.revision);
  const approvalId = asString(revision.approvalId, "").trim();
  const scope = asString(revision.scope, "").trim();
  const rule = asString(revision.rule, "").trim();
  const rationale = asString(revision.rationale, "").trim();
  const reply = asString(record.reply, "").trim();
  if (ordinaryReplyRequired && !reply) return null;
  if (approvalId !== expectedApprovalId || (scope !== "agent" && scope !== "company") || !rule) return null;
  return {
    proposal: { approvalId, scope, rule, ...(rationale ? { rationale } : {}) },
    reply: reply || null,
  };
}

function parseCorrectionResponse(
  value: string,
  expectedCommentIds: string[],
  ordinaryReplyRequired: boolean,
): { proposals: CorrectionProposal[]; reply: string | null } | null {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const record = parseObject(parsed);
  if (!Array.isArray(record.proposals) || record.proposals.length !== expectedCommentIds.length) return null;
  const reply = asString(record.reply, "").trim();
  if (ordinaryReplyRequired && !reply) return null;
  const expected = new Set(expectedCommentIds);
  const proposals: CorrectionProposal[] = [];
  for (const item of record.proposals) {
    const proposal = parseObject(item);
    const sourceCommentId = asString(proposal.sourceCommentId, "").trim();
    const scope = asString(proposal.scope, "").trim();
    const rule = asString(proposal.rule, "").trim();
    const rationale = asString(proposal.rationale, "").trim();
    if (!expected.delete(sourceCommentId) || (scope !== "agent" && scope !== "company") || !rule) return null;
    proposals.push({ sourceCommentId, scope, rule, ...(rationale ? { rationale } : {}) });
  }
  return expected.size === 0 ? { proposals, reply: reply || null } : null;
}

async function createInstructionApproval(input: {
  apiUrl: string;
  authToken: string;
  runId: string;
  companyId: string;
  agentId: string;
  issueId: string;
  proposal: CorrectionProposal;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<{ ok: boolean; approvalId?: string; error?: string }> {
  try {
    const res = await fetch(`${input.apiUrl}/api/companies/${input.companyId}/approvals`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.authToken}`,
        "X-Paperclip-Run-Id": input.runId,
      },
      body: JSON.stringify({
        type: "instruction_change",
        requestedByAgentId: input.agentId,
        issueIds: [input.issueId],
        payload: {
          version: 1,
          scope: input.proposal.scope,
          targetAgentId: input.agentId,
          sourceIssueId: input.issueId,
          sourceCommentId: input.proposal.sourceCommentId,
          rule: input.proposal.rule,
          ...(input.proposal.rationale ? { rationale: input.proposal.rationale } : {}),
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 300)}` };
    }
    const body = parseObject(await res.json().catch(() => null));
    const approvalId = asString(body.id, "").trim();
    await input.onLog("stdout", `[paperclip] Created instruction change approval${approvalId ? ` ${approvalId}` : ""}.\n`);
    return { ok: true, ...(approvalId ? { approvalId } : {}) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function resubmitInstructionApproval(input: {
  apiUrl: string;
  authToken: string;
  runId: string;
  revision: InstructionRevisionWake;
  proposal: InstructionRevisionProposal;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<{ ok: boolean; outcome?: "resubmitted" | "terminal"; terminalStatus?: "approved" | "rejected"; error?: string }> {
  const url = `${input.apiUrl}/api/approvals/${encodeURIComponent(input.revision.approvalId)}/resubmit`;
  const payload = {
    version: 1,
    scope: input.proposal.scope,
    targetAgentId: input.revision.targetAgentId,
    sourceIssueId: input.revision.sourceIssueId,
    sourceCommentId: input.revision.sourceCommentId,
    rule: input.proposal.rule,
    ...(input.proposal.rationale ? { rationale: input.proposal.rationale } : {}),
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.authToken}`,
        "X-Paperclip-Run-Id": input.runId,
      },
      body: JSON.stringify({ payload, revisionCycle: input.revision.revisionCycle }),
    });
    if (!res.ok) {
      // A process retry can repeat after the first response was lost. If this
      // approval is already pending, the same durable resubmit has landed.
      if (res.status === 422) {
        const current = await fetch(
          `${input.apiUrl}/api/approvals/${encodeURIComponent(input.revision.approvalId)}`,
          { headers: { Authorization: `Bearer ${input.authToken}` } },
        );
        const currentBody = current.ok ? parseObject(await current.json().catch(() => null)) : {};
        const currentPayload = parseObject(currentBody.payload);
        const currentUpdatedAt = Date.parse(asString(currentBody.updatedAt, ""));
        const revisionRequestedAt = Date.parse(input.revision.revisionCycle);
        const sameRevisionLanded =
          currentPayload.scope === payload.scope &&
          currentPayload.targetAgentId === payload.targetAgentId &&
          currentPayload.sourceIssueId === payload.sourceIssueId &&
          currentPayload.sourceCommentId === payload.sourceCommentId &&
          currentPayload.rule === payload.rule &&
          (currentPayload.rationale ?? null) === (payload.rationale ?? null);
        const revisionCycleHandled =
          Number.isFinite(currentUpdatedAt) &&
          Number.isFinite(revisionRequestedAt) &&
          currentUpdatedAt > revisionRequestedAt;
        if (currentBody.status === "pending" && (sameRevisionLanded || revisionCycleHandled)) {
          await input.onLog("stdout", `[paperclip] Instruction change approval ${input.revision.approvalId} was already resubmitted.\n`);
          return { ok: true, outcome: "resubmitted" };
        }
        if (
          (currentBody.status === "approved" || currentBody.status === "rejected") &&
          (sameRevisionLanded || revisionCycleHandled)
        ) {
          await input.onLog("stdout", `[paperclip] Instruction change approval ${input.revision.approvalId} was already ${currentBody.status}.\n`);
          return { ok: true, outcome: "terminal", terminalStatus: currentBody.status };
        }
      }
      const body = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 300)}` };
    }
    await input.onLog("stdout", `[paperclip] Resubmitted instruction change approval ${input.revision.approvalId}.\n`);
    return { ok: true, outcome: "resubmitted" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function postReplyAsComment(input: {
  apiUrl: string;
  authToken: string;
  issueId: string;
  body: string;
  idempotencyKey?: string;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<{ ok: boolean; error?: string }> {
  const url = `${input.apiUrl}/api/issues/${input.issueId}/comments`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.authToken}`,
      },
      body: JSON.stringify({
        body: input.body,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      await input.onLog(
        "stderr",
        `[paperclip] Failed to post comment: HTTP ${res.status} ${errText.slice(0, 300)}\n`,
      );
      return { ok: false, error: `HTTP ${res.status}` };
    }
    await input.onLog("stdout", `[paperclip] Posted reply as comment on issue ${input.issueId}.\n`);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await input.onLog("stderr", `[paperclip] Comment POST threw: ${message}\n`);
    return { ok: false, error: message };
  }
}

function mixedReplyIdempotencyKey(input: {
  agentId: string;
  issueId: string;
  comments: PaperclipWakeCommentShape[];
  correctionCommentIds: string[];
}) {
  const sourceCommentIds = [...new Set([
    ...input.comments.flatMap((comment) => typeof comment.id === "string" ? [comment.id] : []),
    ...input.correctionCommentIds,
  ])].sort();
  const digest = createHash("sha256")
    .update(JSON.stringify({
      agentId: input.agentId,
      issueId: input.issueId,
      sourceCommentIds,
    }))
    .digest("hex");
  return `ollama.mixed:v1_${digest}`;
}

function correctionReceiptIdempotencyKey(input: {
  agentId: string;
  issueId: string;
  correctionCommentIds: string[];
}) {
  const sourceCommentIds = [...new Set(input.correctionCommentIds)].sort();
  const digest = createHash("sha256")
    .update(JSON.stringify({
      agentId: input.agentId,
      issueId: input.issueId,
      sourceCommentIds,
    }))
    .digest("hex");
  return `ollama.correction-receipt:v1_${digest}`;
}

function revisionReceiptIdempotencyKey(input: { agentId: string; issueId: string; approvalId: string; revisionCycle: string; correctionCommentIds: string[] }) {
  const digest = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
  return `ollama.instruction-revision-receipt:v1_${digest}`;
}

/**
 * After posting the reply as a comment, transition the issue out of
 * `in_progress` so Paperclip's run-liveness watchdog stops re-waking the
 * agent. Without this, every Q&A reply lives forever in the `in_progress`
 * column and `wakeReason: issue_continuation_needed` fires every ~30s.
 *
 * `in_review` is the right default for thinking-class agents — "I answered,
 * a human can review and either close or follow up." Users who want
 * different behavior (e.g. auto-close to "done", or no transition at all)
 * can override via the `completionStatus` adapter config field.
 */
async function transitionIssueStatus(input: {
  apiUrl: string;
  authToken: string;
  issueId: string;
  status: string;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<{ ok: boolean; error?: string }> {
  const url = `${input.apiUrl}/api/issues/${input.issueId}`;
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.authToken}`,
      },
      body: JSON.stringify({ status: input.status }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      await input.onLog(
        "stderr",
        `[paperclip] Failed to set issue status to ${input.status}: HTTP ${res.status} ${errText.slice(0, 300)}\n`,
      );
      return { ok: false, error: `HTTP ${res.status}` };
    }
    await input.onLog(
      "stdout",
      `[paperclip] Marked issue ${input.issueId} as "${input.status}".\n`,
    );
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await input.onLog("stderr", `[paperclip] Issue status PATCH threw: ${message}\n`);
    return { ok: false, error: message };
  }
}

interface OllamaChatResponse {
  model?: string;
  message?: { role?: string; content?: string };
  done?: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

function defaultSystemPromptForAgent(agent: AdapterAgent): string {
  const capabilities =
    typeof agent.adapterConfig === "object" && agent.adapterConfig !== null
      ? (agent.adapterConfig as Record<string, unknown>).capabilities
      : null;
  // Capabilities text on the agent itself takes priority, then the row's
  // capabilities column (if surfaced via the agent record), then a generic
  // fallback. The wake prompt itself carries the actual task.
  const fromConfig = typeof capabilities === "string" ? capabilities.trim() : "";
  if (fromConfig) return fromConfig;
  return (
    `You are ${agent.name}, an agent in the Paperclip system. ` +
    `Read the wake prompt below carefully and respond with a clear, concise reply ` +
    `that fulfills the request. Do not propose code edits unless explicitly asked. ` +
    `When the wake prompt mentions a Paperclip issue, your reply should be suitable ` +
    `for posting as a comment on that issue.`
  );
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, authToken } = ctx;
  const cfg = parseObject(config);
  const baseUrl = asString(cfg.ollamaBaseUrl, DEFAULT_OLLAMA_LOCAL_BASE_URL).replace(/\/$/, "");
  const model = asString(cfg.model, DEFAULT_OLLAMA_LOCAL_MODEL);
  const temperature = asNumber(cfg.temperature, NaN);
  const numPredict = asNumber(cfg.numPredict, 0);
  const timeoutSec = asNumber(cfg.timeoutSec, 600);
  const explicitSystem = asString(cfg.systemPrompt, "");
  let systemPrompt = appendSourceEvidenceInstructions(explicitSystem.length > 0 ? explicitSystem : defaultSystemPromptForAgent(agent));
  const approvedRules = renderPaperclipApprovedRules(context);
  if (approvedRules) systemPrompt = `${systemPrompt}\n\n${approvedRules}`;

  const wake = parseObject(context.paperclipWake);
  const wakeIssue = parseObject(wake.issue);
  const wakeIssueId = typeof wakeIssue.id === "string" ? wakeIssue.id : null;
  const completeComments = await loadCompleteWakeComments({
    wake,
    issueId: wakeIssueId,
    apiUrl: resolvePaperclipApiUrl(),
    authToken,
  });
  if (!completeComments.ok) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "ollama_correction_context_incomplete",
      errorMessage: completeComments.error,
      provider: "ollama",
      biller: "local",
      model,
      billingType: "subscription",
      costUsd: 0,
      summary: null,
    };
  }

  // Build a small-model-friendly prompt out of the wake context. The standard
  // renderPaperclipWakePrompt is too dense for 7B–14B local models — they
  // bury themselves in the "execution contract" boilerplate and reply with
  // generic acknowledgements instead of actually answering the issue.
  const { issueId, issueIdentifier, correctionCommentIds, ordinaryReplyRequired, instructionRevision, prompt: userPrompt } = buildLocalModelPrompt({
    agent,
    context,
    comments: completeComments.comments,
  });

  const procedures = await loadEphemeralProcedures(cfg, procedureModuleDir);
  try {
    requireCompleteEphemeralProcedures(procedures);
    if (procedures.procedures.length) {
      if ((ctx.executionTarget && ctx.executionTarget.kind !== "local") || (parseObject(context.paperclipEnvironment).driver && parseObject(context.paperclipEnvironment).driver !== "local")) throw new EphemeralProcedureError("procedure_environment_unsupported", "Ollama attached procedures support local execution only.");
      systemPrompt += "\n\n" + renderEphemeralProcedureContext(procedures.procedures);
    }
    if (procedures.procedures.length || approvedRules || correctionCommentIds.length > 0 || instructionRevision) {
      await assertOllamaProtectedContext(baseUrl, model, [systemPrompt, userPrompt], numPredict);
    }
  } catch (error) {
    return { exitCode: 1, signal: null, timedOut: false, errorCode: error instanceof EphemeralProcedureError ? error.code : "procedure_incomplete", errorMessage: error instanceof Error ? error.message : "Cannot load complete attached procedures.", provider: "ollama", biller: "local", model, billingType: "subscription", costUsd: 0, summary: null };
  }

  await onLog(
    "stdout",
    `[paperclip] ollama_local invoking ${baseUrl}/api/chat with model "${model}".\n`,
  );

  // Auto-pull the model if missing. Streams progress through onLog
  // ("[paperclip ollama] downloading 47%…").
  try {
    if (!procedures.procedures.length) await ensureOllamaModelPulled({ model, baseUrl, onLog });
  } catch (err) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: err instanceof Error ? err.message : String(err),
      errorCode: "ollama_unreachable",
      provider: "ollama",
      biller: "local",
      model,
      billingType: "subscription",
      costUsd: 0,
      summary: null,
    };
  }

  const messages: OllamaChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const requestBody: Record<string, unknown> = {
    model,
    messages,
    stream: false,
  };
  if (procedures.procedures.length || approvedRules || correctionCommentIds.length > 0 || instructionRevision) {
    requestBody.truncate = false;
    requestBody.shift = false;
  }
  const options: Record<string, unknown> = {};
  if (Number.isFinite(temperature)) options.temperature = temperature;
  if (numPredict > 0) options.num_predict = numPredict;
  if (Object.keys(options).length > 0) requestBody.options = options;

  const startedAt = Date.now();
  let res: Response;
  const controller = new AbortController();
  const timeoutHandle = timeoutSec > 0
    ? setTimeout(() => controller.abort(), timeoutSec * 1000)
    : null;
  try {
    res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (err) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: controller.signal.aborted,
      errorMessage:
        err instanceof Error
          ? err.name === "AbortError"
            ? `Ollama request timed out after ${timeoutSec}s`
            : err.message
          : String(err),
      errorCode: "ollama_unreachable",
      provider: "ollama",
      biller: "local",
      model,
      billingType: "subscription",
      costUsd: 0,
      summary: null,
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  const elapsedMs = Date.now() - startedAt;
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    await onLog("stderr", `[paperclip] Ollama responded HTTP ${res.status}: ${errText.slice(0, 500)}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Ollama returned HTTP ${res.status}: ${errText.slice(0, 200)}`,
      errorCode: res.status === 404 ? "ollama_model_not_pulled" : "ollama_request_failed",
      provider: "ollama",
      biller: "local",
      model,
      billingType: "subscription",
      costUsd: 0,
      summary: null,
    };
  }

  let body: OllamaChatResponse;
  try {
    body = (await res.json()) as OllamaChatResponse;
  } catch (err) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Failed to parse Ollama response: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: "ollama_response_parse_error",
      provider: "ollama",
      biller: "local",
      model,
      billingType: "subscription",
      costUsd: 0,
      summary: null,
    };
  }

  if (body.error) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: body.error,
      errorCode: "ollama_response_error",
      provider: "ollama",
      biller: "local",
      model,
      billingType: "subscription",
      costUsd: 0,
      summary: null,
    };
  }

  const modelReplyContent = body.message?.content ?? "";
  await onLog("stdout", modelReplyContent + "\n");
  let replyContent = modelReplyContent;
  let replyIdempotencyKey: string | undefined;
  if (instructionRevision) {
    if (!issueId || issueId !== instructionRevision.sourceIssueId || !authToken) {
      return { exitCode: 1, signal: null, timedOut: false, errorCode: "ollama_instruction_revision_unavailable", errorMessage: "Cannot resubmit the instruction revision without its source issue and agent API token.", provider: "ollama", biller: "local", model, billingType: "subscription", costUsd: 0, summary: null };
    }
    const revisionResponse = parseInstructionRevisionResponse(
      modelReplyContent,
      instructionRevision.approvalId,
      ordinaryReplyRequired,
    );
    if (!revisionResponse) {
      return { exitCode: 1, signal: null, timedOut: false, errorCode: "ollama_instruction_revision_invalid", errorMessage: "Ollama did not return one valid revision for the requested instruction approval. The approval was not changed.", provider: "ollama", biller: "local", model, billingType: "subscription", costUsd: 0, summary: null };
    }
    const correctionResponse = correctionCommentIds.length > 0
      ? parseCorrectionResponse(modelReplyContent, correctionCommentIds, ordinaryReplyRequired)
      : null;
    if (correctionCommentIds.length > 0 && !correctionResponse) {
      return { exitCode: 1, signal: null, timedOut: false, errorCode: "ollama_correction_draft_invalid", errorMessage: "Ollama did not return one valid standing-rule proposal for each new correction comment. No approval was changed.", provider: "ollama", biller: "local", model, billingType: "subscription", costUsd: 0, summary: null };
    }
    const apiUrl = resolvePaperclipApiUrl();
    if (ordinaryReplyRequired && revisionResponse.reply) {
      const ordinaryComment = await postReplyAsComment({
        apiUrl,
        authToken,
        issueId,
        body: revisionResponse.reply,
        idempotencyKey: mixedReplyIdempotencyKey({
          agentId: agent.id,
          issueId,
          comments: completeComments.comments,
          correctionCommentIds,
        }),
        onLog,
      });
      if (!ordinaryComment.ok) {
        return { exitCode: 1, signal: null, timedOut: false, errorCode: "ollama_mixed_reply_failed", errorMessage: `Could not post the ordinary reply before resubmitting the standing-rule approval: ${ordinaryComment.error ?? "unknown error"}`, provider: "ollama", biller: "local", model, billingType: "subscription", costUsd: 0, summary: revisionResponse.reply };
      }
    }
    const additionalApprovalIds: string[] = [];
    for (const proposal of correctionResponse?.proposals ?? []) {
      const created = await createInstructionApproval({ apiUrl, authToken, runId, companyId: agent.companyId, agentId: agent.id, issueId, proposal, onLog });
      if (!created.ok) {
        return { exitCode: 1, signal: null, timedOut: false, errorCode: "ollama_correction_approval_failed", errorMessage: `A new standing-rule approval could not be submitted before the requested revision: ${created.error ?? "unknown error"}`, provider: "ollama", biller: "local", model, billingType: "subscription", costUsd: 0, summary: revisionResponse.reply };
      }
      if (created.approvalId) additionalApprovalIds.push(created.approvalId);
    }
    const resubmitted = await resubmitInstructionApproval({
      apiUrl,
      authToken,
      runId,
      revision: instructionRevision,
      proposal: revisionResponse.proposal,
      onLog,
    });
    if (!resubmitted.ok) {
      return { exitCode: 1, signal: null, timedOut: false, errorCode: "ollama_instruction_revision_failed", errorMessage: `Could not resubmit the standing-rule approval: ${resubmitted.error ?? "unknown error"}`, provider: "ollama", biller: "local", model, billingType: "subscription", costUsd: 0, summary: null };
    }
    replyContent = resubmitted.outcome === "terminal"
      ? `Standing rule approval ${instructionRevision.approvalId} is already ${resubmitted.terminalStatus ?? "resolved"}; this retry made no further change.${additionalApprovalIds.length > 0 ? ` Drafted ${additionalApprovalIds.length} additional standing rule proposal${additionalApprovalIds.length === 1 ? "" : "s"}: ${additionalApprovalIds.join(", ")}.` : ""}`
      : `Revised standing rule approval ${instructionRevision.approvalId} and resubmitted it for board review.${additionalApprovalIds.length > 0 ? ` Drafted ${additionalApprovalIds.length} additional standing rule proposal${additionalApprovalIds.length === 1 ? "" : "s"}: ${additionalApprovalIds.join(", ")}.` : ""}`;
    replyIdempotencyKey = revisionReceiptIdempotencyKey({
      agentId: agent.id,
      issueId,
      approvalId: instructionRevision.approvalId,
      revisionCycle: instructionRevision.revisionCycle,
      correctionCommentIds,
    });
  } else if (correctionCommentIds.length > 0) {
    if (!issueId || !authToken) {
      return { exitCode: 1, signal: null, timedOut: false, errorCode: "ollama_correction_approval_unavailable", errorMessage: "Cannot submit the drafted correction approval without an issue and agent API token.", provider: "ollama", biller: "local", model, billingType: "subscription", costUsd: 0, summary: null };
    }
    const correctionResponse = parseCorrectionResponse(modelReplyContent, correctionCommentIds, ordinaryReplyRequired);
    if (!correctionResponse) {
      return { exitCode: 1, signal: null, timedOut: false, errorCode: "ollama_correction_draft_invalid", errorMessage: ordinaryReplyRequired ? "Ollama did not return a non-empty ordinary reply and one valid standing-rule proposal for each correction comment. No instruction change was submitted." : "Ollama did not return one valid standing-rule proposal for each correction comment. No instruction change was submitted.", provider: "ollama", biller: "local", model, billingType: "subscription", costUsd: 0, summary: null };
    }
    const apiUrl = resolvePaperclipApiUrl();
    if (ordinaryReplyRequired && correctionResponse.reply) {
      const ordinaryComment = await postReplyAsComment({
        apiUrl,
        authToken,
        issueId,
        body: correctionResponse.reply,
        idempotencyKey: mixedReplyIdempotencyKey({
          agentId: agent.id,
          issueId,
          comments: completeComments.comments,
          correctionCommentIds,
        }),
        onLog,
      });
      if (!ordinaryComment.ok) {
        return { exitCode: 1, signal: null, timedOut: false, errorCode: "ollama_mixed_reply_failed", errorMessage: `Could not post the ordinary reply before submitting standing-rule approvals: ${ordinaryComment.error ?? "unknown error"}`, provider: "ollama", biller: "local", model, billingType: "subscription", costUsd: 0, summary: correctionResponse.reply };
      }
    }
    const approvalIds: string[] = [];
    for (const proposal of correctionResponse.proposals) {
      const created = await createInstructionApproval({ apiUrl, authToken, runId, companyId: agent.companyId, agentId: agent.id, issueId, proposal, onLog });
      if (!created.ok) {
        return { exitCode: 1, signal: null, timedOut: false, errorCode: "ollama_correction_approval_failed", errorMessage: `Could not submit the standing-rule approval: ${created.error ?? "unknown error"}`, provider: "ollama", biller: "local", model, billingType: "subscription", costUsd: 0, summary: ordinaryReplyRequired ? correctionResponse.reply : null };
      }
      if (created.approvalId) approvalIds.push(created.approvalId);
    }
    const approvalReceipt = `Drafted ${correctionResponse.proposals.length} standing rule proposal${correctionResponse.proposals.length === 1 ? "" : "s"} for board approval.${approvalIds.length > 0 ? ` Approval${approvalIds.length === 1 ? "" : "s"}: ${approvalIds.join(", ")}.` : ""}`;
    replyContent = approvalReceipt;
    replyIdempotencyKey = correctionReceiptIdempotencyKey({
      agentId: agent.id,
      issueId,
      correctionCommentIds,
    });
  }

  // Post the reply as a comment on the wake issue. This is the *whole point*
  // of ollama_local — the model thinks, the adapter writes the answer to the
  // issue thread, the issue advances. Without this callback, replies vanish
  // into AdapterExecutionResult.summary and Paperclip's liveness watchdog
  // wakes the agent again ~30s later thinking nothing happened, looping
  // forever. Skip when:
  //   - There's no issue context (e.g. a pure manual heartbeat).
  //   - There's no auth token (shouldn't happen — heartbeat runtime always
  //     supplies one — but fail soft rather than crash).
  //   - The reply is empty.
  let commentPosted = false;
  let commentError: string | null = null;
  let statusTransitioned = false;
  let statusError: string | null = null;
  // Default to `in_review` — agent answered, human reviews. Override per-agent
  // via adapterConfig.completionStatus (allowed values: any ISSUE_STATUSES
  // member, plus "none" to skip the transition entirely).
  const completionStatus = asString(cfg.completionStatus, "in_review");
  if (issueId && replyContent.trim().length > 0) {
    if (authToken) {
      const apiUrl = resolvePaperclipApiUrl();
      const commentResult = await postReplyAsComment({
        apiUrl,
        authToken,
        issueId,
        body: replyContent.trim(),
        idempotencyKey: replyIdempotencyKey,
        onLog,
      });
      commentPosted = commentResult.ok;
      commentError = commentResult.ok ? null : commentResult.error ?? "unknown";

      if (commentPosted && completionStatus && completionStatus !== "none") {
        const statusResult = await transitionIssueStatus({
          apiUrl,
          authToken,
          issueId,
          status: completionStatus,
          onLog,
        });
        statusTransitioned = statusResult.ok;
        statusError = statusResult.ok ? null : statusResult.error ?? "unknown";
      }
    } else {
      await onLog(
        "stderr",
        `[paperclip] No authToken supplied to ollama_local; cannot post comment on issue ${issueIdentifier ?? issueId}. Reply remained as run summary only.\n`,
      );
      commentError = "missing_auth_token";
    }
  }

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    errorCode: null,
    usage:
      body.prompt_eval_count != null || body.eval_count != null
        ? {
            inputTokens: body.prompt_eval_count ?? 0,
            outputTokens: body.eval_count ?? 0,
          }
        : undefined,
    provider: "ollama",
    biller: "local",
    model: body.model ?? model,
    billingType: "subscription",
    costUsd: 0,
    summary: replyContent.length > 0 ? replyContent.slice(0, 4000) : null,
    resultJson: {
      ollamaBaseUrl: baseUrl,
      doneReason: body.done_reason ?? null,
      totalDurationMs: body.total_duration != null ? body.total_duration / 1_000_000 : null,
      requestElapsedMs: elapsedMs,
      issueId: issueId ?? null,
      issueIdentifier: issueIdentifier ?? null,
      commentPosted,
      commentError,
      completionStatus: completionStatus ?? null,
      statusTransitioned,
      statusError,
    },
  };
}
