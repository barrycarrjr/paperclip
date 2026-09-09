import { describe, expect, it } from "vitest";
import { buildEmailHandoffOriginId } from "@paperclipai/shared";
import type { EmailHandoffSummary, TakeOverHandoffResult } from "@/api/emailHandoffs";
import {
  findHoldForMessage,
  holdKeysForMessage,
  holdSourceLine,
  holdStageLabel,
  holderName,
  indexHoldsBySource,
  takeOverOutcomeMessage,
} from "./email-agent-holds";

function makeHold(overrides: Partial<EmailHandoffSummary> = {}): EmailHandoffSummary {
  return {
    id: "d1",
    issueId: "i1",
    companyId: "c1",
    pluginId: "email-tools",
    sourceKey: "email:v1:msgid:email-tools:personal:%3Cabc%40example.com%3E",
    mailbox: "personal",
    folder: "INBOX",
    messageId: "<abc@example.com>",
    status: "in_progress",
    delegatedByUserId: null,
    delegatedToAgentId: "a1",
    delegatedAt: "2026-09-08T09:00:00.000Z",
    acknowledgedAt: null,
    resolvedAt: null,
    resolutionNote: null,
    handedBackReason: null,
    previousDelegationId: null,
    replyState: "none",
    replyError: null,
    version: 0,
    createdAt: "2026-09-08T09:00:00.000Z",
    updatedAt: "2026-09-08T09:00:00.000Z",
    issue: { id: "i1", identifier: "ACME-4", title: "Email from a customer", status: "in_progress" },
    agent: { id: "a1", name: "Ada" },
    ...overrides,
  };
}

const location = { pluginId: "email-tools", mailbox: "personal", folder: "INBOX" };

describe("holdKeysForMessage", () => {
  it("offers both the message-id key and the mailbox-and-number key", () => {
    const keys = holdKeysForMessage(location, { uid: 12, messageId: "<abc@example.com>" });
    expect(keys).toEqual([
      buildEmailHandoffOriginId({
        pluginId: "email-tools",
        mailbox: "personal",
        messageId: "<abc@example.com>",
      }),
      buildEmailHandoffOriginId({
        pluginId: "email-tools",
        mailbox: "personal",
        folder: "INBOX",
        uid: 12,
      }),
    ]);
  });

  it("still offers the fallback key when the message has no message id", () => {
    const keys = holdKeysForMessage(location, { uid: 12, messageId: null });
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain(":uid:");
  });

  it("offers nothing when there is no mailbox to key on", () => {
    expect(holdKeysForMessage({ ...location, mailbox: null }, { uid: 1, messageId: "<a@b>" })).toEqual(
      [],
    );
    expect(
      holdKeysForMessage({ ...location, pluginId: null }, { uid: 1, messageId: "<a@b>" }),
    ).toEqual([]);
  });
});

describe("findHoldForMessage", () => {
  it("finds the agent holding a message by its message id", () => {
    const hold = makeHold();
    const index = indexHoldsBySource([hold]);
    expect(findHoldForMessage(index, location, { uid: 99, messageId: "<abc@example.com>" })).toBe(
      hold,
    );
  });

  it("finds a message handed over under the mailbox-and-number fallback", () => {
    const sourceKey = buildEmailHandoffOriginId({
      pluginId: "email-tools",
      mailbox: "personal",
      folder: "INBOX",
      uid: 12,
    })!;
    const hold = makeHold({ sourceKey, messageId: null });
    const index = indexHoldsBySource([hold]);

    // The row has a Message-Id now, but the handover was recorded without
    // one. It must still be reported as held.
    expect(findHoldForMessage(index, location, { uid: 12, messageId: "<abc@example.com>" })).toBe(
      hold,
    );
  });

  it("does not match a different message in the same mailbox", () => {
    const index = indexHoldsBySource([makeHold()]);
    expect(findHoldForMessage(index, location, { uid: 77, messageId: "<other@example.com>" })).toBe(
      null,
    );
  });

  it("does not match the same number in a different folder", () => {
    const sourceKey = buildEmailHandoffOriginId({
      pluginId: "email-tools",
      mailbox: "personal",
      folder: "INBOX",
      uid: 12,
    })!;
    const index = indexHoldsBySource([makeHold({ sourceKey, messageId: null })]);
    expect(
      findHoldForMessage(index, { ...location, folder: "Archive" }, { uid: 12, messageId: null }),
    ).toBe(null);
  });

  it("does not match a message in another mailbox", () => {
    const index = indexHoldsBySource([makeHold()]);
    expect(
      findHoldForMessage(index, { ...location, mailbox: "work" }, {
        uid: 12,
        messageId: "<abc@example.com>",
      }),
    ).toBe(null);
  });
});

describe("wording", () => {
  it("names each stage in plain words", () => {
    expect(holdStageLabel("delegated")).toBe("Waiting to be picked up");
    expect(holdStageLabel("needs_review")).toBe("Waiting on review");
  });

  it("admits when a stage is not one it knows", () => {
    expect(holdStageLabel("something_new")).toBe("Stage not known");
  });

  it("uses the agent's name, and says plainly when there is not one", () => {
    expect(holderName(makeHold())).toBe("Ada");
    expect(holderName(makeHold({ agent: { id: "a1", name: null } }))).toBe(
      "An agent that has since been removed",
    );
    expect(holderName(makeHold({ agent: null }))).toBe("An agent we can no longer name");
  });

  it("says where the message came from", () => {
    expect(holdSourceLine(makeHold())).toBe("personal / INBOX");
    expect(holdSourceLine(makeHold({ folder: null }))).toBe("personal");
  });
});

describe("takeOverOutcomeMessage", () => {
  function result(overrides: Partial<TakeOverHandoffResult> = {}): TakeOverHandoffResult {
    return {
      delegation: makeHold() as unknown as TakeOverHandoffResult["delegation"],
      run: { state: "stopped", runId: "r1" },
      workItem: {
        state: "updated",
        unassignedAgent: true,
        statusChangedTo: "todo",
        error: null,
      },
      ...overrides,
    };
  }

  it("says plainly what happened when it all worked", () => {
    const message = takeOverOutcomeMessage(result(), "Ada");
    expect(message.tone).toBe("ok");
    expect(message.headline).toBe("You have the message back");
    expect(message.details[0]).toBe("Ada has been stopped.");
    expect(message.details[1]).toBe(
      "Ada has been taken off the work item, and it is back on the to-do list.",
    );
    expect(message.details[2]).toBe("Nothing was sent to whoever emailed you.");
  });

  it("warns, rather than reassures, when the agent could not be stopped", () => {
    const message = takeOverOutcomeMessage(
      result({ run: { state: "failed", error: "The machine did not answer.", runId: "r1" } }),
      "Ada",
    );
    expect(message.tone).toBe("warning");
    expect(message.headline).toBe("You have the message back, but not everything worked");
    expect(message.details[0]).toContain("may still be working");
    expect(message.details[0]).toContain("The machine did not answer.");
  });

  it("warns when the work item could not be updated", () => {
    const message = takeOverOutcomeMessage(
      result({
        workItem: {
          state: "failed",
          unassignedAgent: false,
          statusChangedTo: null,
          error: "Could not save.",
        },
      }),
      "Ada",
    );
    expect(message.tone).toBe("warning");
    expect(message.details[1]).toContain("may still be assigned to it");
  });

  it("does not claim a run was stopped when none was running", () => {
    const message = takeOverOutcomeMessage(result({ run: { state: "none" } }), "Ada");
    expect(message.tone).toBe("ok");
    expect(message.details[0]).toBe("Ada had nothing running, so there was nothing to stop.");
  });
});
