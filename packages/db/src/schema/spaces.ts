import {
  type AnyPgColumn,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { documents } from "./documents.js";

/**
 * A Space: one company's shelf of pages, kept apart from its tasks. The
 * address key is the Space's part of its web address (/<company>/spaces/<key>)
 * and stays the same when the Space is renamed, so saved links keep working.
 */
export const spaces = pgTable(
  "spaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    urlKey: text("url_key").notNull(),
    description: text("description"),
    sortOrder: integer("sort_order").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUrlKeyUq: uniqueIndex("spaces_company_url_key_uq").on(table.companyId, table.urlKey),
    companySortIdx: index("spaces_company_sort_idx").on(table.companyId, table.sortOrder),
  }),
);

/**
 * A page in a Space, modelled on issue_documents: the page's title, text and
 * every version live in documents and document_revisions, the tables task,
 * case and pipeline documents share. A page with a parent is a subpage.
 */
export const spacePages = pgTable(
  "space_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    spaceId: uuid("space_id").notNull().references(() => spaces.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    parentPageId: uuid("parent_page_id").references((): AnyPgColumn => spacePages.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Set while the page is in its Space's trash. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /**
     * On a subpage that went to the trash with the page above it, that page,
     * so the two come back together. The page that was deleted has none, and
     * that is what the trash lists.
     */
    deletedWithPageId: uuid("deleted_with_page_id").references((): AnyPgColumn => spacePages.id, {
      onDelete: "cascade",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    documentUq: uniqueIndex("space_pages_document_uq").on(table.documentId),
    spaceParentSortIdx: index("space_pages_space_parent_sort_idx").on(
      table.spaceId,
      table.parentPageId,
      table.sortOrder,
    ),
    deletedWithIdx: index("space_pages_deleted_with_idx").on(table.deletedWithPageId),
  }),
);
