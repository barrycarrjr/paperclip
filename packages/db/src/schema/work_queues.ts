import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";

export const workQueues = pgTable(
  "work_queues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    defaultAssigneeAgentId: uuid("default_assignee_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    defaultProjectId: uuid("default_project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("work_queues_company_idx").on(table.companyId),
    companySlugUq: uniqueIndex("work_queues_company_slug_uq").on(table.companyId, table.slug),
  }),
);

export const workQueueItems = pgTable(
  "work_queue_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    queueId: uuid("queue_id").notNull().references(() => workQueues.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    externalSource: text("external_source"),
    externalId: text("external_id"),
    payload: jsonb("payload").notNull().default({}),
    status: text("status").notNull().default("pending"),
    priority: integer("priority").notNull().default(0),
    claimedByAgentId: uuid("claimed_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    queueIdx: index("work_queue_items_queue_idx").on(table.queueId),
    queueStatusIdx: index("work_queue_items_queue_status_idx").on(
      table.queueId,
      table.status,
      table.priority,
    ),
    queueExternalUq: uniqueIndex("work_queue_items_queue_external_uq").on(
      table.queueId,
      table.externalSource,
      table.externalId,
    ),
  }),
);
