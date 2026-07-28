import { describe, expect, it } from "vitest";
import { buildDraftUserText, stripDraftPreamble } from "../services/email-draft-text.js";

describe("buildDraftUserText", () => {
  it("frames a reply around the incoming email", () => {
    const text = buildDraftUserText({
      mode: "reply",
      from: "customer@example.com",
      subject: "Guest checkout",
      bodyText: "Can my clients order without signing up?",
      instructions: "Q3, keep it short",
    });

    expect(text).toContain("Email I am replying to:");
    expect(text).toContain("From: customer@example.com");
    expect(text).toContain("Can my clients order without signing up?");
    expect(text).toContain("Instructions from the operator: Q3, keep it short");
    expect(text).toContain("Write the body of the reply now.");
  });

  it("frames a new message around the recipient, with no incoming email", () => {
    const text = buildDraftUserText({
      mode: "new",
      to: "customer@example.com",
      subject: "Your artwork files",
      instructions: "ask for print-ready PDFs by Friday",
    });

    expect(text).toContain("New email I am writing:");
    expect(text).toContain("To: customer@example.com");
    expect(text).not.toContain("Email I am replying to:");
    expect(text).not.toContain("(empty body)");
    expect(text).toContain("Write the body of the message now.");
  });

  it("says so when a new message has no subject yet", () => {
    const text = buildDraftUserText({ mode: "new", instructions: "chase the quote" });
    expect(text).toContain("(no subject yet)");
  });

  it("asks for a revision, keeping untouched parts, when a draft exists", () => {
    const text = buildDraftUserText({
      mode: "reply",
      bodyText: "original email",
      currentDraft: "Thanks for reaching out.",
      instructions: "shorter",
    });

    expect(text).toContain("The reply I have so far:");
    expect(text).toContain("Thanks for reaching out.");
    expect(text).toContain("Keep everything they did not ask you to change.");
    expect(text).not.toContain("Write the body of the reply now.");
  });

  it("uses message wording when revising a new message", () => {
    const text = buildDraftUserText({
      mode: "new",
      to: "a@b.com",
      currentDraft: "Hello there.",
      instructions: "warmer",
    });

    expect(text).toContain("The message I have so far:");
    expect(text).toContain("Output the full revised message, nothing else.");
  });

  it("treats a whitespace-only draft as no draft", () => {
    const text = buildDraftUserText({ mode: "new", instructions: "hi", currentDraft: "   \n " });
    expect(text).toContain("Write the body of the message now.");
    expect(text).not.toContain("I have so far");
  });

  it("omits the instructions line when there are none", () => {
    const text = buildDraftUserText({ mode: "reply", bodyText: "hello" });
    expect(text).not.toContain("Instructions from the operator");
  });
});

describe("stripDraftPreamble", () => {
  it("strips the narration an adapter model wrote before the reply", () => {
    // Verbatim shape reported from the Help Scout composer (claude-opus-4-8).
    const raw = [
      "This is an email drafting task with a clear, specific instruction. Let me write the reply body directly.",
      "",
      "Here's the draft reply:",
      "",
      "Thanks for the detail, and for sharing the example — that helps clarify exactly what you're after.",
      "",
      "Good news is that this is on our roadmap. We're targeting Q3 to add guest checkout.",
    ].join("\n");

    expect(stripDraftPreamble(raw)).toBe(
      [
        "Thanks for the detail, and for sharing the example — that helps clarify exactly what you're after.",
        "",
        "Good news is that this is on our roadmap. We're targeting Q3 to add guest checkout.",
      ].join("\n"),
    );
  });

  it.each([
    "Here's the draft reply:",
    "Here is the reply:",
    "Draft reply:",
    "Revised reply:",
    "Sure!",
    "Of course.",
  ])("strips the lead-in %j", (lead) => {
    expect(stripDraftPreamble(`${lead}\n\nThanks for reaching out.`)).toBe(
      "Thanks for reaching out.",
    );
  });

  it("leaves a clean draft untouched", () => {
    const clean = [
      "Thanks for reaching out, and sorry for the delay.",
      "",
      "I'll get the quote over to you by Friday.",
    ].join("\n");
    expect(stripDraftPreamble(clean)).toBe(clean);
  });

  it("keeps a first paragraph that only looks conversational", () => {
    // Starts with "I'll" like a lot of preamble does, but it is the reply.
    const clean = [
      "I'll write up the full spec and send it across tomorrow.",
      "",
      "Let me know if you need anything sooner.",
    ].join("\n");
    expect(stripDraftPreamble(clean)).toBe(clean);
  });

  it("keeps a mixed paragraph rather than risk eating real content", () => {
    const raw = [
      "Here's the draft reply: thanks for getting in touch about the order.",
      "",
      "We can have it ready by Tuesday.",
    ].join("\n");
    expect(stripDraftPreamble(raw)).toBe(raw);
  });

  it("unwraps a fenced reply", () => {
    expect(stripDraftPreamble("```\nThanks for reaching out.\n```")).toBe(
      "Thanks for reaching out.",
    );
  });

  it("never strips everything", () => {
    const onlyPreamble = "Here's the draft reply:";
    expect(stripDraftPreamble(onlyPreamble)).toBe(onlyPreamble);
  });

  it("handles empty and whitespace input", () => {
    expect(stripDraftPreamble("")).toBe("");
    expect(stripDraftPreamble("   \n\n  ")).toBe("");
  });

  it("normalises CRLF and trims", () => {
    expect(stripDraftPreamble("  Here's the draft:\r\n\r\nHello there.\r\n  ")).toBe(
      "Hello there.",
    );
  });
});
