import { describe, expect, it } from "vitest";
import {
  frontMatterYamlProblem,
  frontMatterYamlText,
  joinFrontMatter,
  pastedFrontMatter,
  splitFrontMatter,
  withFrontMatterYaml,
} from "./front-matter";

const BOM = String.fromCharCode(0xfeff);

describe("splitFrontMatter", () => {
  it.each([
    { name: "a block and a blank line", text: "---\nname: x\n---\n\n# Title\n", yaml: "name: x", body: "# Title\n" },
    { name: "no blank line after the block", text: "---\nname: x\n---\n# Title\n", yaml: "name: x", body: "# Title\n" },
    {
      name: "Windows line endings",
      text: "---\r\nname: x\r\ntags: [a, b]\r\n---\r\n\r\n# Title\r\n",
      yaml: "name: x\ntags: [a, b]",
      body: "# Title\r\n",
    },
    { name: "a byte order mark", text: `${BOM}---\nname: x\n---\n\n# Title`, yaml: "name: x", body: "# Title" },
    { name: "only a block", text: "---\nname: x\n---\n", yaml: "name: x", body: "" },
    { name: "only a block, with no line ending", text: "---\nname: x\n---", yaml: "name: x", body: "" },
    { name: 'a block closed with "..."', text: "---\nname: x\n...\nBody", yaml: "name: x", body: "Body" },
    { name: "spaces after the fences", text: "--- \nname: x\n---\t\nBody", yaml: "name: x", body: "Body" },
    { name: "a blank line before the first key", text: "---\n\nname: x\n---\nBody", yaml: "\nname: x", body: "Body" },
    { name: "a key in quotes", text: '---\n"name": x\n---\nBody', yaml: '"name": x', body: "Body" },
    {
      name: '"---" used as a rule later',
      text: "---\nname: x\n---\n\nIntro\n\n---\n\nMore",
      yaml: "name: x",
      body: "Intro\n\n---\n\nMore",
    },
  ])("splits off $name and joins it back byte for byte", ({ text, yaml, body }) => {
    const split = splitFrontMatter(text);

    expect(split.frontMatter).not.toBeNull();
    expect(frontMatterYamlText(split.frontMatter!)).toBe(yaml);
    expect(split.body).toBe(body);
    expect(joinFrontMatter(split.frontMatter, split.body)).toBe(text);
  });

  it.each([
    { name: "a block that is never closed", text: "---\nname: x\n\n# Title\n\nBody" },
    { name: '"---" only as a rule', text: "# Title\n\n---\n\nMore" },
    { name: "a divider with text under it", text: "---\n\nIntro\n\n---\n\nMore" },
    { name: "a divider with a list under it", text: "---\n- one\n- two\n---\nMore" },
    { name: "an empty block", text: "---\n---\nBody" },
    { name: "a block of blank lines", text: "---\n\n---\nBody" },
    { name: "a code block that holds the closing line", text: "---\nname: x\n\n```yaml\na: 1\n---\n```\n\nBody" },
    { name: "a block with a code fence in it", text: "---\nname: x\n~~~\n---\nBody" },
    { name: "a blank line before the block", text: "\n---\nname: x\n---\n" },
    { name: "an indented first line", text: " ---\nname: x\n---\n" },
    { name: "four dashes", text: "----\nname: x\n----\n" },
    { name: "a lone opening line", text: "---" },
    { name: "a byte order mark and no block", text: `${BOM}# Title` },
    { name: "nothing", text: "" },
  ])("treats $name as markdown", ({ text }) => {
    expect(splitFrontMatter(text)).toEqual({ frontMatter: null, body: text });
    expect(joinFrontMatter(null, text)).toBe(text);
  });
});

describe("joinFrontMatter", () => {
  it("starts text added after a block that ends the file on a line of its own", () => {
    const { frontMatter } = splitFrontMatter("---\nname: x\n---");
    expect(joinFrontMatter(frontMatter, "Hello")).toBe("---\nname: x\n---\nHello");

    const windows = splitFrontMatter("---\r\nname: x\r\n---").frontMatter;
    expect(joinFrontMatter(windows, "Hello")).toBe("---\r\nname: x\r\n---\r\nHello");
  });
});

describe("frontMatterYamlProblem", () => {
  it("says why YAML would not be read back as front matter", () => {
    expect(frontMatterYamlProblem("name: x\ntags: [a]")).toBeNull();
    expect(frontMatterYamlProblem("\nname: x")).toBeNull();
    expect(frontMatterYamlProblem("note: |\n  ---")).toBeNull();
    expect(frontMatterYamlProblem("name: x\n---\ntags: [a]")).toBe("endsEarly");
    expect(frontMatterYamlProblem("name: x\n...")).toBe("endsEarly");
    expect(frontMatterYamlProblem("name: x\n```\ncode")).toBe("codeFence");
    expect(frontMatterYamlProblem("")).toBe("noKey");
    expect(frontMatterYamlProblem("Just a sentence")).toBe("noKey");
    expect(frontMatterYamlProblem("- one\n- two")).toBe("noKey");
    expect(frontMatterYamlProblem("https://example.com")).toBe("noKey");
  });
});

describe("withFrontMatterYaml", () => {
  it("replaces the YAML and keeps the fences, line endings and the blank lines after it", () => {
    const { frontMatter, body } = splitFrontMatter(`${BOM}---\r\nname: x\r\n---\r\n\r\n# Title`);
    const next = withFrontMatterYaml(frontMatter!, "name: y\ntags: [a]");

    expect(joinFrontMatter(next, body)).toBe(`${BOM}---\r\nname: y\r\ntags: [a]\r\n---\r\n\r\n# Title`);
  });

  it("gives back the same block for the YAML it shows", () => {
    for (const text of ["---\nname: x\n---\n", "---\r\nname: x\r\n\r\n---\r\n", "---\n\nname: x\n---\n"]) {
      const { frontMatter } = splitFrontMatter(text);
      expect(withFrontMatterYaml(frontMatter!, frontMatterYamlText(frontMatter!))).toEqual(frontMatter);
    }
  });

  it("refuses YAML that would not be read back as front matter", () => {
    const { frontMatter } = splitFrontMatter("---\nname: x\n---\n");

    expect(withFrontMatterYaml(frontMatter!, "name: x\n---\ntags: [a]")).toBeNull();
    expect(withFrontMatterYaml(frontMatter!, "name: x\n```")).toBeNull();
    expect(withFrontMatterYaml(frontMatter!, "")).toBeNull();
    expect(withFrontMatterYaml(frontMatter!, "Owner of this file")).toBeNull();
  });
});

describe("pastedFrontMatter", () => {
  it("makes a pasted file's front matter the file's, and leaves the rest of the paste for the rich text", () => {
    const file = splitFrontMatter("---\nname: old\n---\n\n# Old");
    expect(pastedFrontMatter(file, "---\nname: new\ntags: [a]\n---\n\n# New\n\nText")).toEqual({
      frontMatter: splitFrontMatter("---\nname: new\ntags: [a]\n---\n\n").frontMatter,
      body: "# Old",
      rest: "# New\n\nText",
    });
  });

  it("keeps the byte order mark a file starts with at its start", () => {
    for (const text of [`${BOM}# Old`, `${BOM}---\nname: old\n---\n# Old`]) {
      const pasted = pastedFrontMatter(splitFrontMatter(text), `${BOM}---\nname: new\n---\n# New`)!;
      expect(joinFrontMatter(pasted.frontMatter, pasted.body)).toBe(`${BOM}---\nname: new\n---\n# Old`);
    }
    const plain = pastedFrontMatter(splitFrontMatter("# Old"), `${BOM}---\nname: new\n---\n# New`)!;
    expect(joinFrontMatter(plain.frontMatter, plain.body)).toBe("---\nname: new\n---\n# Old");
  });

  it("is null for a paste that does not start with front matter", () => {
    const file = splitFrontMatter("---\nname: old\n---\n\n# Old");
    expect(pastedFrontMatter(file, "# Just markdown")).toBeNull();
    expect(pastedFrontMatter(file, "---\n\nA divider and text\n\n---\n\nMore")).toBeNull();
  });
});
