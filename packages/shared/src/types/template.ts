import type { RoutineVariable } from "./routine.js";

export type TemplateType = "routine" | "agent" | "skill";

export interface RoutineTemplate {
  id: string;
  name: string;
  description: string | null;
  routineTitle: string;
  routineDescription: string | null;
  priority: string;
  concurrencyPolicy: string;
  catchUpPolicy: string;
  variables: RoutineVariable[];
  defaultAssigneeRole: string | null;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RoutineTemplateTrigger {
  id: string;
  templateId: string;
  kind: string;
  label: string | null;
  enabled: boolean;
  cronExpression: string | null;
  timezone: string | null;
  signingMode: string | null;
  replayWindowSec: number | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RoutineTemplateDetail extends RoutineTemplate {
  triggers: RoutineTemplateTrigger[];
  deployments: TemplateDeployment[];
}

export interface AgentTemplate {
  id: string;
  name: string;
  description: string | null;
  agentName: string;
  role: string;
  title: string | null;
  icon: string | null;
  capabilities: string | null;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  permissions: Record<string, unknown>;
  forbiddenWritePaths: string[];
  budgetMonthlyCents: number;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentTemplateDetail extends AgentTemplate {
  deployments: TemplateDeployment[];
}

export interface SkillTemplate {
  id: string;
  name: string;
  description: string | null;
  skillKey: string;
  skillName: string;
  skillDescription: string | null;
  markdown: string;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SkillTemplateDetail extends SkillTemplate {
  deployments: TemplateDeployment[];
}

export interface TemplateDeployment {
  id: string;
  templateType: TemplateType;
  templateId: string;
  companyId: string;
  companyName?: string;
  deployedEntityId: string | null;
  deployedAt: Date;
  deployedByUserId: string | null;
  lastSyncedAt: Date | null;
  metadata: Record<string, unknown>;
}

export type TemplateDeploymentStatus = "created" | "skipped" | "error";

export interface TemplateDeploymentResultItem {
  companyId: string;
  companyName: string;
  status: TemplateDeploymentStatus;
  deployedEntityId: string | null;
  message: string | null;
}

export interface TemplateDeploymentResult {
  templateType: TemplateType;
  templateId: string;
  results: TemplateDeploymentResultItem[];
}
