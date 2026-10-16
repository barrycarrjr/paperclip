import { z } from "zod";
import { AGENT_ACTION_MODES, AGENT_ACTION_TYPES } from "../constants.js";

export const patchCompanyActionPolicySchema = z.object({
  actionType: z.enum(AGENT_ACTION_TYPES),
  mode: z.enum(AGENT_ACTION_MODES),
}).strict();

export const patchAgentActionPolicyOverrideSchema = z.object({
  actionType: z.enum(AGENT_ACTION_TYPES),
  mode: z.enum(AGENT_ACTION_MODES).nullable(),
}).strict();

export const companyActionPolicyPatchSchema = patchCompanyActionPolicySchema;
export const agentActionPolicyOverridePatchSchema = patchAgentActionPolicyOverrideSchema;

export type PatchCompanyActionPolicyInput = z.infer<typeof patchCompanyActionPolicySchema>;
export type PatchAgentActionPolicyOverrideInput = z.infer<typeof patchAgentActionPolicyOverrideSchema>;
