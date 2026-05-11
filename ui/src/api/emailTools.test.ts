import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockBridgeGetData, mockBridgePerformAction } = vi.hoisted(() => ({
  mockBridgeGetData: vi.fn(),
  mockBridgePerformAction: vi.fn(),
}));

vi.mock("./plugins", () => ({
  pluginsApi: {
    bridgeGetData: mockBridgeGetData,
    bridgePerformAction: mockBridgePerformAction,
  },
}));

import { makeEmailToolsApi } from "./emailTools";

const PLUGIN_ID = "plugin-uuid-123";
const COMPANY_ID = "company-abc";

describe("makeEmailToolsApi", () => {
  const api = makeEmailToolsApi(PLUGIN_ID, COMPANY_ID);

  beforeEach(() => {
    mockBridgeGetData.mockReset();
    mockBridgePerformAction.mockReset();
  });

  describe("listMailboxes", () => {
    it("calls bridgeGetData with the correct key and companyId", async () => {
      mockBridgeGetData.mockResolvedValue({ data: { mailboxes: [] } });
      const result = await api.listMailboxes();
      expect(mockBridgeGetData).toHaveBeenCalledWith(
        PLUGIN_ID,
        "email.list-mailboxes",
        { companyId: COMPANY_ID },
        COMPANY_ID,
      );
      expect(result).toEqual({ mailboxes: [] });
    });
  });

  describe("listMessages", () => {
    it("passes mailbox, folder, unseen, and limit through", async () => {
      mockBridgeGetData.mockResolvedValue({ data: { messages: [] } });
      await api.listMessages("personal", { folder: "INBOX", unseen: true, limit: 25 });
      expect(mockBridgeGetData).toHaveBeenCalledWith(
        PLUGIN_ID,
        "email.list-messages",
        { companyId: COMPANY_ID, mailbox: "personal", folder: "INBOX", unseen: true, limit: 25 },
        COMPANY_ID,
      );
    });

    it("works without optional params", async () => {
      mockBridgeGetData.mockResolvedValue({ data: { messages: [] } });
      await api.listMessages("sales");
      expect(mockBridgeGetData).toHaveBeenCalledWith(
        PLUGIN_ID,
        "email.list-messages",
        { companyId: COMPANY_ID, mailbox: "sales" },
        COMPANY_ID,
      );
    });
  });

  describe("fetchMessage", () => {
    it("calls bridgeGetData with mailbox, uid, and folder", async () => {
      const fakeMsg = { uid: 42, from: "test@example.com", subject: "Hi", date: "", text: "", html: "", markdown: "", messageId: null, inReplyTo: null, references: [], fromAddress: null, to: [], cc: [], attachments: [] };
      mockBridgeGetData.mockResolvedValue({ data: fakeMsg });
      const result = await api.fetchMessage("personal", 42, "INBOX");
      expect(mockBridgeGetData).toHaveBeenCalledWith(
        PLUGIN_ID,
        "email.fetch-message",
        { companyId: COMPANY_ID, mailbox: "personal", uid: 42, folder: "INBOX" },
        COMPANY_ID,
      );
      expect(result).toEqual(fakeMsg);
    });

    it("omits folder when not provided", async () => {
      mockBridgeGetData.mockResolvedValue({ data: {} });
      await api.fetchMessage("personal", 99);
      expect(mockBridgeGetData).toHaveBeenCalledWith(
        PLUGIN_ID,
        "email.fetch-message",
        { companyId: COMPANY_ID, mailbox: "personal", uid: 99 },
        COMPANY_ID,
      );
    });
  });

  describe("listFolders", () => {
    it("calls bridgeGetData with mailbox", async () => {
      mockBridgeGetData.mockResolvedValue({ data: { folders: ["INBOX", "Sent", "_paperclip/triage"] } });
      const result = await api.listFolders("personal");
      expect(mockBridgeGetData).toHaveBeenCalledWith(
        PLUGIN_ID,
        "email.list-folders",
        { companyId: COMPANY_ID, mailbox: "personal" },
        COMPANY_ID,
      );
      expect(result.folders).toContain("INBOX");
    });
  });

  describe("moveMessage", () => {
    it("calls bridgePerformAction with all four params", async () => {
      mockBridgePerformAction.mockResolvedValue({ data: { ok: true, movedCount: 1 } });
      const result = await api.moveMessage("personal", 77, "INBOX", "_paperclip/triage");
      expect(mockBridgePerformAction).toHaveBeenCalledWith(
        PLUGIN_ID,
        "email.move-message",
        { companyId: COMPANY_ID, mailbox: "personal", uid: 77, folder: "INBOX", targetFolder: "_paperclip/triage" },
        COMPANY_ID,
      );
      expect(result.ok).toBe(true);
    });
  });

  describe("markRead", () => {
    it("calls bridgePerformAction with mailbox, uid, and folder", async () => {
      mockBridgePerformAction.mockResolvedValue({ data: { ok: true } });
      await api.markRead("personal", 55, "INBOX");
      expect(mockBridgePerformAction).toHaveBeenCalledWith(
        PLUGIN_ID,
        "email.mark-read",
        { companyId: COMPANY_ID, mailbox: "personal", uid: 55, folder: "INBOX" },
        COMPANY_ID,
      );
    });
  });
});
