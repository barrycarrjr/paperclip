import { describe, expect, it } from "vitest";
import type { HSConversationFull, HSThread } from "../api/helpScoutBridge";
import { htmlToPlainText, pickDraftSource } from "./helpscout-draft-source";

describe("htmlToPlainText", () => {
  it("turns block markup into line breaks", () => {
    expect(htmlToPlainText("<p>Hello</p><p>World</p>")).toBe("Hello\nWorld");
    expect(htmlToPlainText("one<br>two<br />three")).toBe("one\ntwo\nthree");
  });

  it("drops script and style blocks", () => {
    expect(htmlToPlainText("<style>p{color:red}</style><p>Hi</p>")).toBe("Hi");
    expect(htmlToPlainText("<script>alert(1)</script>Hi")).toBe("Hi");
  });

  it("decodes entities, and decodes escaped entities only once", () => {
    expect(htmlToPlainText("Tom &amp; Jerry &lt;tom@x.com&gt;")).toBe("Tom & Jerry <tom@x.com>");
    expect(htmlToPlainText("&amp;lt;")).toBe("&lt;");
    expect(htmlToPlainText("a&nbsp;b &quot;q&quot; &#39;s&#39;")).toBe('a b "q" \'s\'');
  });

  it("collapses runs of blank lines", () => {
    expect(htmlToPlainText("<p>a</p><p></p><p></p><p>b</p>")).toBe("a\n\nb");
  });

  it("returns an empty string for empty input", () => {
    expect(htmlToPlainText("")).toBe("");
    expect(htmlToPlainText("<div></div>")).toBe("");
  });
});

function conv(threads: HSThread[], extra: Partial<HSConversationFull> = {}): HSConversationFull {
  return {
    id: 1,
    subject: "Admin Panel",
    primaryCustomer: { email: "sue@songprinting.com" },
    _embedded: { threads },
    ...extra,
  };
}

describe("pickDraftSource", () => {
  it("returns null when there is nothing to reply to", () => {
    expect(pickDraftSource(null)).toBeNull();
    expect(pickDraftSource(undefined)).toBeNull();
    expect(pickDraftSource(conv([]))).toBeNull();
  });

  it("ignores notes and line items", () => {
    const source = pickDraftSource(
      conv([
        { id: 3, type: "note", body: "Reopened by Clippy", createdAt: "2026-07-23T10:00:00Z" },
        { id: 2, type: "lineitem", body: "", createdAt: "2026-07-23T09:00:00Z" },
        {
          id: 1,
          type: "customer",
          body: "<p>Please let me know how to do this.</p>",
          createdAt: "2026-07-23T08:00:00Z",
          customer: { email: "sue@songprinting.com" },
        },
      ]),
    );
    expect(source).toEqual({
      subject: "Admin Panel",
      from: "sue@songprinting.com",
      bodyText: "Please let me know how to do this.",
    });
  });

  it("picks the newest customer message, not the newest agent reply", () => {
    const source = pickDraftSource(
      conv([
        {
          id: 3,
          type: "message",
          body: "Our reply",
          createdAt: "2026-07-23T12:00:00Z",
          createdBy: { email: "support@ours.com" },
        },
        {
          id: 2,
          type: "customer",
          body: "Second question",
          createdAt: "2026-07-23T11:00:00Z",
          customer: { email: "sue@songprinting.com" },
        },
        {
          id: 1,
          type: "customer",
          body: "First question",
          createdAt: "2026-07-23T08:00:00Z",
          customer: { email: "sue@songprinting.com" },
        },
      ]),
    );
    expect(source?.bodyText).toBe("Second question");
  });

  it("skips a customer thread with an empty body", () => {
    const source = pickDraftSource(
      conv([
        {
          id: 2,
          type: "customer",
          body: "   ",
          createdAt: "2026-07-23T11:00:00Z",
        },
        {
          id: 1,
          type: "customer",
          body: "Real question",
          createdAt: "2026-07-23T08:00:00Z",
        },
      ]),
    );
    expect(source?.bodyText).toBe("Real question");
  });

  it("falls back to the newest agent thread when the customer never wrote", () => {
    const source = pickDraftSource(
      conv([
        {
          id: 1,
          type: "message",
          body: "We reached out first",
          createdAt: "2026-07-23T08:00:00Z",
          createdBy: { email: "support@ours.com" },
        },
      ]),
    );
    expect(source?.bodyText).toBe("We reached out first");
    expect(source?.from).toBe("support@ours.com");
  });

  it("falls back to the conversation's customer when the thread has no address", () => {
    const source = pickDraftSource(conv([{ id: 1, type: "customer", body: "Hi" }]));
    expect(source?.from).toBe("sue@songprinting.com");
  });

  it("uses the thread's plain text when there is no html body", () => {
    const source = pickDraftSource(conv([{ id: 1, type: "customer", text: "Plain only" }]));
    expect(source?.bodyText).toBe("Plain only");
  });

  it("omits an empty subject rather than sending a blank one", () => {
    const source = pickDraftSource(
      conv([{ id: 1, type: "customer", body: "Hi" }], { subject: "" }),
    );
    expect(source?.subject).toBeUndefined();
  });
});
