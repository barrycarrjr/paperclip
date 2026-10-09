import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";
import { plugins } from "./plugins.js";

/**
 * `channel_user_links`: an account in an outside chat app (a Slack user, for
 * example) that a Paperclip user paired to themselves.
 *
 * A channel plugin never names the user it acts for. It hands over the chat
 * app's own identity of whoever sent a message, and the host looks the user
 * up here. A row only exists because that user, signed in to Paperclip,
 * entered a pairing code the plugin had sent to that chat account, which
 * proves the same person controls both.
 *
 * Links belong to one plugin installation: another plugin cannot use them,
 * and uninstalling the plugin removes them.
 */
export const channelUserLinks = pgTable(
  "channel_user_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pluginId: uuid("plugin_id").notNull().references(() => plugins.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    /** The chat app's workspace or team id (a Slack team id); empty when the app has none. */
    externalWorkspace: text("external_workspace").notNull().default(""),
    /** The chat app's own id for the person (a Slack user id). */
    externalUserId: text("external_user_id").notNull(),
    /** How the account was shown when it was paired, for the profile list. */
    externalLabel: text("external_label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => ({
    identityIdx: uniqueIndex("channel_user_links_identity_idx").on(
      table.pluginId,
      table.externalWorkspace,
      table.externalUserId,
    ),
    userIdx: index("channel_user_links_user_idx").on(table.userId),
  }),
);
