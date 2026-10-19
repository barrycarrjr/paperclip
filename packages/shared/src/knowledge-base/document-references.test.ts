import path from "node:path";
import { describe, expect, it } from "vitest";
import { documentReferences, driveIdFromUrl, relativeDocumentTarget, documentPath, documentLink } from "../index.js";
import { logicalDirname, logicalExtname, logicalJoin, logicalRelative } from "./logical-path.js";

const ID = "FakeIdentity_123";

describe("document references", () => {
  it("carries inline, reference, wiki, image and definition vectors with exact ranges", () => {
    const text = `[One](one(1).md "Title") (Drive-ID: ${ID})\r\n[Two][target]\n[[three|Three]]\n[target]: <two note.md>\n![Image](image.png)\n`;
    const result = documentReferences(text);
    expect(result.map(({ target, label, kind, image, line, driveFileId }) => ({ target, label, kind, image, line, driveFileId }))).toEqual([
      { target: "one(1).md", label: "One", kind: "inline", image: false, line: 1, driveFileId: ID },
      { target: "<two note.md>", label: "Two", kind: "reference", image: false, line: 2, driveFileId: null },
      { target: "three", label: "Three", kind: "wiki", image: false, line: 3, driveFileId: null },
      { target: "<two note.md>", label: "target", kind: "definition", image: false, line: 4, driveFileId: null },
      { target: "image.png", label: "Image", kind: "inline", image: true, line: 5, driveFileId: null },
    ]);
    expect(result[0]).toEqual({ start: 0, end: 24, line: 1, target: "one(1).md", label: "One", kind: "inline", image: false, driveFileId: ID, markerEnd: 53, targetStart: 6, targetEnd: 15 });
    for (const ref of result) {
      expect(text.slice(ref.start, ref.end)).toContain(ref.label);
      if (ref.targetStart !== null && ref.targetEnd !== null) expect(text.slice(ref.targetStart, ref.targetEnd)).toBe(ref.target);
    }
  });

  it("masks frontmatter, fences, comments, escaped links and multiline code without shifting offsets", () => {
    const prefix = '---\r\n[Header](bad.md)\r\n---\r\n\\[Escaped](bad.md)\n`[Code](bad.md)\ncontinued`\n<!-- [Comment](bad.md) -->\n~~~markdown\n[Fenced](bad.md)\n~~~\n';
    const text = prefix + '[Actual](actual.md "why (") (Drive-ID: unfinished';
    expect(documentReferences(text, 4)).toEqual([{
      start: prefix.length, end: prefix.length + 27, line: 11, target: "actual.md", label: "Actual", kind: "inline", image: false,
      driveFileId: "", markerEnd: prefix.length + 27, targetStart: prefix.length + 9, targetEnd: prefix.length + 18,
    }]);
    expect(documentReferences('<!-- unclosed\n[Hidden](bad.md)')).toEqual([]);
  });

  it("keeps first definition, case and whitespace folding, shortcut and collapsed references", () => {
    const text = '[A   B]: first.md\n[a b]: second.md\n[A B][]\n[A B]\n[Caption][a b]';
    expect(documentReferences(text).map(ref => [ref.kind, ref.target])).toEqual([
      ["definition", "first.md"], ["definition", "second.md"], ["reference", "first.md"], ["reference", "first.md"], ["reference", "first.md"],
    ]);
  });

  it.each([
    [`https://drive.google.com/file/d/${ID}/view`, ID], [`<https://drive.google.com/open?id=${ID}>`, ID],
    [`https://docs.google.com/document/d/${ID}/edit`, ID], [`https://docs.google.com/spreadsheets/d/${ID}/edit`, ID], [`https://docs.google.com/presentation/d/${ID}/edit`, ID],
    [`http://drive.google.com/file/d/${ID}`, null], [`https://drive.google.com.evil.example/file/d/${ID}`, null], [`https://evil.example/drive.google.com/file/d/${ID}`, null],
    [`https://user@drive.google.com/file/d/${ID}`, null], [`https://drive.google.com:444/file/d/${ID}`, null], ['https://drive.google.com/file/d/short/view', null],
    [`https://drive.google.com/drive/folders/${ID}`, null], ["not a URL", null],
  ])("preserves URL identity parsing for %s", (raw, expected) => expect(driveIdFromUrl(raw)).toBe(expected));
});

describe("logical document paths", () => {
  const files = new Map([["areas/target.md", "areas/Target.md"], ["areas/folder/index.md", "areas/folder/index.md"], ["areas/.hidden.md", "areas/.hidden.md"]]);
  it.each([
    ["target.md", false, "areas/Target.md", true], ["target", true, "areas/Target.md", true], ["folder", true, "areas/folder/index.md", true],
    [".hidden", true, "areas/.hidden.md", true], ["Target.md", false, "areas/Target.md", true],
    ["<target.md#heading>", false, "areas/Target.md", true], [".\\target.md", false, "areas/Target.md", true],
    ["%2E%2E/missing.md?query#heading", false, "missing.md", false], ["%ZZ.md", false, "areas/%ZZ.md", false],
    ["../../outside.md", false, "../outside.md", false], ["C:\\fake\\note.md", false, "C:/fake/note.md", false],
    ["\\\\fake\\share\\note.md", false, "//fake/share/note.md", false], ["%2Fabsolute.md", false, "/absolute.md", false],
    ["https://example.com/doc.md", false, null, true], ["//example.com/doc.md", false, null, true], ["#heading", false, null, true],
  ] as const)("resolves %s without host filesystem interpretation", (raw, wiki, resolved, valid) => {
    expect(relativeDocumentTarget("areas/source.md", raw, wiki, files, true)).toEqual({ resolved, valid });
  });

  it("makes case behavior explicit and keeps backslashes in logical source paths literal", () => {
    expect(relativeDocumentTarget("areas/source.md", "Target.md", false, files)).toEqual({ resolved: "areas/Target.md", valid: false });
    expect(relativeDocumentTarget("areas\\source.md", "target.md", false, files, true)).toEqual({ resolved: "target.md", valid: false });
    expect(documentPath("areas/source.md", "other/a b#.md")).toBe("../other/a%20b%23.md");
    expect(documentLink("Example", "areas/source.md", "other/a b.md", ID, "#heading")).toBe(`[Example](../other/a%20b.md#heading) (Drive-ID: ${ID})`);
  });

  it.each(["//server/share/dir", "//?/C:/dir"])("normalizes the explicit base %s for top-level document links", (base) => {
    expect(documentPath("note.md", "target.md", base)).toBe("target.md");
    expect(documentLink("Target", "note.md", "areas/a b.md", ID, "#heading", base)).toBe(`[Target](areas/a%20b.md#heading) (Drive-ID: ${ID})`);
    expect(documentPath("sub/note.md", "target.md", base)).toBe("../target.md");
    expect(documentLink("Target", "sub/note.md", "target.md", ID, "", base)).toBe(`[Target](../target.md) (Drive-ID: ${ID})`);
  });

  it("proves POSIX operations against Node including roots, dots, repeated slashes and Windows strings", () => {
    const atoms = ["", ".", "..", "...", ".hidden", "a", "a.", "b.md", "UPPER.MD", "a b", "C:", "a\\b"];
    const paths = ["/", "//", "///", "../", "../../", "a//", "a/..", "C:\\fake\\note.md", ...atoms.flatMap(a => atoms.map(b => `${a}/${b}`))];
    for (const value of paths) {
      expect(logicalDirname(value), value).toBe(path.posix.dirname(value));
      expect(logicalExtname(value), value).toBe(path.posix.extname(value));
      for (const other of paths) {
        expect(logicalJoin(value, other)).toBe(path.posix.join(value, other));
        for (const base of ["/", "/fake/base"]) expect(logicalRelative(value, other, base)).toBe(path.posix.relative(path.posix.resolve(base, value), path.posix.resolve(base, other)));
        const expected = path.posix.relative(path.posix.resolve("/fake/base", path.posix.dirname(value)), path.posix.resolve("/fake/base", other)).split("/").map(encodeURIComponent).join("/");
        expect(documentPath(value, other, "/fake/base")).toBe(expected);
      }
    }
  });
});
