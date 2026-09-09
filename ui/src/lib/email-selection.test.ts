// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { BulkRunResult } from "./bulk-run";
import {
  EMAIL_BULK_ACTION_VERB,
  canSelectMessages,
  messageSelectionId,
  resetForChange,
  selectionContextChange,
  selectionIdsToUids,
  summarizeEmailBulkRun,
} from "./email-selection";

function result<T>(over: Partial<BulkRunResult<T>> = {}): BulkRunResult<T> {
  return {
    succeeded: [],
    failed: [],
    skipped: [],
    stoppedForRateLimit: false,
    ...over,
  };
}

describe("which rows can be ticked", () => {
  it("allows ticking on the two mailbox tabs", () => {
    expect(canSelectMessages({ view: "all", searchActive: false })).toBe(true);
    expect(canSelectMessages({ view: "unread", searchActive: false })).toBe(true);
  });

  it("does not allow ticking on the handover tab, which is not the mailbox", () => {
    expect(canSelectMessages({ view: "agents", searchActive: false })).toBe(false);
  });

  it("does not allow ticking in search results, which come from other folders", () => {
    expect(canSelectMessages({ view: "all", searchActive: true })).toBe(false);
  });
});

describe("what a change does to the ticks", () => {
  it("keeps the checkboxes on for a tab, mailbox or folder change", () => {
    expect(resetForChange("tab", "all")).toBe("keep-mode");
    expect(resetForChange("mailbox")).toBe("keep-mode");
    expect(resetForChange("folder")).toBe("keep-mode");
  });

  it("puts the checkboxes away when the company changes", () => {
    expect(resetForChange("company")).toBe("leave-mode");
  });

  it("puts the checkboxes away when the tab moves to the handover list", () => {
    expect(resetForChange("tab", "agents")).toBe("leave-mode");
  });
});

describe("spotting the change", () => {
  const base = {
    company: "c1",
    mailbox: "personal",
    folder: "INBOX",
    view: "unread" as const,
  };

  it("says nothing changed when nothing changed", () => {
    expect(selectionContextChange(base, { ...base })).toBeNull();
  });

  it("reports a company switch even though the mailbox went with it", () => {
    expect(selectionContextChange(base, { ...base, company: "c2", mailbox: null })).toBe("company");
  });

  it("reports the mailbox, the folder and the tab", () => {
    expect(selectionContextChange(base, { ...base, mailbox: "work" })).toBe("mailbox");
    expect(selectionContextChange(base, { ...base, folder: "Archive" })).toBe("folder");
    expect(selectionContextChange(base, { ...base, view: "all" })).toBe("tab");
  });

  it("a company switch leaves nothing of the previous company's ticks", () => {
    const change = selectionContextChange(base, { ...base, company: "c2" })!;
    expect(resetForChange(change)).toBe("leave-mode");
  });
});

describe("tick ids", () => {
  it("uses the uid as text and reads it back", () => {
    expect(messageSelectionId(42)).toBe("42");
    expect(selectionIdsToUids(["42", "7"])).toEqual([42, 7]);
  });

  it("drops anything that is not a number rather than acting on NaN", () => {
    expect(selectionIdsToUids(["42", "not-a-uid"])).toEqual([42]);
  });
});

describe("saying what happened", () => {
  it("counts messages, not conversations", () => {
    expect(summarizeEmailBulkRun(result({ succeeded: [1, 2, 3] }), "move")).toEqual({
      tone: "success",
      message: "Moved 3 messages.",
    });
    expect(summarizeEmailBulkRun(result({ succeeded: [1] }), "read")).toEqual({
      tone: "success",
      message: "Marked read 1 message.",
    });
  });

  it("never calls a part-finished run a success", () => {
    const summary = summarizeEmailBulkRun(
      result({ succeeded: [1, 2], failed: [{ item: 3, error: new Error("no") }] }),
      "move",
    );
    expect(summary.tone).toBe("warning");
    expect(summary.message).toBe("Moved 2. 1 failed.");
  });

  it("says so plainly when nothing worked", () => {
    const summary = summarizeEmailBulkRun(
      result({ failed: [{ item: 1, error: new Error("no") }, { item: 2, error: new Error("no") }] }),
      "read",
    );
    expect(summary.tone).toBe("error");
    expect(summary.message).toContain("None of the 2 selected");
  });

  it("names the mail server, not Help Scout, when told to slow down", () => {
    const summary = summarizeEmailBulkRun(
      result({
        succeeded: [1],
        failed: [{ item: 2, error: new Error("429") }],
        skipped: [3],
        stoppedForRateLimit: true,
      }),
      "move",
    );
    expect(summary.tone).toBe("warning");
    expect(summary.message).toContain("the mail server asked us to slow down");
    expect(summary.message).toContain("2 left untouched");
  });

  it("keeps the verbs in the past tense, because they report", () => {
    expect(EMAIL_BULK_ACTION_VERB.read).toBe("Marked read");
    expect(EMAIL_BULK_ACTION_VERB.move).toBe("Moved");
  });
});
