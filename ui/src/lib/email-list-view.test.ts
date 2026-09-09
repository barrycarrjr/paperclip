import { describe, expect, it } from "vitest";
import {
  emptyListMessage,
  initialEmailListView,
  isEmailListView,
  listViewShowsAllMail,
} from "./email-list-view";

describe("initialEmailListView", () => {
  it("lets an explicit link win over what was remembered", () => {
    expect(
      initialEmailListView({ allParam: "1", stored: "unread", legacyShowAll: "false" }),
    ).toBe("all");
    expect(initialEmailListView({ allParam: "0", stored: "agents", legacyShowAll: "true" })).toBe(
      "unread",
    );
  });

  it("restores the remembered view", () => {
    expect(initialEmailListView({ allParam: null, stored: "agents", legacyShowAll: null })).toBe(
      "agents",
    );
  });

  it("keeps the old two-way preference for anyone who had one", () => {
    expect(initialEmailListView({ allParam: null, stored: null, legacyShowAll: "true" })).toBe(
      "all",
    );
    expect(initialEmailListView({ allParam: null, stored: null, legacyShowAll: "false" })).toBe(
      "unread",
    );
  });

  it("opens on unread when nothing is known, as it always did", () => {
    expect(initialEmailListView({ allParam: null, stored: null, legacyShowAll: null })).toBe(
      "unread",
    );
  });

  it("ignores a stored value it does not recognise", () => {
    expect(
      initialEmailListView({ allParam: null, stored: "something-else", legacyShowAll: "true" }),
    ).toBe("all");
  });
});

describe("listViewShowsAllMail", () => {
  it("filters to unread only in the Unread view", () => {
    expect(listViewShowsAllMail("unread")).toBe(false);
    expect(listViewShowsAllMail("all")).toBe(true);
    // The held-mail view is built from records, not the mailbox, but the
    // message query behind it must not be left filtered to unread.
    expect(listViewShowsAllMail("agents")).toBe(true);
  });
});

describe("emptyListMessage", () => {
  it("points at the other tab rather than at an icon", () => {
    expect(emptyListMessage("unread")).toBe("No unread messages. Choose All mail to see the rest.");
    expect(emptyListMessage("all")).toBe("No messages in this folder.");
  });
});

describe("isEmailListView", () => {
  it("accepts only the three views", () => {
    expect(isEmailListView("agents")).toBe(true);
    expect(isEmailListView("everything")).toBe(false);
    expect(isEmailListView(null)).toBe(false);
  });
});
