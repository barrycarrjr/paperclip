import { describe, expect, it, vi } from "vitest";
import type { ChatSession } from "../api/chat";
import { DEFAULT_NEW_CHAT_SETTINGS, createChatForFirstSend, isAdapterModel } from "./clippy-new-chat";

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "chat-1",
    boardUserId: "user-1",
    companyId: "company-1",
    title: "New chat",
    model: "claude-sonnet-5-5",
    mode: "agent",
    permissionMode: "ask",
    effort: "auto",
    pageContext: null,
    archivedAt: null,
    createdAt: "2026-10-09T12:00:00.000Z",
    updatedAt: "2026-10-09T12:00:00.000Z",
    ...overrides,
  };
}

describe("createChatForFirstSend", () => {
  it("creates the chat with the company, model, permission and page chosen before sending", async () => {
    const api = {
      createSession: vi.fn().mockResolvedValue({ session: session({ permissionMode: "bypass" }) }),
      patchSession: vi.fn(),
    };
    await createChatForFirstSend(api, {
      companyId: "company-1",
      model: "claude-opus-5",
      permissionMode: "bypass",
      effort: "auto",
      pageContext: "/HQ/issues (company HQ, page Issues)",
    });
    expect(api.createSession).toHaveBeenCalledWith({
      companyId: "company-1",
      permissionMode: "bypass",
      model: "claude-opus-5",
      pageContext: "/HQ/issues (company HQ, page Issues)",
    });
    expect(api.patchSession).not.toHaveBeenCalled();
  });

  it("leaves the model to the server when none was chosen", async () => {
    const api = { createSession: vi.fn().mockResolvedValue({ session: session() }), patchSession: vi.fn() };
    await createChatForFirstSend(api, { companyId: null, ...DEFAULT_NEW_CHAT_SETTINGS, pageContext: null });
    expect(api.createSession.mock.calls[0]![0]).not.toHaveProperty("model");
  });

  it("sets an effort chosen before sending, which the server's create call does not take", async () => {
    const created = session();
    const withEffort = session({ effort: "high" });
    const api = {
      createSession: vi.fn().mockResolvedValue({ session: created }),
      patchSession: vi.fn().mockResolvedValue({ session: withEffort }),
    };
    const result = await createChatForFirstSend(api, {
      companyId: "company-1",
      model: "",
      permissionMode: "ask",
      effort: "high",
      pageContext: null,
    });
    expect(api.patchSession).toHaveBeenCalledWith("chat-1", { effort: "high" });
    expect(result).toBe(withEffort);
  });

  it("keeps the chat it made when setting the effort fails, and a retry reuses it", async () => {
    // The chat used to be lost here: the retry made a second chat, and the
    // first stayed in the list as an empty "New chat".
    const created = session();
    const api = {
      createSession: vi.fn().mockResolvedValue({ session: created }),
      patchSession: vi
        .fn()
        .mockRejectedValueOnce(new Error("network down"))
        .mockResolvedValueOnce({ session: session({ effort: "high" }) }),
    };
    const draft = { companyId: "company-1", model: "", permissionMode: "ask" as const, effort: "high" as const, pageContext: null };
    const progress = { session: null as ChatSession | null };

    await expect(createChatForFirstSend(api, draft, progress)).rejects.toThrow("network down");
    expect(progress.session?.id).toBe("chat-1");

    const retried = await createChatForFirstSend(api, draft, progress);
    expect(api.createSession).toHaveBeenCalledTimes(1);
    expect(api.patchSession).toHaveBeenCalledTimes(2);
    expect(retried.effort).toBe("high");
  });

  it("on a retry, applies a model picked again after the failed try", async () => {
    const api = {
      createSession: vi.fn(),
      patchSession: vi.fn().mockResolvedValue({ session: session({ model: "claude-opus-5" }) }),
    };
    const progress = { session: session() };
    await createChatForFirstSend(
      api,
      { companyId: "company-1", model: "claude-opus-5", permissionMode: "ask", effort: "auto", pageContext: null },
      progress,
    );
    expect(api.createSession).not.toHaveBeenCalled();
    expect(api.patchSession).toHaveBeenCalledWith("chat-1", { model: "claude-opus-5" });
  });
});

describe("isAdapterModel", () => {
  it("knows a CLI-routed model by its stored id", () => {
    expect(isAdapterModel("adapter:claude_local:claude-sonnet-5-5")).toBe(true);
    expect(isAdapterModel("claude-sonnet-5-5")).toBe(false);
    expect(isAdapterModel("")).toBe(false);
  });
});
