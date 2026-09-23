import { pluginsApi } from "./plugins";

export const EMAIL_TOOLS_PLUGIN_KEY = "email-tools";

export interface MailboxInfo {
  key: string;
  name: string;
  pollFolder: string;
  /**
   * The address mail actually leaves as, from the plugin's own resolver.
   * Null when the mailbox has no sending address configured — show the
   * mailbox name in that case rather than inventing one.
   */
  from?: string | null;
}

export interface MailHeader {
  uid: number;
  messageId: string | null;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  unseen: boolean;
  /** Replied to, from any mail program (the mailbox's \Answered flag). Absent from email-tools before 0.19. */
  answered?: boolean;
  /** Forwarded, from any mail program (the $Forwarded keyword). Absent from email-tools before 0.19. */
  forwarded?: boolean;
}

export interface EmailAttachmentMeta {
  name: string;
  mime: string;
  size: number;
  partId: string;
  /** True for parts the HTML body already shows (cid images). Hidden from the
   *  attachment list. Older plugin builds don't send the flag. */
  inline?: boolean;
}

/** What the send actions accept per attached file. */
export interface EmailSendAttachment {
  name: string;
  mime?: string;
  contentBase64: string;
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
  attachments: EmailAttachmentMeta[];
  /** Replied to (\Answered). Absent from email-tools before 0.19. */
  answered?: boolean;
  /** Forwarded ($Forwarded). Absent from email-tools before 0.19. */
  forwarded?: boolean;
}

/**
 * What became of the copy a send leaves in the mailbox's Sent folder.
 * email-tools 0.19+ reports it; the send itself has succeeded either way.
 */
export interface EmailSentCopy {
  /** A copy is in Sent, or the provider (Gmail, Microsoft 365) keeps its own. */
  ok: boolean;
  folder?: string;
  /** The provider that keeps the copy itself, so none was uploaded. */
  filedBy?: string;
  alreadyThere?: boolean;
  /** Still being saved when the send had to answer; it finishes on its own. */
  pending?: boolean;
  /** Why no copy was saved. */
  error?: string;
}

/** Whether the message a reply or forward answered was marked as such. */
export interface EmailOriginalMark {
  ok: boolean;
  flag: string;
  folder: string;
  uid?: number;
  notFound?: boolean;
  /** The mail server can never keep this flag (reported once by Test connection). */
  unsupported?: boolean;
  /** Still being set when the send had to answer. */
  pending?: boolean;
  error?: string;
}

export interface EmailSendResult {
  ok: boolean;
  messageId: string;
  /** Absent from email-tools before 0.19. */
  sentCopy?: EmailSentCopy;
  /** Present for a reply, or a forward that named its original. */
  original?: EmailOriginalMark;
}

export interface ListMessagesOptions {
  folder?: string;
  unseen?: boolean;
  limit?: number;
}

export interface SearchMessagesOptions {
  /** Omit to search every mailbox this company can see. */
  mailbox?: string;
  /** Omit to search across folders rather than just one. */
  folder?: string;
  /** Free text, matched against headers and body. */
  text?: string;
  from?: string;
  subject?: string;
  since?: string;
  before?: string;
  unseen?: boolean;
  includeTrash?: boolean;
  limit?: number;
}

/** A `MailHeader` plus where it was found — search crosses mailboxes and folders. */
export interface SearchHit extends MailHeader {
  mailbox: string;
  folder: string;
}

export interface SearchMessagesResult {
  results: SearchHit[];
  /** More matched than `limit`; the operator is seeing the newest slice. */
  truncated: boolean;
  searchedMailboxes: string[];
  /** Folders deliberately not searched (Trash/Junk, or beyond the folder cap). */
  skippedFolders: string[];
  /** Folders or mailboxes that failed, so partial results aren't read as "nothing found". */
  errors: Array<{ mailbox: string; folder?: string; message: string }>;
}

export interface SenderRule {
  senderPattern: string;
  ruleType: "auto-triage" | "keep-always" | "mute";
  createdAt: string;
  updatedAt: string;
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

    getAttachment: async (
      mailbox: string,
      folder: string,
      uid: number,
      partId: string,
    ): Promise<{ name: string; mime: string; size: number; contentBase64: string }> => {
      const result = await pluginsApi.bridgeGetData(
        pluginId,
        "email.get-attachment",
        { companyId, mailbox, folder, uid, partId },
        companyId,
      );
      return extract(result);
    },

    searchMessages: async (opts: SearchMessagesOptions): Promise<SearchMessagesResult> => {
      const result = await pluginsApi.bridgeGetData(
        pluginId,
        "email.search",
        { companyId, ...opts },
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

    markUnread: async (mailbox: string, uid: number, folder: string): Promise<{ ok: boolean }> => {
      const result = await pluginsApi.bridgePerformAction(
        pluginId,
        "email.mark-unread",
        { companyId, mailbox, uid, folder },
        companyId,
      );
      return extract(result);
    },

    deleteMessage: async (
      mailbox: string,
      uid: number,
      folder: string,
    ): Promise<{ ok: boolean; movedCount: number; trashFolder: string }> => {
      const result = await pluginsApi.bridgePerformAction(
        pluginId,
        "email.delete-message",
        { companyId, mailbox, uid, folder },
        companyId,
      );
      return extract(result);
    },

    sendReply: async (
      mailbox: string,
      uid: number,
      folder: string,
      body: string,
      opts?: { body_html?: string; replyAll?: boolean; attachments?: EmailSendAttachment[] },
    ): Promise<EmailSendResult> => {
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
      opts?: {
        cc?: string;
        bcc?: string;
        body_html?: string;
        attachments?: EmailSendAttachment[];
        /**
         * The message this one forwards, so the mailbox can mark it forwarded.
         * The Message-ID, when known, is checked before anything is marked.
         */
        forwardOf?: { uid: number; folder: string; messageId?: string };
      },
    ): Promise<EmailSendResult> => {
      const result = await pluginsApi.bridgePerformAction(
        pluginId,
        "email.send-new",
        { companyId, mailbox, to, subject, body, ...opts },
        companyId,
      );
      return extract(result);
    },

    listRules: async (mailbox: string): Promise<{ rules: SenderRule[] }> => {
      const result = await pluginsApi.bridgeGetData(
        pluginId,
        "email.list-rules",
        { companyId, mailbox },
        companyId,
      );
      return extract(result);
    },

    setRule: async (
      mailbox: string,
      senderPattern: string,
      ruleType: "auto-triage" | "keep-always" | "mute",
    ): Promise<{ ok: boolean; sweptCount?: number }> => {
      const result = await pluginsApi.bridgePerformAction(
        pluginId,
        "email.set-rule",
        { companyId, mailbox, senderPattern, ruleType },
        companyId,
      );
      return extract(result);
    },

    deleteRule: async (mailbox: string, senderPattern: string): Promise<{ ok: boolean }> => {
      const result = await pluginsApi.bridgePerformAction(
        pluginId,
        "email.delete-rule",
        { companyId, mailbox, senderPattern },
        companyId,
      );
      return extract(result);
    },
  };
}

export type EmailToolsApi = ReturnType<typeof makeEmailToolsApi>;
