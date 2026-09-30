import { describe, expect, it } from "vitest";
import { parseInlineConsentReply } from "@paperclipai/shared";
import { chatPermissions } from "../services/chat-permissions.js";
import { registerChatToolInteractions, requestChatToolConfirmation } from "../services/chat-tool-interactions.js";
import type { StreamEvent } from "../services/chat.js";

describe("inline tool consent", () => {
  it("accepts only unambiguous short answers", () => {
    for (const answer of ["Yes, do it!", "okay", "Go ahead.", "just fix it"]) expect(parseInlineConsentReply(answer)).toBe("approve");
    for (const answer of ["no", "Stop", "cancel"]) expect(parseInlineConsentReply(answer)).toBe("deny");
    for (const answer of ["yes but don't restart it", "yes?", "someone said yes", "change the computer", ""]) expect(parseInlineConsentReply(answer)).toBeNull();
  });
  it("fails closed without a live conversation", async () => {
    expect(await requestChatToolConfirmation("missing", "repair", {})).toBe(false);
  });
  it("scopes a prompt to its conversation and registers before rendering", async () => {
    const events: StreamEvent[] = [];
    const cleanup = registerChatToolInteractions("consent-a", (event) => {
      events.push(event);
      if (event.type === "permission_required") {
        expect(chatPermissions.resolve("consent-b", event.toolUseId, "approve")).toBe(false);
        expect(chatPermissions.resolve("consent-a", event.toolUseId, "approve")).toBe(true);
      }
    });
    try {
      expect(await requestChatToolConfirmation("consent-a", "repair", { target: "pc.example.local" })).toBe(true);
      expect(events.map(e => e.type)).toEqual(["tool_use_block", "permission_required", "tool_result_block"]);
      expect(() => registerChatToolInteractions("consent-a", () => {})).toThrow("already has a running turn");
    } finally { cleanup(); }
  });
  it("disconnect cancels consent, including an approval racing with disconnect", async () => {
    let id = "";
    const cleanup = registerChatToolInteractions("consent-c", e => { if (e.type === "permission_required") id = e.toolUseId; });
    const result = requestChatToolConfirmation("consent-c", "repair", {});
    cleanup();
    expect(chatPermissions.resolve("consent-c", id, "approve")).toBe(false);
    expect(await result).toBe(false);
    const cleanup2 = registerChatToolInteractions("consent-c", e => { if (e.type === "permission_required") id = e.toolUseId; });
    const result2 = requestChatToolConfirmation("consent-c", "repair", {});
    chatPermissions.resolve("consent-c", id, "approve");
    cleanup2();
    expect(await result2).toBe(false);
  });
});
