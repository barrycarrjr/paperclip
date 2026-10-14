import { describe, expect, it } from "vitest";
import { matchesPluginSearch } from "./PluginManager";

describe("matchesPluginSearch", () => {
  const fields = ["Email Tools", "Send and read mail from agents", "email-tools", null];

  it("matches everything when the query is blank", () => {
    expect(matchesPluginSearch("", fields)).toBe(true);
    expect(matchesPluginSearch("   ", fields)).toBe(true);
  });

  it("ignores case and searches every field", () => {
    expect(matchesPluginSearch("EMAIL", fields)).toBe(true);
    expect(matchesPluginSearch("agents", fields)).toBe(true);
    expect(matchesPluginSearch("email-tools", fields)).toBe(true);
  });

  it("needs every word to appear somewhere", () => {
    expect(matchesPluginSearch("mail agents", fields)).toBe(true);
    expect(matchesPluginSearch("mail calendar", fields)).toBe(false);
  });
});
