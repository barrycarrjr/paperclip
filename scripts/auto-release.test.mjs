import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReleaseNotes, nextReleaseTag, parseTitle, releaseBase } from "./auto-release.mjs";

test("release base uses the UTC month without padding and a two-digit day", () => {
  assert.equal(releaseBase(new Date("2026-10-08T23:00:00Z")), "2026.1008");
  assert.equal(releaseBase(new Date("2027-01-05T00:00:00Z")), "2027.105");
});

test("next tag is one above the highest patch used today", () => {
  const date = new Date("2026-10-08T12:00:00Z");
  assert.equal(nextReleaseTag(date, []), "v2026.1008.0");
  assert.equal(nextReleaseTag(date, ["v2026.1007.4", "canary/v2026.1008.9"]), "v2026.1008.0");
  assert.equal(
    nextReleaseTag(date, ["refs/tags/v2026.1008.0", "v2026.1008.2", "v2026.1008.1", "v2026.10080.7"]),
    "v2026.1008.3",
  );
  assert.equal(nextReleaseTag(date, ["v2026.1008.1-canary.0"]), "v2026.1008.0");
});

test("titles lose their conventional prefix and pick a section", () => {
  assert.deepEqual(parseTitle("feat(agents): company defaults"), { kind: "feat", summary: "Company defaults" });
  assert.deepEqual(parseTitle("fix: stop a crash"), { kind: "fix", summary: "Stop a crash" });
  assert.deepEqual(parseTitle("Plain title"), { kind: "", summary: "Plain title" });
});

test("notes name the change, its issues, the pull request and the author", () => {
  const notes = buildReleaseNotes({
    tag: "v2026.1008.2",
    date: new Date("2026-10-08T21:00:00Z"),
    pr: {
      number: 42,
      title: "feat(agents): company defaults for run permissions",
      author: { login: "bryonstout" },
      closingIssuesReferences: [{ number: 41 }],
    },
  });
  assert.match(notes, /^# v2026\.1008\.2\n/);
  assert.match(notes, /> Released: 2026-10-08/);
  assert.match(notes, /## Features\n\n- \*\*Company defaults for run permissions\.\*\* \(#41, #42\)/);
  assert.match(notes, /@bryonstout\n$/);
  assert.doesNotMatch(notes, /[–—]/);
});
