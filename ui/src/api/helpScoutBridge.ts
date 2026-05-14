import { pluginsApi } from "./plugins";

export const HELP_SCOUT_PLUGIN_KEY = "help-scout";

export interface HSMailbox {
  accountKey: string;
  mailboxId: string;
  name: string;
  email: string;
}

export interface HSConversationCustomer {
  email: string | null;
  name: string | null;
}

/** Matches `SlimConversation` in paperclip-extensions/plugins/help-scout/src/worker.ts. */
export interface HSConversationSummary {
  id: string;
  number: number | null;
  subject: string | null;
  status: string | null;
  mailboxId: string | null;
  customer: HSConversationCustomer | null;
  assignedTo: string | null;
  tags: string[];
  modifiedAt: string | null;
  /** Latest-message snippet (~150 chars). Optional — older plugin versions
   *  (≤ 0.5.3) don't return it; treat as missing rather than assuming string. */
  preview?: string | null;
}

export interface HSThread {
  id: number;
  type: string;
  body?: string;
  text?: string;
  createdBy?: { type?: string; email?: string; first?: string; last?: string };
  customer?: { email?: string; first?: string; last?: string };
  createdAt?: string;
  state?: string;
}

/** Full conversation as Help Scout returns it; we keep this loose because the
 *  embed=threads payload is rich and we only need a few fields. */
export interface HSConversationFull {
  id: number;
  number?: number;
  subject?: string;
  status?: string;
  mailboxId?: number;
  tags?: Array<{ tag?: string }>;
  primaryCustomer?: { email?: string; first?: string; last?: string };
  customer?: { email?: string; first?: string; last?: string };
  assignee?: { id?: number; email?: string; first?: string; last?: string };
  userUpdatedAt?: string;
  modifiedAt?: string;
  _embedded?: { threads?: HSThread[] };
  [key: string]: unknown;
}

export type HSStatusFilter = "open" | "active" | "pending" | "closed" | "spam" | "all";

export interface ListConversationsOptions {
  accountKey?: string;
  mailboxId?: string;
  status?: HSStatusFilter;
  tag?: string;
  assignedTo?: string;
  since?: string;
  query?: string;
  limit?: number;
  page?: number;
}

function extract<T>(result: { data: unknown }): T {
  return result.data as T;
}

export function makeHelpScoutBridgeApi(pluginId: string, companyId: string) {
  return {
    listMailboxes: async (accountKey?: string): Promise<{ mailboxes: HSMailbox[] }> => {
      const result = await pluginsApi.bridgeGetData(
        pluginId,
        "helpscout.list-mailboxes",
        { companyId, ...(accountKey ? { accountKey } : {}) },
        companyId,
      );
      return extract(result);
    },

    listConversations: async (
      opts: ListConversationsOptions,
    ): Promise<{
      conversations: HSConversationSummary[];
      totalCount: number;
      page: number;
      totalPages: number;
    }> => {
      const result = await pluginsApi.bridgeGetData(
        pluginId,
        "helpscout.list-conversations",
        { companyId, ...opts },
        companyId,
      );
      return extract(result);
    },

    getConversation: async (
      accountKey: string,
      conversationId: string,
    ): Promise<HSConversationFull> => {
      const result = await pluginsApi.bridgeGetData(
        pluginId,
        "helpscout.get-conversation",
        { companyId, accountKey, conversationId },
        companyId,
      );
      return extract(result);
    },

    sendReply: async (
      accountKey: string,
      conversationId: string,
      body: string,
      opts?: { customerEmail?: string; cc?: string[]; bcc?: string[]; imported?: boolean },
    ): Promise<{ ok: true }> => {
      const result = await pluginsApi.bridgePerformAction(
        pluginId,
        "helpscout.send-reply",
        { companyId, accountKey, conversationId, body, ...opts },
        companyId,
      );
      return extract(result);
    },

    addNote: async (
      accountKey: string,
      conversationId: string,
      body: string,
      opts?: { userId?: string },
    ): Promise<{ ok: true }> => {
      const result = await pluginsApi.bridgePerformAction(
        pluginId,
        "helpscout.add-note",
        { companyId, accountKey, conversationId, body, ...opts },
        companyId,
      );
      return extract(result);
    },

    changeStatus: async (
      accountKey: string,
      conversationId: string,
      status: "active" | "pending" | "closed" | "spam",
    ): Promise<{ id: string; status: string }> => {
      const result = await pluginsApi.bridgePerformAction(
        pluginId,
        "helpscout.change-status",
        { companyId, accountKey, conversationId, status },
        companyId,
      );
      return extract(result);
    },

    addLabel: async (
      accountKey: string,
      conversationId: string,
      labels: string[],
    ): Promise<{ id: string; tags: string[] }> => {
      const result = await pluginsApi.bridgePerformAction(
        pluginId,
        "helpscout.add-label",
        { companyId, accountKey, conversationId, labels },
        companyId,
      );
      return extract(result);
    },

    removeLabel: async (
      accountKey: string,
      conversationId: string,
      labels: string[],
    ): Promise<{ id: string; tags: string[] }> => {
      const result = await pluginsApi.bridgePerformAction(
        pluginId,
        "helpscout.remove-label",
        { companyId, accountKey, conversationId, labels },
        companyId,
      );
      return extract(result);
    },
  };
}

export type HelpScoutBridgeApi = ReturnType<typeof makeHelpScoutBridgeApi>;
