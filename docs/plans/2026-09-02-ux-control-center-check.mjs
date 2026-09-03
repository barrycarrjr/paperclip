// Read-only, provider-neutral validation of this planning package.
// Run from any directory: node <path-to-this-file>
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const plans = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(plans, "../..");
const prefix = "2026-09-02-ux-control-center";
const documents = fs.readdirSync(plans).filter((n) => n.startsWith(prefix) && n.endsWith(".md"));
const referenceDirectory = path.join(plans, `${prefix}-reference`);
const references = fs.readdirSync(referenceDirectory).filter((n) => /\.(?:md|html)$/.test(n));
assert.equal(documents.length, 7, "Expected seven current planning documents");
assert.equal(references.length, 5, "Expected two audits and three mockups");

let links = 0;
const markdown = [
  ...documents.map((n) => path.join(plans, n)),
  ...references.filter((n) => n.endsWith(".md")).map((n) => path.join(referenceDirectory, n)),
];
for (const file of markdown) {
  const body = fs.readFileSync(file, "utf8");
  for (const match of body.matchAll(/\[[^\]]+\]\((?:<([^>]+)>|([^\s)]+))\)/g)) {
    const href = match[1] || match[2];
    if (/^(?:https?:|mailto:|#)/.test(href)) continue;
    assert(!/^(?:[A-Z]:|\/)/i.test(href), `Nonportable link: ${href}`);
    const destination = path.resolve(path.dirname(file), decodeURIComponent(href.split("#")[0]));
    assert(destination.startsWith(root + path.sep), `Link escapes repository: ${href}`);
    assert(fs.existsSync(destination), `Broken link: ${file} -> ${href}`);
    links++;
  }
  if (path.dirname(file) === plans) {
    const lines = body.split(/\r?\n/);
    lines.forEach((line, index) => {
      assert(!/[ \t]+$/.test(line), `Trailing whitespace: ${file}:${index + 1}`);
      if (/^#{1,6} /.test(line)) assert.equal(lines[index + 1], "", `Heading spacing: ${file}:${index + 1}`);
    });
  }
}

for (const name of references.filter((n) => n.endsWith(".html"))) {
  const html = fs.readFileSync(path.join(referenceDirectory, name), "utf8");
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (match[1].trim()) new vm.Script(match[1]);
  }
}
const preservation = fs.readFileSync(path.join(plans, `${prefix}-preservation.md`), "utf8");
const validation = fs.readFileSync(path.join(plans, `${prefix}-validation.md`), "utf8");
for (const [letter, count, source] of [["F", 30, preservation], ["X", 11, preservation], ["A", 26, validation]]) {
  for (let i = 1; i <= count; i++) {
    const id = `${letter}${String(i).padStart(2, "0")}`;
    assert(source.includes(`| ${id} |`), `Missing contract: ${id}`);
  }
}
console.log(JSON.stringify({
  status: "passed",
  planningDocuments: documents.length,
  referenceSnapshots: references.length,
  relativeLinksVerified: links,
  featureContracts: 30,
  pluginFamilies: 11,
  acceptanceScenarios: 26,
  mockupScripts: "syntax checked, not executed",
  applicationVerification: "not performed by this checker",
}, null, 2));
