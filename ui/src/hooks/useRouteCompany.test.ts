import { describe, expect, it } from "vitest";
import { resolveRouteCompanyId } from "./useRouteCompany";

const COMPANIES = [
  { id: "hq-id", issuePrefix: "HQ" },
  { id: "ind-id", issuePrefix: "IND" },
  { id: "c3-id", issuePrefix: "CME" },
];

describe("resolveRouteCompanyId", () => {
  it("resolves the company the URL names", () => {
    expect(resolveRouteCompanyId({ companyPrefix: "IND", companies: COMPANIES })).toBe("ind-id");
  });

  it("ignores case, because the route sync also rewrites casing", () => {
    expect(resolveRouteCompanyId({ companyPrefix: "ind", companies: COMPANIES })).toBe("ind-id");
  });

  it("returns nothing when the page is not under a company prefix", () => {
    expect(resolveRouteCompanyId({ companyPrefix: undefined, companies: COMPANIES })).toBeNull();
  });

  it("returns nothing for a prefix that matches no company", () => {
    // The caller falls back to the context selection rather than guessing.
    expect(resolveRouteCompanyId({ companyPrefix: "NOPE", companies: COMPANIES })).toBeNull();
  });

  it("returns nothing before the company list has loaded", () => {
    expect(resolveRouteCompanyId({ companyPrefix: "IND", companies: [] })).toBeNull();
  });

  it("does not return the previously selected company for a different prefix", () => {
    // The actual bug: the page rendered with the previous company while the URL
    // already said the new one, and a mailbox scoped to one company rejected it.
    const resolved = resolveRouteCompanyId({ companyPrefix: "IND", companies: COMPANIES });
    expect(resolved).not.toBe("hq-id");
    expect(resolved).not.toBe("c3-id");
  });
});
