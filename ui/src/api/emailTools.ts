import { pluginsApi } from "./plugins";

export const EMAIL_TOOLS_PLUGIN_KEY = "email-tools";

export interface MailboxInfo {
  key: string;
  name: string;
  pollFolder: string;
}

export interface MailHeader {
  uid: number;
  messageId: string | null;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  unseen: boolean;
}

export interface ParsedEmailMessage {
  uid: number;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: string;
  fromAddress: string | null;
  to: string[];
  cc: string[];
  subject: string;
  date: string;
  text: string;
  html: string;
  markdown: string;
  attachments: Array<{ name: string; mime: string; size: number; partId: string }>;
}

export interface ListMessagesOptions {
  folder?: string;
  unseen?: boolean;
  limit?: number;
}

function extract<T>(result: { data: unknown }): T {
  return result.data as T;
}

export function makeEmailToolsApi(pluginId: string, companyId: string) {
  return {
    listMailboxes: async (): Promise<{ mailboxes: MailboxInfo[] }> => {
      const result = await pluginsApi.bridgeGetData(pluginId, "email.list-mailboxes", { companyId }, companyId);
      return extract(result);
    },

    listMessages: async (mailbox: string, opts?: ListMessagesOptions): Promise<{ messages: MailHeader[]; uidValidity: number }> => {
      const result = await pluginsApi.bridgeGetData(
        pluginId,
        "email.list-messages",
        { companyId, mailbox, ...opts },
        companyId,
      );
      return extract(result);
    },

    fetchMessage: async (mailbox: string, uid: number, folder?: string): Promise<ParsedEmailMessage> => {
      const result = await pluginsApi.bridgeGetData(
        pluginId,
        "email.fetch-message",
        { companyId, mailbox, uid, ...(folder ? { folder } : {}) },
        companyId,
      );
      return extract(result);
    },

    listFolders: async (mailbox: string): Promise<{ folders: string[] }> => {
      const result = await pluginsApi.bridgeGetData(
        pluginId,
        "email.list-folders",
        { companyId, mailbox },
        companyId,
      );
      return extract(result);
    },

    moveMessage: async (
      mailbox: string,
      uid: number,
      folder: string,
      targetFolder: string,
    ): Promise<{ ok: boolean; movedCount: number }> => {
      const result = await pluginsApi.bridgePerformAction(
        pluginId,
        "email.move-message",
        { companyId, mailbox, uid, folder, targetFolder },
        companyId,
      );
      return extract(result);
    },

    markRead: async (mailbox: string, uid: number, folder: string): Promise<{ ok: boolean }> => {
      const result = await pluginsApi.bridgePerformAction(
        pluginId,
        "email.mark-read",
        { companyId, mailbox, uid, folder },
        companyId,
      );
      return extract(result);
    },

    recordTriage: async (
      mailbox: string,
      uid: number,
      uidValidity: number,
      folder: string,
      action: string,
    ): Promise<{ ok: boolean }> => {
      const result = await pluginsApi.bridgePerformAction(
        pluginId,
        "email.record-triage",
        { companyId, mailbox, uid, uid_validity: uidValidity, folder, action },
        companyId,
      );
      return extract(result);
    },

    sendReply: async (
      mailbox: string,
      uid: number,
      folder: string,
      body: string,
      opts?: { body_html?: string; replyAll?: boolean },
    ): Promise<{ ok: boolean; messageId: string }> => {
      const result = await pluginsApi.bridgePerformAction(
        pluginId,
        "email.send-reply",
        { companyId, mailbox, uid, folder, body, ...opts },
        companyId,
      );
      return extract(result);
    },

    sendNew: async (
      mailbox: string,
      to: string | string[],
      subject: string,
      body: string,
      opts?: { cc?: string; bcc?: string; body_html?: string },
    ): Promise<{ ok: boolean; messageId: string }> => {
      const result = await pluginsApi.bridgePerformAction(
        pluginId,
        "email.send-new",
        { companyId, mailbox, to, subject, body, ...opts },
        companyId,
      );
      return extract(result);
    },
  };
}

export type EmailToolsApi = ReturnType<typeof makeEmailToolsApi>;
