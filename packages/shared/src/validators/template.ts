import { z } from "zod";
import {
  ISSUE_PRIORITIES,
  ROUTINE_CATCH_UP_POLICIES,
  ROUTINE_CONCURRENCY_POLICIES,
  ROUTINE_TRIGGER_SIGNING_MODES,
} from "../constants.js";
import { routineVariableSchema } from "./routine.js";
import { agentPermissionsSchema } from "./agent.js";

export const TEMPLATE_TYPES = ["routine", "agent", "skill"] as const;

export const templateTypeSchema = z.enum(TEMPLATE_TYPES);

const baseTemplateTriggerSchema = z.object({
  label: z.string().trim().max(120).optional().nullable(),
  enabled: z.boolean().optional().default(true),
  sortOrder: z.number().int().optional(),
});

export const routineTemplateTriggerInputSchema = z.discriminatedUnion("kind", [
  baseTemplateTriggerSchema.extend({
    kind: z.literal("schedule"),
    cronExpression: z.string().trim().min(1),
    timezone: z.string().trim().min(1).default("UTC"),
  }),
  baseTemplateTriggerSchema.extend({
    kind: z.literal("webhook"),
    signingMode: z.enum(ROUTINE_TRIGGER_SIGNING_MODES).optional().default("bearer"),
    replayWindowSec: z.number().int().min(30).max(86_400).optional().default(300),
  }),
  baseTemplateTriggerSchema.extend({
    kind: z.literal("api"),
  }),
]);
export type RoutineTemplateTriggerInput = z.infer<typeof routineTemplateTriggerInputSchema>;

export const createRoutineTemplateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().optional().nullable(),
  routineTitle: z.string().trim().min(1).max(200),
  routineDescription: z.string().optional().nullable(),
  priority: z.enum(ISSUE_PRIORITIES).optional().default("medium"),
  concurrencyPolicy: z.enum(ROUTINE_CONCURRENCY_POLICIES).optional().default("coalesce_if_active"),
  catchUpPolicy: z.enum(ROUTINE_CATCH_UP_POLICIES).optional().default("skip_missed"),
  variables: z.array(routineVariableSchema).optional().default([]),
  defaultAssigneeRole: z.string().trim().max(50).optional().nullable(),
  triggers: z.array(routineTemplateTriggerInputSchema).optional().default([]),
});
export type CreateRoutineTemplate = z.infer<typeof createRoutineTemplateSchema>;

export const updateRoutineTemplateSchema = createRoutineTemplateSchema.partial();
export type UpdateRoutineTemplate = z.infer<typeof updateRoutineTemplateSchema>;

export const createAgentTemplateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().optional().nullable(),
  agentName: z.string().trim().min(1).max(120),
  role: z.string().trim().min(1).max(50).optional().default("general"),
  title: z.string().trim().max(200).optional().nullable(),
  icon: z.string().trim().max(120).optional().nullable(),
  capabilities: z.string().optional().nullable(),
  adapterType: z.string().trim().min(1).max(80).optional().default("process"),
  adapterConfig: z.record(z.unknown()).optional().default({}),
  runtimeConfig: z.record(z.unknown()).optional().default({}),
  permissions: agentPermissionsSchema.partial().optional().default({}),
  forbiddenWritePaths: z.array(z.string().trim().min(1).max(500)).max(50).optional().default([]),
  budgetMonthlyCents: z.number().int().min(0).optional().default(0),
});
export type CreateAgentTemplate = z.infer<typeof createAgentTemplateSchema>;

export const updateAgentTemplateSchema = createAgentTemplateSchema.partial();
export type UpdateAgentTemplate = z.infer<typeof updateAgentTemplateSchema>;

export const createSkillTemplateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().optional().nullable(),
  skillKey: z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9-]*$/, "skillKey must be lowercase alphanumeric/hyphen"),
  skillName: z.string().trim().min(1).max(200),
  skillDescription: z.string().optional().nullable(),
  markdown: z.string().min(1),
});
export type CreateSkillTemplate = z.infer<typeof createSkillTemplateSchema>;

export const updateSkillTemplateSchema = createSkillTemplateSchema.partial();
export type UpdateSkillTemplate = z.infer<typeof updateSkillTemplateSchema>;

export const deployTemplateSchema = z.object({
  companyIds: z.array(z.string().uuid()).min(1).max(100),
  skipExisting: z.boolean().optional().default(true),
});
export type DeployTemplate = z.infer<typeof deployTemplateSchema>;
