import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { decodeInventory } from "../scripts/lib/capability-inventory.mjs";
import { validateRows } from "../scripts/generate-capability-contract.mjs";

const phaseDirectory = resolve(import.meta.dirname, "../generated/capability");

async function readRows(file) {
  return JSON.parse(await readFile(resolve(phaseDirectory, file), "utf8")).rows;
}

test("generated Capability inventory has full source coverage", async () => {
  const [capabilities, tools, evals] = await Promise.all([
    readRows("capabilities.yaml"),
    readRows("mcp-tool-map.yaml"),
    readRows("eval-traceability.yaml"),
  ]);

  const root = resolve(import.meta.dirname, "../../..");
  const contract = JSON.parse(await readFile(resolve(phaseDirectory, "../../spec/capability/source-contract.json"), "utf8"));
  const skillContents = await Promise.all(contract.skillSources.map(path => readFile(resolve(root, path), "utf8")));
  const sourceHeadingCount = skillContents.reduce((total, text) => total + text.split(/\r?\n/).filter(line => /^(#{1,6})\s+(.+?)\s*#*$/.test(line)).length, 0);
  assert.equal(capabilities.length, sourceHeadingCount);
  assert.deepEqual(tools.map(tool => tool.name).sort(), Object.keys(contract.toolMappings).sort());
  assert.equal(evals.length, 106);
  assert.equal(new Set(evals.map((row) => row.group)).size, 16);
  for (const row of [...capabilities, ...tools, ...evals]) {
    assert.match(row.sourceAnchor, /\S/);
    assert.match(row.semanticOperation, /\S/);
    assert.match(row.expectedMockState, /\S/);
  }
});

test("direct CLI invocation executes contract validation on paths containing spaces", async () => {
  const tempRoot = await mkdtemp(resolve(tmpdir(), "paperclip contract-cli-"));
  try {
    const packageRoot = resolve(tempRoot, "packages/paperclip-runner");
    const scriptPath = resolve(packageRoot, "scripts/generate-capability-contract.mjs");
    await mkdir(dirname(scriptPath), { recursive: true });
    await mkdir(resolve(packageRoot, "spec/capability"), { recursive: true });
    await mkdir(resolve(tempRoot, "packages/mcp-server/src"), { recursive: true });
    await copyFile(resolve(import.meta.dirname, "../scripts/generate-capability-contract.mjs"), scriptPath);
    await writeFile(resolve(packageRoot, "spec/capability/source-contract.json"), JSON.stringify({ skillSources: [], toolMappings: {}, evalGroups: {}, evalCases: {} }));
    await writeFile(resolve(tempRoot, "packages/mcp-server/src/tools.ts"), "");
    const result = spawnSync(process.execPath, [scriptPath, "--check"], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Expected 106 eval cases/);
  } finally {
    assert.equal(dirname(resolve(tempRoot)), resolve(tmpdir()));
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("contract validation rejects missing, duplicate, and unclassified entries", () => {
  const row = {
    id: "example:1",
    sourceAnchor: "source.md#L1:example",
    primaryDisposition: "control_plane_owned",
  };

  assert.throws(() => validateRows([{ ...row, sourceAnchor: "" }], "fixture"), /source anchor/);
  assert.throws(() => validateRows([row, { ...row, id: "example:2" }], "fixture"), /duplicate source anchor/);
  assert.throws(() => validateRows([{ ...row, primaryDisposition: "unclassified" }], "fixture"), /valid primary disposition/);
});


test("conversational answer guidance has the same agent-operation classification in both inventories", async (context) => {
  const generated = (await readRows("capabilities.yaml")).filter(row => row.heading === "Conversational confirmation answers");
  const spec = decodeInventory(await readFile(resolve(import.meta.dirname, "../spec/capability/capabilities.yaml"), "utf8")).rows
    .filter(row => row.title === "Conversational confirmation answers");
  if (generated.length === 0 && spec.length === 0) {
    context.skip("The fork's skill sources do not contain this upstream guidance section");
    return;
  }
  assert.ok(generated.length > 0);
  assert.equal(generated.length, spec.length);
  for (const row of [...generated, ...spec]) assert.equal(row.primaryDisposition, "always_agent_tool");
  for (const row of generated) assert.equal(row.semanticOperation, "call_api");
});
