import { describe, expect, it } from "vitest";
import {
  parseIssuePathIdFromPath,
  parseIssueReferenceFromHref,
  remarkLinkIssueReferences,
} from "./issue-reference";

type Node = { type: string; value?: string; url?: string; children?: Node[] };

function runLinkifier(input: string, knownPrefixes: ReadonlyArray<string> | undefined) {
  const root: Node = { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: input }] }] };
  remarkLinkIssueReferences({ knownPrefixes })(root);
  const paragraph = root.children?.[0];
  return paragraph?.children ?? [];
}

describe("issue-reference", () => {
  it("extracts issue ids from company-scoped issue paths", () => {
    expect(parseIssuePathIdFromPath("/PAP/issues/PAP-1271")).toBe("PAP-1271");
    expect(parseIssuePathIdFromPath("/PAP/issues/pap-1272")).toBe("PAP-1272");
    expect(parseIssuePathIdFromPath("/issues/PAP-1179")).toBe("PAP-1179");
    expect(parseIssuePathIdFromPath("/issues/:id")).toBeNull();
  });

  it("does not treat full issue URLs as internal issue paths", () => {
    expect(parseIssuePathIdFromPath("http://localhost:3100/PAP/issues/PAP-1179")).toBeNull();
    expect(parseIssuePathIdFromPath("http://remote.example.test:3103/PAPA/issues/PAPA-115#comment-850083f3-24de-43e7-a8cd-bc01f7cc9f0d")).toBeNull();
  });

  it("does not treat GitHub issue URLs as internal Paperclip issue links", () => {
    expect(parseIssuePathIdFromPath("https://github.com/paperclipai/paperclip/issues/1778")).toBeNull();
    expect(parseIssueReferenceFromHref("https://github.com/paperclipai/paperclip/issues/1778")).toBeNull();
  });

  it("ignores placeholder issue paths", () => {
    expect(parseIssuePathIdFromPath("/issues/:id")).toBeNull();
    expect(parseIssuePathIdFromPath("http://localhost:3100/issues/:id")).toBeNull();
    expect(parseIssueReferenceFromHref("/issues/:id")).toBeNull();
  });

  it("normalizes bare identifiers, relative issue paths, and issue scheme links into internal links", () => {
    expect(parseIssueReferenceFromHref("pap-1271")).toEqual({
      issuePathId: "PAP-1271",
      href: "/issues/PAP-1271",
    });
    expect(parseIssueReferenceFromHref("/PAP/issues/pap-1180")).toEqual({
      issuePathId: "PAP-1180",
      href: "/issues/PAP-1180",
    });
    expect(parseIssueReferenceFromHref("issue://PAP-1310")).toEqual({
      issuePathId: "PAP-1310",
      href: "/issues/PAP-1310",
    });
    expect(parseIssueReferenceFromHref("issue://:PAP-1311")).toEqual({
      issuePathId: "PAP-1311",
      href: "/issues/PAP-1311",
    });
  });

  it("normalizes exact inline-code-like issue identifiers", () => {
    expect(parseIssueReferenceFromHref("PAP-1271")).toEqual({
      issuePathId: "PAP-1271",
      href: "/issues/PAP-1271",
    });
  });

  it("preserves absolute Paperclip issue URLs so origin, port, and hash are not lost", () => {
    expect(parseIssueReferenceFromHref("http://localhost:3100/PAP/issues/PAP-1179")).toBeNull();
    expect(parseIssueReferenceFromHref("http://remote.example.test:3103/PAPA/issues/PAPA-115#comment-850083f3-24de-43e7-a8cd-bc01f7cc9f0d")).toBeNull();
  });

  it("ignores literal route placeholder paths", () => {
    expect(parseIssueReferenceFromHref("/issues/:id")).toBeNull();
    expect(parseIssueReferenceFromHref("http://localhost:3100/api/issues/:id")).toBeNull();
  });

  describe("remarkLinkIssueReferences", () => {
    it("auto-links bare identifiers when no prefix allowlist is provided", () => {
      const children = runLinkifier("See PAP-1271 and PHASE-1 here.", undefined);
      const links = children.filter((n) => n.type === "link");
      expect(links.map((n) => n.url)).toEqual(["/issues/PAP-1271", "/issues/PHASE-1"]);
    });

    it("skips bare identifiers whose prefix is not in the allowlist", () => {
      const children = runLinkifier("Phase plan: PHASE-1 and PHASE-2 vs PAP-1271.", ["PAP", "MME"]);
      const links = children.filter((n) => n.type === "link");
      expect(links.map((n) => n.url)).toEqual(["/issues/PAP-1271"]);
      // Surrounding text remains intact (no PHASE-1 ever became a link).
      const reassembled = children
        .map((n) => (n.type === "text" ? n.value : (n.children?.[0]?.value ?? "")))
        .join("");
      expect(reassembled).toBe("Phase plan: PHASE-1 and PHASE-2 vs PAP-1271.");
    });

    it("treats an empty allowlist as 'no bare identifiers allowed'", () => {
      const children = runLinkifier("PAP-1 and PHASE-1.", []);
      expect(children.filter((n) => n.type === "link")).toHaveLength(0);
    });

    it("still linkifies explicit issue paths even when bare identifiers are filtered out", () => {
      const children = runLinkifier("See /issues/PHASE-1 and PHASE-2.", ["PAP"]);
      const links = children.filter((n) => n.type === "link");
      expect(links.map((n) => n.url)).toEqual(["/issues/PHASE-1"]);
    });
  });
});
