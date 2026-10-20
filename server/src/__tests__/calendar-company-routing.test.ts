import { describe, expect, it } from "vitest";
import {
  formatGoogleEventSummary,
  hasCompanyTag,
  resolveCompanyForCalendarEvent,
  type CompanyRoutingMeta,
} from "../services/calendar-company-routing.js";

const mockCompanies: CompanyRoutingMeta[] = [
  { id: "personal-id", name: "Personal", issuePrefix: "PER", kind: "personal" },
  { id: "b2-id", name: "B2 Industries LLC", issuePrefix: "BIN", kind: "standard" },
  { id: "bho-id", name: "B2 Holdings LLC", issuePrefix: "BHO", kind: "standard" },
  { id: "ind-id", name: "Industry Bureau LLC", issuePrefix: "IND", kind: "standard" },
  { id: "hq-id", name: "HQ", issuePrefix: "HQ", kind: "standard", isPortfolioRoot: true },
  { id: "mme-id", name: "M3 Media LLC", issuePrefix: "MME", kind: "standard" },
];

describe("calendar-company-routing", () => {
  describe("resolveCompanyForCalendarEvent", () => {
    it("routes untagged events to Personal company", () => {
      expect(resolveCompanyForCalendarEvent("Dentist appointment", "", mockCompanies, "personal-id")).toBe("personal-id");
      expect(resolveCompanyForCalendarEvent("Visit gabe", "Catch up with Gabe", mockCompanies, "personal-id")).toBe("personal-id");
      expect(resolveCompanyForCalendarEvent("Chiropractor", null, mockCompanies, "personal-id")).toBe("personal-id");
    });

    it("routes bracketed prefix [BIN] to B2 Industries", () => {
      expect(resolveCompanyForCalendarEvent("[BIN] Review Q3 financials", "", mockCompanies, "personal-id")).toBe("b2-id");
      expect(resolveCompanyForCalendarEvent("[bin] Lowercase prefix", "", mockCompanies, "personal-id")).toBe("b2-id");
    });

    it("routes bracketed short name [B2] to B2 Industries", () => {
      expect(resolveCompanyForCalendarEvent("[B2] Board meeting", "", mockCompanies, "personal-id")).toBe("b2-id");
      expect(resolveCompanyForCalendarEvent("[B2 Industries] Meeting", "", mockCompanies, "personal-id")).toBe("b2-id");
    });

    it("routes [IND] and [Industry Bureau] to Industry Bureau", () => {
      expect(resolveCompanyForCalendarEvent("[IND] Client demo", "", mockCompanies, "personal-id")).toBe("ind-id");
      expect(resolveCompanyForCalendarEvent("[Industry Bureau] Design review", "", mockCompanies, "personal-id")).toBe("ind-id");
    });

    it("routes [Personal] explicitly to Personal", () => {
      expect(resolveCompanyForCalendarEvent("[Personal] Family dinner", "", mockCompanies, "personal-id")).toBe("personal-id");
      expect(resolveCompanyForCalendarEvent("[PER] Dry cleaners", "", mockCompanies, "personal-id")).toBe("personal-id");
    });

    it("routes hashtag #b2 or #bin in description or title", () => {
      expect(resolveCompanyForCalendarEvent("Investor sync #b2", "", mockCompanies, "personal-id")).toBe("b2-id");
      expect(resolveCompanyForCalendarEvent("Meeting", "Details here #bin", mockCompanies, "personal-id")).toBe("b2-id");
      expect(resolveCompanyForCalendarEvent("Doctor #personal", "", mockCompanies, "personal-id")).toBe("personal-id");
    });

    it("routes colon prefix in title", () => {
      expect(resolveCompanyForCalendarEvent("BIN: Team standup", "", mockCompanies, "personal-id")).toBe("b2-id");
      expect(resolveCompanyForCalendarEvent("B2: Planning", "", mockCompanies, "personal-id")).toBe("b2-id");
      expect(resolveCompanyForCalendarEvent("Personal: Pick up kids", "", mockCompanies, "personal-id")).toBe("personal-id");
    });
  });

  describe("formatGoogleEventSummary", () => {
    it("leaves personal events untagged", () => {
      const personal = mockCompanies[0];
      expect(formatGoogleEventSummary("Dentist appointment", personal)).toBe("Dentist appointment");
    });

    it("tags business company events with [PREFIX]", () => {
      const b2 = mockCompanies[1];
      expect(formatGoogleEventSummary("Review pitch deck", b2)).toBe("[BIN] Review pitch deck");
    });

    it("does not duplicate tag if already tagged", () => {
      const b2 = mockCompanies[1];
      expect(formatGoogleEventSummary("[BIN] Review pitch deck", b2)).toBe("[BIN] Review pitch deck");
      expect(formatGoogleEventSummary("[B2] Review pitch deck", b2)).toBe("[B2] Review pitch deck");
      expect(formatGoogleEventSummary("BIN: Review pitch deck", b2)).toBe("BIN: Review pitch deck");
    });
  });
});
