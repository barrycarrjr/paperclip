import { describe, it, expect } from "vitest";
import {
  contentDispositionHeader,
  DEFAULT_ALLOWED_TYPES,
  INLINE_ATTACHMENT_TYPES,
  isInlineAttachmentContentType,
  matchesContentType,
  normalizeContentType,
  parseAllowedTypes,
} from "../attachment-types.js";

describe("parseAllowedTypes", () => {
  it("returns default image types when input is undefined", () => {
    expect(parseAllowedTypes(undefined)).toEqual([...DEFAULT_ALLOWED_TYPES]);
  });

  it("returns default image types when input is empty string", () => {
    expect(parseAllowedTypes("")).toEqual([...DEFAULT_ALLOWED_TYPES]);
  });

  it("parses comma-separated types", () => {
    expect(parseAllowedTypes("image/*,application/pdf")).toEqual([
      "image/*",
      "application/pdf",
    ]);
  });

  it("trims whitespace", () => {
    expect(parseAllowedTypes(" image/png , application/pdf ")).toEqual([
      "image/png",
      "application/pdf",
    ]);
  });

  it("lowercases entries", () => {
    expect(parseAllowedTypes("Application/PDF")).toEqual(["application/pdf"]);
  });

  it("filters empty segments", () => {
    expect(parseAllowedTypes("image/png,,application/pdf,")).toEqual([
      "image/png",
      "application/pdf",
    ]);
  });
});

describe("matchesContentType", () => {
  it("matches exact types", () => {
    const patterns = ["application/pdf", "image/png"];
    expect(matchesContentType("application/pdf", patterns)).toBe(true);
    expect(matchesContentType("image/png", patterns)).toBe(true);
    expect(matchesContentType("text/plain", patterns)).toBe(false);
  });

  it("matches /* wildcard patterns", () => {
    const patterns = ["image/*"];
    expect(matchesContentType("image/png", patterns)).toBe(true);
    expect(matchesContentType("image/jpeg", patterns)).toBe(true);
    expect(matchesContentType("image/svg+xml", patterns)).toBe(true);
    expect(matchesContentType("application/pdf", patterns)).toBe(false);
  });

  it("matches .* wildcard patterns", () => {
    const patterns = ["application/vnd.openxmlformats-officedocument.*"];
    expect(
      matchesContentType(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        patterns,
      ),
    ).toBe(true);
    expect(
      matchesContentType(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        patterns,
      ),
    ).toBe(true);
    expect(matchesContentType("application/pdf", patterns)).toBe(false);
  });

  it("is case-insensitive", () => {
    const patterns = ["application/pdf"];
    expect(matchesContentType("APPLICATION/PDF", patterns)).toBe(true);
    expect(matchesContentType("Application/Pdf", patterns)).toBe(true);
  });

  it("combines exact and wildcard patterns", () => {
    const patterns = ["image/*", "application/pdf", "text/*"];
    expect(matchesContentType("image/webp", patterns)).toBe(true);
    expect(matchesContentType("application/pdf", patterns)).toBe(true);
    expect(matchesContentType("text/csv", patterns)).toBe(true);
    expect(matchesContentType("application/zip", patterns)).toBe(false);
  });

  it("handles plain * as allow-all wildcard", () => {
    const patterns = ["*"];
    expect(matchesContentType("image/png", patterns)).toBe(true);
    expect(matchesContentType("application/pdf", patterns)).toBe(true);
    expect(matchesContentType("text/plain", patterns)).toBe(true);
    expect(matchesContentType("application/zip", patterns)).toBe(true);
  });
});

describe("normalizeContentType", () => {
  it("lowercases and trims explicit types", () => {
    expect(normalizeContentType(" Application/Zip ")).toBe("application/zip");
  });

  it("falls back to octet-stream when the type is missing", () => {
    expect(normalizeContentType(undefined)).toBe("application/octet-stream");
    expect(normalizeContentType("")).toBe("application/octet-stream");
  });
});

describe("isInlineAttachmentContentType", () => {
  it("allows the configured inline-safe types", () => {
    for (const contentType of ["image/png", "image/svg+xml", "application/pdf", "text/plain"]) {
      expect(isInlineAttachmentContentType(contentType)).toBe(true);
    }
  });

  it("rejects potentially unsafe or binary download types", () => {
    expect(INLINE_ATTACHMENT_TYPES).not.toContain("text/html");
    expect(isInlineAttachmentContentType("text/html")).toBe(false);
    expect(isInlineAttachmentContentType("application/zip")).toBe(false);
  });
});

describe("contentDispositionHeader", () => {
  it("keeps a plain name as it is, with the same name in filename*", () => {
    expect(contentDispositionHeader("inline", "invoice-7.png")).toBe(
      `inline; filename="invoice-7.png"; filename*=UTF-8''invoice-7.png`,
    );
  });

  it("falls back to ASCII and percent-encodes the real name", () => {
    expect(contentDispositionHeader("attachment", "Résumé (final).pdf")).toBe(
      `attachment; filename="Resume (final).pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%28final%29.pdf`,
    );
  });

  it("drops what would break the quoted name, and survives half a surrogate pair", () => {
    expect(contentDispositionHeader("inline", 'say "hi"\\.png')).toBe(
      `inline; filename="say hi.png"; filename*=UTF-8''say%20%22hi%22%5C.png`,
    );
    expect(contentDispositionHeader("inline", "a\uD800b.png")).toBe(
      `inline; filename="a_b.png"; filename*=UTF-8''a%EF%BF%BDb.png`,
    );
    expect(contentDispositionHeader("inline", "")).toBe(`inline; filename="file"; filename*=UTF-8''`);
  });
});
