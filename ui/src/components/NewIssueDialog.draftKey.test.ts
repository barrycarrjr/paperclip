import { describe, expect, it } from "vitest";
import { draftStorageKey } from "./NewIssueDialog";

describe("draftStorageKey", () => {
  it("gives two different companies two different storage keys", () => {
    // Regression: an unscoped key let a draft carrying company-A entity ids
    // (project, assignee, execution workspace) come back under company B.
    expect(draftStorageKey("company-a")).not.toBe(draftStorageKey("company-b"));
  });

  it("is stable for the same company", () => {
    expect(draftStorageKey("company-a")).toBe(draftStorageKey("company-a"));
  });

  it("gives the no-company case a key distinct from a real company's", () => {
    expect(draftStorageKey(null)).not.toBe(draftStorageKey("company-a"));
  });
});
