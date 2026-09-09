import { describe, expect, it } from "vitest";
import { describeSendingIdentity, findSelectedMailbox } from "./sendingIdentity";

describe("describeSendingIdentity", () => {
  it("shows the real address when the mailbox has one", () => {
    const identity = describeSendingIdentity({
      key: "support",
      name: "Support",
      from: "support@acme.example",
    });
    expect(identity.label).toBe("Support <support@acme.example>");
    expect(identity.isAddress).toBe(true);
    expect(identity.unknown).toBe(false);
  });

  it("does not repeat the address as a name", () => {
    const identity = describeSendingIdentity({
      key: "support",
      name: "support@acme.example",
      from: "Support@Acme.example",
    });
    expect(identity.label).toBe("Support@Acme.example");
  });

  it("falls back to the mailbox name when no address is configured", () => {
    // Still a real configured identity the operator chose — never a guess.
    const identity = describeSendingIdentity({ key: "ib-barry", name: "IB mailbox", from: null });
    expect(identity.label).toBe("IB mailbox");
    expect(identity.isAddress).toBe(false);
    expect(identity.unknown).toBe(false);
  });

  it("falls back to the key when the name is blank too", () => {
    expect(describeSendingIdentity({ key: "ib-barry", name: "  ", from: undefined }).label).toBe(
      "ib-barry",
    );
  });

  it("treats a blank address as absent", () => {
    // An optional field opened and cleared is saved as "". Rendering that as
    // an address would print a blank From line that reads as fine.
    const identity = describeSendingIdentity({ key: "k", name: "Main", from: "   " });
    expect(identity.label).toBe("Main");
    expect(identity.isAddress).toBe(false);
  });

  it("says so plainly when there is no mailbox at all", () => {
    // An absent From line reads as "nothing to worry about", which is the
    // opposite of the truth here.
    const identity = describeSendingIdentity(null);
    expect(identity.unknown).toBe(true);
    expect(identity.label).toMatch(/no mailbox/i);
  });
});

describe("findSelectedMailbox", () => {
  const mailboxes = [
    { key: "a", name: "A", pollFolder: "INBOX" },
    { key: "b", name: "B", pollFolder: "INBOX", from: "b@example.com" },
  ];

  it("finds the mailbox the page has selected", () => {
    expect(findSelectedMailbox(mailboxes, "b")?.from).toBe("b@example.com");
  });

  it("returns null for no selection or an unknown key", () => {
    expect(findSelectedMailbox(mailboxes, null)).toBeNull();
    expect(findSelectedMailbox(mailboxes, "")).toBeNull();
    // A key left over from another company's plugin config, which that
    // company's list will not contain.
    expect(findSelectedMailbox(mailboxes, "stale-from-other-company")).toBeNull();
  });
});
