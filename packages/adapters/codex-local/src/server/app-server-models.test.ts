import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listCodexAppServerModels, parseCodexAppServerModels } from "./app-server-models.js";

// Two entries from `codex app-server` model/list on Codex 0.156.1.
const ASTRA = {
  id: "gpt-6-astra",
  model: "gpt-6-astra",
  upgrade: null,
  upgradeInfo: null,
  displayName: "GPT-6-Astra",
  description: "Frontier intelligence for the most demanding work.",
  hidden: false,
  supportedReasoningEfforts: [
    { reasoningEffort: "low", description: "Fast" },
    { reasoningEffort: "ultra", description: "Most" },
  ],
  defaultReasoningEffort: "medium",
  inputModalities: ["text", "image"],
  isDefault: true,
};
const RETIRING = {
  id: "gpt-5.5",
  model: "gpt-5.5",
  upgrade: "gpt-5.6-sol",
  upgradeInfo: {
    model: "gpt-5.6-sol",
    upgradeCopy: null,
    modelLink: null,
    migrationMarkdown: "GPT-5.5 retires on October 14, 2026. Switch to GPT-5.6 Sol to continue working in Codex.",
    retirementAt: 1792004400,
  },
  displayName: "GPT-5.5",
  hidden: false,
  inputModalities: ["text"],
  isDefault: false,
};
const HIDDEN = { id: "gpt-reserve", model: "gpt-reserve", displayName: "gpt-reserve", hidden: true, isDefault: false };

describe("parseCodexAppServerModels", () => {
  it("reads ids, defaults, efforts and image support", () => {
    expect(parseCodexAppServerModels([ASTRA])).toEqual([
      {
        id: "gpt-6-astra",
        displayName: "GPT-6-Astra",
        description: "Frontier intelligence for the most demanding work.",
        hidden: false,
        isDefault: true,
        effortLevels: ["low", "ultra"],
        supportsImages: true,
        upgradeTo: undefined,
        retiresAt: undefined,
        notice: undefined,
      },
    ]);
  });

  it("turns Codex's retirement data into a date, a successor and its notice", () => {
    const [model] = parseCodexAppServerModels([RETIRING]);
    expect(model).toMatchObject({
      upgradeTo: "gpt-5.6-sol",
      retiresAt: new Date(1792004400 * 1000).toISOString(),
      notice: expect.stringContaining("retires on October 14, 2026"),
      supportsImages: false,
    });
  });

  it("skips malformed entries", () => {
    expect(parseCodexAppServerModels([null, 3, { displayName: "no id" }, HIDDEN]).map((m) => m.id)).toEqual(["gpt-reserve"]);
    expect(parseCodexAppServerModels("nope")).toEqual([]);
  });
});

/**
 * A stand-in for `codex app-server`: JSON-RPC over stdio, two pages of
 * models, hidden ones only when asked. FAKE_MODE picks its behaviour.
 */
const FAKE_CODEX = `
const mode = process.env.FAKE_MODE;
const pages = [[${JSON.stringify(ASTRA)}, ${JSON.stringify(HIDDEN)}], [${JSON.stringify(RETIRING)}]];
let buffer = "";
let initialized = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    const reply = (body) => process.stdout.write(JSON.stringify({ id: message.id, ...body }) + "\\n");
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ method: "remoteControl/status/changed", params: {} }) + "\\n");
      reply({ result: { userAgent: "fake", argv: process.argv.slice(2) } });
    } else if (message.method === "initialized") {
      initialized = true;
    } else if (message.method === "model/list") {
      if (mode === "refuse") { reply({ error: { code: -32600, message: "not signed in" } }); continue; }
      if (!initialized) { reply({ error: { message: "initialized notification missing" } }); continue; }
      const index = message.params.cursor ? Number(message.params.cursor) : 0;
      const data = pages[index].filter((m) => message.params.includeHidden || !m.hidden);
      reply({ result: { data, nextCursor: index + 1 < pages.length ? String(index + 1) : null } });
    }
  }
});
setInterval(() => {}, 1000);
`;

describe("listCodexAppServerModels against a stand-in Codex", () => {
  let dir: string;
  let command: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fake-codex-"));
    await fs.writeFile(path.join(dir, "fake-codex.mjs"), FAKE_CODEX, "utf8");
    if (process.platform === "win32") {
      command = path.join(dir, "fake-codex.cmd");
      await fs.writeFile(command, `@"${process.execPath}" "%~dp0fake-codex.mjs" %*\r\n`, "utf8");
    } else {
      command = path.join(dir, "fake-codex");
      await fs.writeFile(command, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-codex.mjs" "$@"\n`, "utf8");
      await fs.chmod(command, 0o755);
    }
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("pages through model/list and leaves hidden models out by default", async () => {
    const models = await listCodexAppServerModels({ command });
    expect(models.map((m) => m.id)).toEqual(["gpt-6-astra", "gpt-5.5"]);
  });

  it("includes hidden models when asked, for the daily check", async () => {
    const models = await listCodexAppServerModels({ command, includeHidden: true });
    expect(models.map((m) => [m.id, m.hidden])).toEqual([
      ["gpt-6-astra", false],
      ["gpt-reserve", true],
      ["gpt-5.5", false],
    ]);
  });

  it("rejects with Codex's error when it refuses the request", async () => {
    await expect(listCodexAppServerModels({ command, env: { FAKE_MODE: "refuse" } })).rejects.toThrow(/not signed in/);
  });

  it("rejects when Codex is not installed", async () => {
    await expect(listCodexAppServerModels({ command: path.join(dir, "no-such-codex") })).rejects.toThrow();
  });
});
