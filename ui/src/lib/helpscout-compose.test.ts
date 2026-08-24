import { describe, expect, it } from "vitest";
import { isComposeReady } from "./helpscout-compose";

const ok = { to: "customer@example.com", subject: "Your order", body: "Hi there" };

describe("isComposeReady", () => {
  it("accepts a complete draft", () => {
    expect(isComposeReady(ok)).toBe(true);
  });

  it("ignores surrounding whitespace", () => {
    expect(isComposeReady({ to: "  a@b.co  ", subject: " s ", body: " b " })).toBe(true);
  });

  it.each([
    ["", "empty"],
    ["   ", "whitespace"],
    ["customer", "no domain"],
    ["customer@", "no host"],
    ["customer@example", "no TLD"],
    ["@example.com", "no local part"],
    ["two addresses@a.com b@c.com", "space in the middle"],
  ])("rejects the address %j (%s)", (to) => {
    expect(isComposeReady({ ...ok, to })).toBe(false);
  });

  it("requires a subject", () => {
    expect(isComposeReady({ ...ok, subject: "   " })).toBe(false);
  });

  it("requires a body", () => {
    expect(isComposeReady({ ...ok, body: "" })).toBe(false);
  });

  it("blocks send while attachments are still reading", () => {
    expect(isComposeReady({ ...ok, attachmentsReady: false })).toBe(false);
  });

  it("allows send once attachments are settled", () => {
    expect(isComposeReady({ ...ok, attachmentsReady: true })).toBe(true);
  });
});
