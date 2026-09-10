import { describe, expect, it } from "vitest";
import { possessive } from "./possessive";

describe("possessive", () => {
  it("adds an apostrophe and an s to an ordinary name", () => {
    expect(possessive("Acme")).toBe("Acme's");
  });

  it("adds only an apostrophe to a name that already ends in s", () => {
    expect(possessive("Northwind Holdings")).toBe("Northwind Holdings'");
    expect(possessive("PBS")).toBe("PBS'");
  });

  it("leaves an empty name alone", () => {
    expect(possessive("   ")).toBe("");
  });
});
