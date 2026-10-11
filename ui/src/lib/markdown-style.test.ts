import { describe, expect, it } from "vitest";
import { markdownStyleOptions } from "./markdown-style";

describe("markdownStyleOptions", () => {
  it("keeps the editor's own defaults for markdown that uses no markers", () => {
    expect(markdownStyleOptions("")).toEqual({ listItemIndent: "one" });
    expect(markdownStyleOptions("Just a sentence.")).toEqual({ listItemIndent: "one" });
  });

  it("takes the bullet from the first bulleted list", () => {
    expect(markdownStyleOptions("- one\n- two").bullet).toBe("-");
    expect(markdownStyleOptions("+ one\n+ two").bullet).toBe("+");
    expect(markdownStyleOptions("* one\n* two").bullet).toBe("*");
    expect(markdownStyleOptions("Intro\n\n- one\n\n* other").bullet).toBe("-");
    expect(markdownStyleOptions("- [ ] todo\n- [x] done").bullet).toBe("-");
    expect(markdownStyleOptions("> - quoted\n> - list").bullet).toBe("-");
  });

  it("does not read rules, bold text or numbers as bullets", () => {
    expect(markdownStyleOptions("Text\n\n* * *\n\nMore").bullet).toBeUndefined();
    expect(markdownStyleOptions("**Bold** start\n\n-5 degrees").bullet).toBeUndefined();
  });

  it("takes the numbered list style from the first numbered list", () => {
    expect(markdownStyleOptions("1. one\n2. two")).toMatchObject({ bulletOrdered: "." });
    expect(markdownStyleOptions("1. one\n2. two").incrementListMarker).toBeUndefined();
    expect(markdownStyleOptions("1) one\n2) two").bulletOrdered).toBe(")");
    expect(markdownStyleOptions("1. one\n1. two\n1. three").incrementListMarker).toBe(false);
    expect(markdownStyleOptions("1. one\n\n   More about one.\n\n1. two").incrementListMarker).toBe(false);
    expect(markdownStyleOptions("1. one\n   1. nested\n2. two").incrementListMarker).toBeUndefined();
  });

  it("takes how far list text is indented from the first list", () => {
    expect(markdownStyleOptions("-   one\n-   two").listItemIndent).toBe("tab");
    expect(markdownStyleOptions("1.  one\n2.  two").listItemIndent).toBe("tab");
    expect(markdownStyleOptions("- one\n- two").listItemIndent).toBe("one");
  });

  it("takes emphasis and strong markers from their first use", () => {
    expect(markdownStyleOptions("Some _emphasis_ and __strong__ text.")).toMatchObject({ emphasis: "_", strong: "_" });
    expect(markdownStyleOptions("Some *emphasis* and **strong** text.")).toMatchObject({ emphasis: "*", strong: "*" });
    expect(markdownStyleOptions("Use *star* first, then _underscore_.").emphasis).toBe("*");
  });

  it("does not read underscores in names, code or links as emphasis", () => {
    const options = markdownStyleOptions(
      "Keep snake_case_names, `a_b_c` and [the_doc](https://example.com/_x_/y) as they are.",
    );
    expect(options.emphasis).toBeUndefined();
    expect(options.strong).toBeUndefined();
  });

  it("takes the rule from the first rule, and not from a heading underline", () => {
    expect(markdownStyleOptions("Before\n\n---\n\nAfter")).toMatchObject({ rule: "-", ruleRepetition: 3, ruleSpaces: false });
    expect(markdownStyleOptions("Before\n\n- - - -\n\nAfter")).toMatchObject({ rule: "-", ruleRepetition: 4, ruleSpaces: true });
    expect(markdownStyleOptions("Title\n---\n\nText\n\n___").rule).toBe("_");
  });

  it("takes the heading style from the first top-level heading", () => {
    expect(markdownStyleOptions("# Title\n\nText")).toMatchObject({ setext: false, closeAtx: false });
    expect(markdownStyleOptions("# Title #\n\n## Part ##")).toMatchObject({ closeAtx: true });
    expect(markdownStyleOptions("Title\n=====\n\n## Part").setext).toBe(true);
    expect(markdownStyleOptions("## Part\n\nTitle\n=====").setext).toBe(false);
  });

  it("takes the code fence from the first fenced block and skips what is inside it", () => {
    const options = markdownStyleOptions("~~~md\n* not a list\n---\n_not emphasis_\n~~~\n\n- real list");
    expect(options).toMatchObject({ fence: "~", bullet: "-" });
    expect(options.rule).toBeUndefined();
    expect(options.emphasis).toBeUndefined();
    expect(markdownStyleOptions("```\ncode\n```").fence).toBe("`");
  });

  // it("skips YAML front matter", () => {
  //   const options = markdownStyleOptions("---\nname: skill\ndescription: does things\n---\n\n# Skill\n\n- step");
  //   expect(options).toMatchObject({ bullet: "-", setext: false });
  //   expect(options.rule).toBeUndefined();
  // });
  it("reads a divider at the top as a divider, since the editor keeps front matter out itself", () => {
    // A file's body that opens with a divider, then a line that looks like a
    // YAML key. Skipping it as front matter wrote every divider as "***".
    expect(markdownStyleOptions("---\n\nOwner: the team\n\n---\n\nMore")).toMatchObject({ rule: "-", ruleRepetition: 3 });
    expect(markdownStyleOptions("---\nname: skill\n---\n\n# Skill\n\n- step")).toMatchObject({ rule: "-", bullet: "-" });
  });

  it("reads Windows line endings", () => {
    expect(markdownStyleOptions("# Title\r\n\r\n- one\r\n- two\r\n")).toMatchObject({ bullet: "-", setext: false });
  });
});
