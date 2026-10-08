#!/usr/bin/env node
// Writes the release notes file for a pull request that was just merged into
// master, and prints the release tag to use. Run by
// .github/workflows/auto-release.yml; see doc/RELEASING.md.
//
// Usage: node scripts/auto-release.mjs <pr.json> <existing tags, one per line>
// where pr.json is the output of
// `gh pr view <n> --json number,title,author,closingIssuesReferences`.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Today's UTC date as the release base, for example 2026-10-08 gives 2026.1008.
export function releaseBase(date) {
  const month = date.getUTCMonth() + 1;
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${date.getUTCFullYear()}.${month}${day}`;
}

// The next free tag for the day: vYYYY.MDD.P with P one above the highest used.
export function nextReleaseTag(date, existingTags) {
  const base = releaseBase(date);
  const prefix = `v${base}.`;
  let next = 0;
  for (const raw of existingTags) {
    const tag = raw.trim().replace(/^refs\/tags\//, "");
    if (!tag.startsWith(prefix)) continue;
    const patch = tag.slice(prefix.length);
    if (!/^\d+$/.test(patch)) continue;
    next = Math.max(next, Number(patch) + 1);
  }
  return `${prefix}${next}`;
}

// "feat(agents): company defaults" gives { kind: "feat", summary: "Company defaults" }.
export function parseTitle(title) {
  const match = /^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/.exec(title.trim());
  const kind = match ? match[1].toLowerCase() : "";
  const text = (match ? match[2] : title).trim();
  return { kind, summary: text.charAt(0).toUpperCase() + text.slice(1) };
}

export function sectionFor(kind) {
  if (kind === "feat") return "Features";
  if (kind === "fix") return "Fixes";
  return "Changes";
}

export function buildReleaseNotes({ tag, date, pr }) {
  const { kind, summary } = parseTitle(pr.title);
  const issues = (pr.closingIssuesReferences ?? []).map((issue) => `#${issue.number}`);
  const refs = [...issues, `#${pr.number}`].join(", ");
  const day = date.toISOString().slice(0, 10);
  const author = pr.author?.login;

  return `# ${tag}

> Released: ${day}
>
> Fork-only GitHub release for \`barrycarrjr/paperclip\`. This release is not published to npm.
> Written automatically when pull request #${pr.number} was merged. The pull request has the full details.

## ${sectionFor(kind)}

- **${summary}.** (${refs})

## Upgrade Guide

- Use **Update Paperclip** as before.
- This is a GitHub-only release of the \`barrycarrjr/paperclip\` fork. No \`paperclipai\` npm dist-tag is changed.

## Contributors

Thank you to everyone who contributed to this release!

${author ? `@${author}` : ""}
`;
}

function main() {
  const [prFile, tagsFile] = process.argv.slice(2);
  if (!prFile || !tagsFile) {
    console.error("Usage: node scripts/auto-release.mjs <pr.json> <tags.txt>");
    process.exit(1);
  }
  const pr = JSON.parse(readFileSync(prFile, "utf8"));
  const tags = readFileSync(tagsFile, "utf8").split("\n").filter(Boolean);
  const date = new Date();
  const tag = nextReleaseTag(date, tags);

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const notesFile = join(repoRoot, "releases", `${tag}.md`);
  mkdirSync(dirname(notesFile), { recursive: true });
  writeFileSync(notesFile, buildReleaseNotes({ tag, date, pr }));
  process.stdout.write(`${tag}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
