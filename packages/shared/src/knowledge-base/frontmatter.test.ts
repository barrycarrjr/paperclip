import { describe, expect, it } from "vitest";
import { validateMemoryFileHeader, declaredDriveFileId, DRIVE_FILE_ID_FIELDS, DRIVE_FILE_ID_PATTERN } from "../index.js";

const note = (fields: string) => `---\n${fields}\n---\nBody\n`;
const canonical = "name: Example\nkind: reference\nupdated: 2026-10-14";

describe("canonical note header", () => {
  it("keeps exact missing delimiter and required field problem ordering", () => {
    expect(validateMemoryFileHeader("Legacy body")).toEqual({
      valid: false, fields: {}, fieldLines: {}, bodyStartLine: 1, updated: null,
      problems: ["missing opening frontmatter delimiter", "required field name is missing", "required field kind is missing", "required field updated is missing"],
    });
    expect(validateMemoryFileHeader("---\n" + canonical).problems).toEqual([
      "missing closing frontmatter delimiter", "required field name is missing", "required field kind is missing", "required field updated is missing",
    ]);
  });

  it.each(["\n", "\r\n", "\r"])("normalizes BOM and %j without changing header line numbers", (newline) => {
    const text = note("# comment\nNAME: Example\nKind: REFERENCE\nUPDATED: 2026-10-14");
    expect(validateMemoryFileHeader("\uFEFF" + text.replace(/\n/g, newline))).toEqual({
      valid: true, fields: { name: "Example", kind: "REFERENCE", updated: "2026-10-14" },
      fieldLines: { name: 3, kind: 4, updated: 5 }, bodyStartLine: 7,
      updated: new Date("2026-10-14"), problems: [],
    });
  });

  it("preserves duplicate precedence, quote compatibility and ordinary object keys", () => {
    const result = validateMemoryFileHeader(note("name: 'It''s a note'\nNAME: Other\nkind: project\nupdated: 2026-10-14\nconstructor: own\ntoString: plain\n__proto__: invalid\n  name: indented"));
    expect(result.fields).toEqual({ name: "It's a note", kind: "project", updated: "2026-10-14", constructor: "own", tostring: "plain" });
    expect(Object.getPrototypeOf(result.fields)).toBe(Object.prototype);
    expect(result.fieldLines).toEqual({ name: 2, kind: 4, updated: 5, constructor: 6, tostring: 7 });
    expect(result.problems).toEqual(["field name is repeated", "line 8 is not a key: value field", "line 9 is not a key: value field"]);
    expect(validateMemoryFileHeader(note(canonical.replace("Example", '"bad\\q"'))).fields.name).toBe("bad\\q");
    expect(validateMemoryFileHeader(note(canonical.replace("Example", '"line\\nname"'))).fields.name).toBe("line\nname");
  });

  it("keeps field validation ordering and optional identity aliases", () => {
    const result = validateMemoryFileHeader(note(`name: ${"x".repeat(201)}\nkind: banana\nupdated: someday\ndescription: ${"x".repeat(501)}\nstatus: future\npaperclip_id: bad\ndrive_id: bad`));
    expect(result.problems).toEqual([
      "field name is longer than 200 characters", "field kind must be one of user, feedback, project, reference", "field updated must be an ISO date or timestamp",
      "field description is longer than 500 characters", "field status must be active, superseded, or archived", "field paperclip_id must be a UUID", "Drive identity must be an exact file ID",
    ]);
    expect(validateMemoryFileHeader(note(canonical + "\nstatus: ARCHIVED\npaperclipId: 11111111-1111-4111-8111-111111111111")).valid).toBe(true);
    expect(validateMemoryFileHeader(note(canonical + "\nstatus: \npaperclip_id: \npaperclipId: invalid")).valid).toBe(true);
  });

  it.each([
    ["2024-02-29", "2024-02-29T00:00:00.000Z"], ["2000-02-29", "2000-02-29T00:00:00.000Z"],
    ["2026-10-14T24:00:00Z", "2026-10-15T00:00:00.000Z"],
    ["2026-10-14T23:59:59.123456789+02:30", "2026-10-14T21:29:59.123Z"],
    ["2026-02-31", null], ["1900-02-29", null], ["0000-02-29", null], ["0099-02-29", null],
    ["2026-13-01", null], ["2026-00-01", null], ["2026-01-00", null], ["2026-1-01", null],
    ["2026-10-14T23:60:00Z", null], ["2026-10-14T00:00:00+24:00", null],
    ["2026-10-14t00:00:00z", null], ["2026-10-14T00:00:00", null],
  ])("preserves existing date compatibility for %s", (value, iso) => {
    const result = validateMemoryFileHeader(note(canonical.replace("2026-10-14", value)));
    expect(result.updated?.toISOString() ?? null).toBe(iso);
    expect(result.valid).toBe(iso !== null);
  });
});

describe("declared Drive identity", () => {
  it("accepts exactly bounded opaque IDs without consulting a URL or network", () => {
    for (const size of [10, 200]) expect(DRIVE_FILE_ID_PATTERN.test("x".repeat(size))).toBe(true);
    for (const value of ["x".repeat(9), "x".repeat(201), "bad id", "https://drive.google.com/open?id=FakeIdentity_123"]) expect(DRIVE_FILE_ID_PATTERN.test(value)).toBe(false);
    expect(declaredDriveFileId({})).toEqual({ id: null, problem: null });
    for (const key of DRIVE_FILE_ID_FIELDS) expect(declaredDriveFileId({ [key]: " FakeIdentity_123 " })).toEqual({ id: "FakeIdentity_123", problem: null });
    expect(declaredDriveFileId({ drive_id: "FakeIdentity_123", drivefileid: "FakeIdentity_123" })).toEqual({ id: "FakeIdentity_123", problem: null });
    expect(declaredDriveFileId({ drive_id: "FakeIdentity_123", drive_file_id: "FakeIdentity_456" })).toEqual({ id: null, problem: "Drive identity fields disagree" });
    expect(declaredDriveFileId({ drive_id: "FakeIdentity_123", drive_file_id: "" })).toEqual({ id: null, problem: "Drive identity must be an exact file ID" });
    expect(declaredDriveFileId(Object.create({ drive_id: "FakeIdentity_123" }))).toEqual({ id: null, problem: null });
  });
});
