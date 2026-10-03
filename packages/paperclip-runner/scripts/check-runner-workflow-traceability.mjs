import { access, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = resolve(import.meta.dirname, "..");
const evals = await import(pathToFileURL(resolve(packageRoot, "dist/eval/index.js")).href);
const manifest = JSON.parse(await readFile(resolve(packageRoot, "spec/evals/stress-workflow-traceability.json"), "utf8"));
const summary = evals.validateStressTraceabilityManifest(manifest);
const unavailableAppTests = new Set();
for (const finding of manifest.findings) {
  for (const path of finding.regressionTests) {
    const absolute = resolve(packageRoot, path);
    try {
      await access(absolute);
    } catch (error) {
      // This package is standalone. Upstream's campaign also cites App-owned
      // integration tests; a fork can build the runner without that integration.
      // Missing package-owned evidence always fails. The optional App gate is
      // strict too, and must be used before claiming the upstream integration.
      if (!relative(packageRoot, absolute).startsWith("..") || process.argv.includes("--with-app") || error.code !== "ENOENT") throw error;
      unavailableAppTests.add(path);
    }
  }
}
if (summary.coveredWorkflows !== evals.RUNNER_WORKFLOW_IDS.length) {
  throw new Error(`stress traceability covers ${summary.coveredWorkflows}/${evals.RUNNER_WORKFLOW_IDS.length} workflows`);
}
process.stdout.write(`Runner stress manifest and package-owned regression references passed: ${summary.findings} findings, ${summary.coveredWorkflows} declared workflows, ${summary.exclusions} explicit exclusion.\n`);
if (unavailableAppTests.size) process.stdout.write(`App integration evidence is unavailable in this fork (${unavailableAppTests.size} test files); no App integration claim is made. Use --with-app to require it.\n`);
