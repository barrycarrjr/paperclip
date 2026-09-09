import { describe, expect, it } from "vitest";
import { composeDraftKey } from "./Email";

describe("composeDraftKey", () => {
  it("gives two different companies two different storage keys for the same field", () => {
    // Regression: an unscoped key let a "New message" draft typed under one
    // company's mailbox come back after switching companies — and get sent
    // from the newly-selected company's mailbox instead, since Send always
    // uses whichever mailbox is currently selected.
    expect(composeDraftKey("company-a", "to")).not.toBe(composeDraftKey("company-b", "to"));
    expect(composeDraftKey("company-a", "subject")).not.toBe(composeDraftKey("company-b", "subject"));
    expect(composeDraftKey("company-a", "body")).not.toBe(composeDraftKey("company-b", "body"));
  });

  it("keeps the three fields distinct within the same company", () => {
    const to = composeDraftKey("company-a", "to");
    const subject = composeDraftKey("company-a", "subject");
    const body = composeDraftKey("company-a", "body");
    expect(new Set([to, subject, body]).size).toBe(3);
  });

  it("is stable for the same company and field", () => {
    expect(composeDraftKey("company-a", "to")).toBe(composeDraftKey("company-a", "to"));
  });

  it("gives the no-company case a key distinct from a real company's", () => {
    expect(composeDraftKey(null, "to")).not.toBe(composeDraftKey("company-a", "to"));
  });
});
