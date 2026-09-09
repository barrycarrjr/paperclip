import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  PluginCategory,
  PluginStatus,
  PaperclipPluginManifestV1,
  PluginOperationPolicy,
} from "@paperclipai/shared";

/**
 * `plugins` table — stores one row per installed plugin.
 *
 * Each plugin is uniquely identified by `plugin_key` (derived from
 * the manifest `id`). The full manifest is persisted as JSONB in
 * `manifest_json` so the host can reconstruct capability and UI
 * slot information without loading the plugin package.
 *
 * @see PLUGIN_SPEC.md §21.3
 */
export const plugins = pgTable(
  "plugins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pluginKey: text("plugin_key").notNull(),
    packageName: text("package_name").notNull(),
    version: text("version").notNull(),
    apiVersion: integer("api_version").notNull().default(1),
    categories: jsonb("categories").$type<PluginCategory[]>().notNull().default([]),
    manifestJson: jsonb("manifest_json").$type<PaperclipPluginManifestV1>().notNull(),
    status: text("status").$type<PluginStatus>().notNull().default("installed"),
    installOrder: integer("install_order"),
    /** Runtime package location (managed plugin directory for local-path / .pcplugin
     * installs; the npm node_modules path for npm installs). The worker entrypoint
     * is resolved relative to this directory. */
    packagePath: text("package_path"),
    /** Original source path supplied to `--local` installs. Persisted so a
     * Reinstall can re-read the freshly-rebuilt artifacts from the dev folder
     * and re-copy them into the managed directory. Null for npm and
     * .pcplugin uploads. */
    localSourcePath: text("local_source_path"),
    /**
     * Operator overrides for individual operations, keyed by operation key.
     *
     * The manifest says who each operation is FOR; this is how the operator
     * narrows that for their own install — switch one off, hide it from
     * agents, or require a human yes before an agent runs it.
     *
     * It can only narrow. A manifest that publishes an operation to users only
     * cannot be turned into an agent tool by config, so installing a plugin
     * never grants agents something its author did not publish to them.
     *
     * @see PLUGIN_SPEC.md §11.8 — Operator control over operations
     */
    operationPolicyJson: jsonb("operation_policy_json")
      .$type<PluginOperationPolicy>()
      .notNull()
      .default({}),
    lastError: text("last_error"),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pluginKeyIdx: uniqueIndex("plugins_plugin_key_idx").on(table.pluginKey),
    statusIdx: index("plugins_status_idx").on(table.status),
  }),
);
