import { describe, expect, it } from "vitest";
import { composeDraftKey } from "./Email";

describe("composeDraftKey", () => {
  it("gives two different companies two different storage keys for the same field", () => {
    // Regression: an unscoped key let a "New message" draft typed under one
    // company's mailbox come back after switching companies — and get sent
    // from the newly-selected company's mailbox instead, since Send always
    // uses whichever mailbox is currently selected.
    expect(composeDraftKey("company-a", "to")).not.toBe(composeDraftKey("company-b", "to"));
    expect(composeDraftKey("company-a", "cc")).not.toBe(composeDraftKey("company-b", "cc"));
    expect(composeDraftKey("company-a", "bcc")).not.toBe(composeDraftKey("company-b", "bcc"));
    expect(composeDraftKey("company-a", "subject")).not.toBe(composeDraftKey("company-b", "subject"));
    expect(composeDraftKey("company-a", "body")).not.toBe(composeDraftKey("company-b", "body"));
  });

  it("keeps all five fields distinct within the same company", () => {
    const to = composeDraftKey("company-a", "to");
    const cc = composeDraftKey("company-a", "cc");
    const bcc = composeDraftKey("company-a", "bcc");
    const subject = composeDraftKey("company-a", "subject");
    const body = composeDraftKey("company-a", "body");
    expect(new Set([to, cc, bcc, subject, body]).size).toBe(5);
  });

  it("is stable for the same company and field", () => {
    expect(composeDraftKey("company-a", "to")).toBe(composeDraftKey("company-a", "to"));
    expect(composeDraftKey("company-a", "cc")).toBe(composeDraftKey("company-a", "cc"));
    expect(composeDraftKey("company-a", "bcc")).toBe(composeDraftKey("company-a", "bcc"));
  });

  it("gives the no-company case a key distinct from a real company's", () => {
    expect(composeDraftKey(null, "to")).not.toBe(composeDraftKey("company-a", "to"));
    expect(composeDraftKey(null, "cc")).not.toBe(composeDraftKey("company-a", "cc"));
    expect(composeDraftKey(null, "bcc")).not.toBe(composeDraftKey("company-a", "bcc"));
  });
});
