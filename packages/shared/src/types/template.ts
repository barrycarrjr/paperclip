import type { RoutineVariable } from "./routine.js";

export type TemplateType = "routine" | "agent" | "skill";

/** Tracks the upstream origin of a template imported from a library. Null
 *  on hand-authored templates. The Paperclip host compares `version` +
 *  `contentHash` against the latest templates-index.json to surface
 *  "Update available" badges and apply upstream changes. */
export interface TemplateSource {
  /** Library identifier. Currently always `"paperclip-extensions"`. */
  type: string;
  /** Canonical kebab-case id from the library (folder name). */
  name: string;
  /** Template kind in the library. May differ from where it landed in the
   *  host (a bundle install creates rows of several kinds from one source). */
  kind: "agent" | "routine" | "skill" | "bundle";
  /** Release tag the import came from, e.g. `"v23"`. */
  version: string;
  /** SHA-256 of the raw source file at import time. */
  contentHash: string;
  /** Path within the library repo, e.g. `"agents/phone-assistant/AGENT.md"`. */
  sourcePath: string;
  /** ISO-8601 timestamp when the row was last imported / synced. */
  importedAt: string;
  /** If the row was created as part of a bundle install, the bundle name. */
  bundleName?: string;
}

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
  source: TemplateSource | null;
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
  source: TemplateSource | null;
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
  source: TemplateSource | null;
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
