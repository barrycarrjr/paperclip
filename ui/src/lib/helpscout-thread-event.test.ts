import { describe, expect, it } from "vitest";
import type { HSThread } from "../api/helpScoutBridge";
import { describeThreadEvent, isThreadEvent } from "./helpscout-thread-event";

function thread(partial: Partial<HSThread>): HSThread {
  return { id: 1, type: "lineitem", ...partial };
}

describe("isThreadEvent", () => {
  it("matches lineitem threads", () => {
    expect(isThreadEvent(thread({ type: "lineitem" }))).toBe(true);
    expect(isThreadEvent(thread({ type: "LineItem" }))).toBe(true);
  });

  it("leaves real messages alone", () => {
    for (const type of ["message", "customer", "note", "reply", "chat", "phone"]) {
      expect(isThreadEvent(thread({ type }))).toBe(false);
    }
  });
});

describe("describeThreadEvent", () => {
  it("prefers Help Scout's own wording", () => {
    const t = thread({ action: { type: "changed-ticket-status", text: "You marked as Closed" } });
    expect(describeThreadEvent(t)).toBe("You marked as Closed");
  });

  it("falls back to a readable form of the internal action type", () => {
    expect(describeThreadEvent(thread({ action: { type: "changed-ticket-status" } }))).toBe(
      "Changed ticket status",
    );
    expect(describeThreadEvent(thread({ action: { type: "moved_from_inbox" } }))).toBe(
      "Moved from inbox",
    );
  });

  it("falls back again when the action carries nothing usable", () => {
    expect(describeThreadEvent(thread({}))).toBe("Conversation updated");
    expect(describeThreadEvent(thread({ action: {} }))).toBe("Conversation updated");
    expect(describeThreadEvent(thread({ action: { text: "  ", type: "  " } }))).toBe(
      "Conversation updated",
    );
  });

  it("never returns an empty label", () => {
    expect(describeThreadEvent(thread({ action: { type: "---" } }))).toBe("Conversation updated");
  });
});
