import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function needsSecurityReview(subject, paths) {
  return /security|\bcve[- ]|vulnerab|entropy|rate.?limit|signing.?key|tenant|cross.?company/i.test(subject)
    || paths.some((file) => /^(server\/src\/(agent-auth-jwt|middleware\/auth|routes\/(access|authz|plugins|secrets)|services\/(invite|plugin-|secrets))|packages\/db\/src\/schema\/plugin_|packages\/plugins\/sdk\/src\/(protocol|types))/.test(file));
}

function main() {
  const baseline = JSON.parse(readFileSync(new URL("./upstream-security-baseline.json", import.meta.url), "utf8"));
  const ref = process.argv[2] || "upstream/master";
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
  // Missing refs or rewritten upstream history fail visibly; no automatic merge.
  if (git("merge-base", baseline.upstreamCommit, ref) !== baseline.upstreamCommit) throw new Error("Upstream history changed; review the baseline before continuing.");
  const commits = git("log", "--format=%H%x09%s", `${baseline.upstreamCommit}..${ref}`).split("\n").filter(Boolean);
  const candidates = commits.flatMap((line) => {
    const tab = line.indexOf("\t");
    const sha = line.slice(0, tab), subject = line.slice(tab + 1);
    const paths = git("diff-tree", "--no-commit-id", "--name-only", "-r", "-m", sha).split("\n");
    return needsSecurityReview(subject, paths) ? [{ sha, subject }] : [];
  });
  const report = `Upstream security review since ${baseline.reviewedAt} (${baseline.upstreamCommit.slice(0, 10)}): ${candidates.length} candidate change(s).\n\n` + candidates.map(({ sha, subject }) => `- [${sha.slice(0, 10)}](https://github.com/paperclipai/paperclip/commit/${sha}) ${subject.replace(/[\r\n]/g, " ")}`).join("\n") + "\n";
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  if (candidates.length) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
