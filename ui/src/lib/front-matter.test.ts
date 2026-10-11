import { describe, expect, it } from "vitest";
import { frontMatterYamlText, joinFrontMatter, splitFrontMatter, withFrontMatterYaml } from "./front-matter";

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
    { name: "a byte order mark", text: "\uFEFF---\nname: x\n---\n\n# Title", yaml: "name: x", body: "# Title" },
    { name: "only a block", text: "---\nname: x\n---\n", yaml: "name: x", body: "" },
    { name: "only a block, with no line ending", text: "---\nname: x\n---", yaml: "name: x", body: "" },
    { name: "an empty block", text: "---\n---\nBody", yaml: "", body: "Body" },
    { name: 'a block closed with "..."', text: "---\nname: x\n...\nBody", yaml: "name: x", body: "Body" },
    { name: "spaces after the fences", text: "--- \nname: x\n---\t\nBody", yaml: "name: x", body: "Body" },
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
    { name: "a blank line before the block", text: "\n---\nname: x\n---\n" },
    { name: "an indented first line", text: " ---\nname: x\n---\n" },
    { name: "four dashes", text: "----\nname: x\n----\n" },
    { name: "a lone opening line", text: "---" },
    { name: "a byte order mark and no block", text: "\uFEFF# Title" },
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

describe("withFrontMatterYaml", () => {
  it("replaces the YAML and keeps the fences, line endings and the blank lines after it", () => {
    const { frontMatter, body } = splitFrontMatter("\uFEFF---\r\nname: x\r\n---\r\n\r\n# Title");
    const next = withFrontMatterYaml(frontMatter!, "name: y\ntags: [a]");

    expect(joinFrontMatter(next, body)).toBe("\uFEFF---\r\nname: y\r\ntags: [a]\r\n---\r\n\r\n# Title");
    expect(joinFrontMatter(withFrontMatterYaml(frontMatter!, ""), body)).toBe("\uFEFF---\r\n---\r\n\r\n# Title");
  });

  it("gives back the same block for the YAML it shows", () => {
    for (const text of ["---\nname: x\n---\n", "---\r\nname: x\r\n\r\n---\r\n", "---\n---\n"]) {
      const { frontMatter } = splitFrontMatter(text);
      expect(withFrontMatterYaml(frontMatter!, frontMatterYamlText(frontMatter!))).toEqual(frontMatter);
    }
  });

  it("refuses YAML with a line that would end the block early", () => {
    const { frontMatter } = splitFrontMatter("---\nname: x\n---\n");

    expect(withFrontMatterYaml(frontMatter!, "name: x\n---\ntags: [a]")).toBeNull();
    expect(withFrontMatterYaml(frontMatter!, "name: x\n...")).toBeNull();
    expect(withFrontMatterYaml(frontMatter!, "note: |\n  ---")).not.toBeNull();
  });
});
