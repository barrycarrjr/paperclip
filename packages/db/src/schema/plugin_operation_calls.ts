import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";

/**
 * One row per attempt at a plugin operation that changes something, keyed so
 * the same attempt can never happen twice.
 *
 * The problem this solves: an agent calls a plugin operation that sends an
 * email, the call times out on the way back, and the agent — correctly, by its
 * own lights — calls again. Without a record of the first attempt the email
 * goes out twice, and the agent never learns that it did. The same shape
 * applies to creating an invoice, filing a ticket, or placing a call.
 *
 * How it works: before running a writing operation the host claims a row for
 * `(plugin, operation, idempotency key, company)`. A claim that conflicts with
 * an existing row means this exact call already happened, so the host replays
 * the stored result instead of running the operation again. On the agent lane
 * the key is derived from the run and the arguments when the caller does not
 * supply one, so a plugin author gets the protection without having to think
 * about it; the UI lane only dedupes when a key is passed explicitly, because
 * a person clicking "resync" twice usually means it.
 *
 * Rows carry `expires_at` so a retry window measured in minutes does not turn
 * into a table that grows forever.
 *
 * Additive only: nothing here alters an existing table, so rolling the whole
 * feature back is dropping this table alone.
 *
 * @see PLUGIN_SPEC.md §11.7 — Repeat-safe operations
 */
export const pluginOperationCalls = pgTable(
  "plugin_operation_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Plugin key from the manifest (e.g. `acme.linear`), not the database UUID. */
    pluginId: text("plugin_id").notNull(),
    /** Bare operation key or tool name, without the plugin namespace prefix. */
    operationKey: text("operation_key").notNull(),
    /**
     * The value that makes two calls "the same call". Either supplied by the
     * caller or derived by the host from the run id and the arguments.
     */
    idempotencyKey: text("idempotency_key").notNull(),

    /**
     * Company the call acts under. Null for an instance-admin global UI call,
     * which has no company to name. Two partial unique indexes cover the null
     * and non-null cases, because Postgres treats nulls as distinct and a
     * plain unique index would let global calls repeat freely.
     */
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),

    /**
     * `in_progress` | `succeeded` | `failed`.
     *
     * Text rather than an enum, matching every other status column in this
     * schema, so adding a state later does not need a migration.
     *
     * A second caller arriving while the first is still `in_progress` is
     * refused rather than queued: the whole point is that the side effect
     * happens once, and there is no result to replay yet.
     */
    status: text("status").notNull().default("in_progress"),

    /**
     * The `ToolResult` to hand back on a repeat. Stored for failures too — a
     * failed call is still a call that happened, and replaying the same
     * failure is more honest than running the operation again and possibly
     * succeeding the second time without the caller knowing why.
     */
    resultJson: jsonb("result_json"),

    /** Which lane the original call came in on: `agent` or `user`. */
    invokedBy: text("invoked_by").notNull().default("agent"),
    /** Agent run this belonged to, when there was one. Kept for audit only. */
    runId: text("run_id"),

    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** When this row stops being replayable and becomes eligible for cleanup. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    scopedKeyUq: uniqueIndex("plugin_operation_calls_scoped_key_uq")
      .on(table.pluginId, table.operationKey, table.idempotencyKey, table.companyId)
      .where(sql`${table.companyId} IS NOT NULL`),
    globalKeyUq: uniqueIndex("plugin_operation_calls_global_key_uq")
      .on(table.pluginId, table.operationKey, table.idempotencyKey)
      .where(sql`${table.companyId} IS NULL`),
    expiryIdx: index("plugin_operation_calls_expiry_idx").on(table.expiresAt),
  }),
);
