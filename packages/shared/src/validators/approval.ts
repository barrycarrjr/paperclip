import { z } from "zod";
import { APPROVAL_TYPES } from "../constants.js";
import { multilineTextSchema } from "./text.js";

export const instructionChangePayloadSchema = z.object({
  version: z.literal(1),
  scope: z.enum(["agent", "company"]),
  targetAgentId: z.string().uuid(),
  sourceIssueId: z.string().uuid(),
  sourceCommentId: z.string().uuid(),
  rule: multilineTextSchema.pipe(z.string().trim().min(1).max(4000)),
  rationale: multilineTextSchema.pipe(z.string().trim().min(1).max(4000)).optional(),
}).strict();

export type InstructionChangePayload = z.infer<typeof instructionChangePayloadSchema>;

export const createApprovalSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  requestedByAgentId: z.string().uuid().optional().nullable(),
  payload: z.record(z.unknown()),
  issueIds: z.array(z.string().uuid()).optional(),
});

export type CreateApproval = z.infer<typeof createApprovalSchema>;

export const resolveApprovalSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
});

export type ResolveApproval = z.infer<typeof resolveApprovalSchema>;

export const requestApprovalRevisionSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
});

export type RequestApprovalRevision = z.infer<typeof requestApprovalRevisionSchema>;

export const resubmitApprovalSchema = z.object({
  payload: z.record(z.unknown()).optional(),
  revisionCycle: z.string().datetime().optional(),
});

export type ResubmitApproval = z.infer<typeof resubmitApprovalSchema>;

export const addApprovalCommentSchema = z.object({
  body: multilineTextSchema.pipe(z.string().min(1)),
});

export type AddApprovalComment = z.infer<typeof addApprovalCommentSchema>;
