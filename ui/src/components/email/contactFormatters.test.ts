import { describe, it, expect } from "vitest";
import {
  exportContactsAsCsv,
  exportContactsAsVCard,
  exportContactsAsJson,
  parseContactsFromCsv,
  parseContactsFromVCard,
  parseContactsFromJson,
  parseContactsFile,
} from "./contactFormatters";
import type { EmailContact } from "../../api/emailTools";

describe("contactFormatters", () => {
  const mockContacts: EmailContact[] = [
    {
      id: "1",
      companyId: "comp-1",
      name: "Alice Smith",
      email: "alice@example.com",
      notes: "CEO, Founder",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    {
      id: "2",
      companyId: "comp-1",
      name: "Bob Jones",
      email: "bob@example.com",
      notes: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ];

  describe("CSV Export and Import", () => {
    it("exports to CSV format properly escaping commas", () => {
      const csv = exportContactsAsCsv(mockContacts);
      expect(csv).toContain("Name,Email,Notes");
      expect(csv).toContain('"Alice Smith","alice@example.com","CEO, Founder"');
      expect(csv).toContain('"Bob Jones","bob@example.com",""');
    });

    it("imports standard CSV", () => {
      const csv = `Name,Email,Notes\n"Charlie Brown",charlie@peanuts.com,"Lead"\nLucy,lucy@peanuts.com,`;
      const { contacts, errors } = parseContactsFromCsv(csv);
      expect(errors).toHaveLength(0);
      expect(contacts).toHaveLength(2);
      expect(contacts[0]).toEqual({
        name: "Charlie Brown",
        email: "charlie@peanuts.com",
        notes: "Lead",
      });
      expect(contacts[1]).toEqual({
        name: "Lucy",
        email: "lucy@peanuts.com",
        notes: null,
      });
    });

    it("handles alternative header names (e.g. Google / Outlook contacts)", () => {
      const csv = `First Name,Last Name,E-mail Address,Description\nLinus,Van Pelt,linus@peanuts.com,Blanket`;
      const { contacts, errors } = parseContactsFromCsv(csv);
      expect(errors).toHaveLength(0);
      expect(contacts).toHaveLength(1);
      expect(contacts[0]).toEqual({
        name: "Linus Van Pelt",
        email: "linus@peanuts.com",
        notes: "Blanket",
      });
    });

    it("handles headerless CSV fallback", () => {
      const csv = `snoopy@peanuts.com,Snoopy,Dog`;
      const { contacts } = parseContactsFromCsv(csv);
      expect(contacts).toHaveLength(1);
      expect(contacts[0].email).toBe("snoopy@peanuts.com");
      expect(contacts[0].name).toBe("Snoopy");
    });
  });

  describe("vCard Export and Import", () => {
    it("exports to vCard 3.0", () => {
      const vcf = exportContactsAsVCard(mockContacts);
      expect(vcf).toContain("BEGIN:VCARD");
      expect(vcf).toContain("VERSION:3.0");
      expect(vcf).toContain("FN:Alice Smith");
      expect(vcf).toContain("EMAIL;TYPE=INTERNET:alice@example.com");
      expect(vcf).toContain("NOTE:CEO\\, Founder");
      expect(vcf).toContain("END:VCARD");
    });

    it("imports vCard with FN and N fallbacks", () => {
      const vcf = `
BEGIN:VCARD
VERSION:3.0
FN:Woodstock Bird
EMAIL;TYPE=INTERNET:woodstock@peanuts.com
NOTE:Yellow friend
END:VCARD

BEGIN:VCARD
VERSION:2.1
N:Brown;Sally;;;
EMAIL:sally@peanuts.com
END:VCARD
`;
      const { contacts, errors } = parseContactsFromVCard(vcf);
      expect(errors).toHaveLength(0);
      expect(contacts).toHaveLength(2);
      expect(contacts[0]).toEqual({
        name: "Woodstock Bird",
        email: "woodstock@peanuts.com",
        notes: "Yellow friend",
      });
      expect(contacts[1]).toEqual({
        name: "Sally Brown",
        email: "sally@peanuts.com",
        notes: null,
      });
    });
  });

  describe("JSON Export and Import", () => {
    it("exports to clean JSON", () => {
      const json = exportContactsAsJson(mockContacts);
      const parsed = JSON.parse(json);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].email).toBe("alice@example.com");
      expect(parsed[0].name).toBe("Alice Smith");
      expect(parsed[0].notes).toBe("CEO, Founder");
    });

    it("imports raw array and nested contacts", () => {
      const jsonArray = JSON.stringify([
        { email: "peppermint@peanuts.com", name: "Peppermint Patty" },
      ]);
      const res1 = parseContactsFromJson(jsonArray);
      expect(res1.contacts).toHaveLength(1);
      expect(res1.contacts[0].email).toBe("peppermint@peanuts.com");

      const jsonWrapped = JSON.stringify({
        contacts: [
          { email: "marcie@peanuts.com", name: "Marcie", notes: "Best friend" },
        ],
      });
      const res2 = parseContactsFromJson(jsonWrapped);
      expect(res2.contacts).toHaveLength(1);
      expect(res2.contacts[0].email).toBe("marcie@peanuts.com");
    });
  });

  describe("parseContactsFile autodetection", () => {
    it("autodetects CSV, vCard, and JSON", () => {
      expect(parseContactsFile(`[{"email":"test@a.com"}]`, "data.json").format).toBe("json");
      expect(parseContactsFile(`BEGIN:VCARD\nEMAIL:test@a.com\nEND:VCARD`, "c.vcf").format).toBe("vcard");
      expect(parseContactsFile(`Email,Name\ntest@a.com,Test`, "c.csv").format).toBe("csv");
    });
  });
});
