import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import type { RoutineVariable } from "@paperclipai/shared";

export const routineTemplates = pgTable(
  "routine_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    routineTitle: text("routine_title").notNull(),
    routineDescription: text("routine_description"),
    priority: text("priority").notNull().default("medium"),
    concurrencyPolicy: text("concurrency_policy").notNull().default("coalesce_if_active"),
    catchUpPolicy: text("catch_up_policy").notNull().default("skip_missed"),
    variables: jsonb("variables").$type<RoutineVariable[]>().notNull().default([]),
    defaultAssigneeRole: text("default_assignee_role"),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nameIdx: index("routine_templates_name_idx").on(table.name),
  }),
);

export const routineTemplateTriggers = pgTable(
  "routine_template_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateId: uuid("template_id").notNull().references(() => routineTemplates.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    label: text("label"),
    enabled: boolean("enabled").notNull().default(true),
    cronExpression: text("cron_expression"),
    timezone: text("timezone"),
    signingMode: text("signing_mode"),
    replayWindowSec: integer("replay_window_sec"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    templateIdx: index("routine_template_triggers_template_idx").on(table.templateId, table.sortOrder),
  }),
);

export const agentTemplates = pgTable(
  "agent_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    agentName: text("agent_name").notNull(),
    role: text("role").notNull().default("general"),
    title: text("title"),
    icon: text("icon"),
    capabilities: text("capabilities"),
    adapterType: text("adapter_type").notNull().default("process"),
    adapterConfig: jsonb("adapter_config").$type<Record<string, unknown>>().notNull().default({}),
    runtimeConfig: jsonb("runtime_config").$type<Record<string, unknown>>().notNull().default({}),
    permissions: jsonb("permissions").$type<Record<string, unknown>>().notNull().default({}),
    forbiddenWritePaths: jsonb("forbidden_write_paths").$type<string[]>().notNull().default([]),
    budgetMonthlyCents: integer("budget_monthly_cents").notNull().default(0),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nameIdx: index("agent_templates_name_idx").on(table.name),
  }),
);

export const skillTemplates = pgTable(
  "skill_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    skillKey: text("skill_key").notNull(),
    skillName: text("skill_name").notNull(),
    skillDescription: text("skill_description"),
    markdown: text("markdown").notNull(),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nameIdx: index("skill_templates_name_idx").on(table.name),
    skillKeyUq: uniqueIndex("skill_templates_skill_key_idx").on(table.skillKey),
  }),
);

export const templateDeployments = pgTable(
  "template_deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateType: text("template_type").notNull(),
    templateId: uuid("template_id").notNull(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    deployedEntityId: uuid("deployed_entity_id"),
    deployedAt: timestamp("deployed_at", { withTimezone: true }).notNull().defaultNow(),
    deployedByUserId: text("deployed_by_user_id"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => ({
    templateIdx: index("template_deployments_template_idx").on(table.templateType, table.templateId),
    companyIdx: index("template_deployments_company_idx").on(table.companyId),
    templateCompanyUq: uniqueIndex("template_deployments_template_company_uq").on(
      table.templateType,
      table.templateId,
      table.companyId,
    ),
  }),
);
