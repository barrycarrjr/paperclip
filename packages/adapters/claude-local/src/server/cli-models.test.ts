import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claudeCliRowsToModels,
  deriveClaudeModelLabel,
  parseClaudeCliModelRows,
  readClaudeCliModels,
} from "./cli-models.js";

// The initialize reply's `models` from Claude Code 2.1.281 on a Max account.
const ROWS = [
  {
    value: "default",
    resolvedModel: "claude-opus-5-5[1m]",
    displayName: "Default (recommended)",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsFastMode: true,
  },
  { value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]", displayName: "Opus (1M context)" },
  { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1", displayName: "Fable" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet" },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku" },
];

describe("parseClaudeCliModelRows", () => {
  it("keeps well-formed rows and skips junk", () => {
    const rows = parseClaudeCliModelRows([...ROWS, null, "x", { displayName: "no value" }, { value: "  " }]);
    expect(rows.map((r) => r.value)).toEqual(["default", "opus[1m]", "claude-fable-5-1[1m]", "sonnet", "haiku"]);
    expect(rows[0].supportedEffortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(parseClaudeCliModelRows(undefined)).toEqual([]);
  });
});

describe("claudeCliRowsToModels", () => {
  const models = claudeCliRowsToModels(parseClaudeCliModelRows(ROWS));

  it("gives one entry per concrete model, in the CLI's order", () => {
    expect(models.map((m) => m.id)).toEqual(["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5", "claude-haiku-4-5"]);
  });

  it("marks the model the default row resolves to", () => {
    expect(models.filter((m) => m.isDefault).map((m) => m.id)).toEqual(["claude-opus-5-5"]);
  });

  it("keeps the CLI's aliases, context suffixes and dated ids so a saved alias still matches", () => {
    expect(models[0].aliases).toEqual(expect.arrayContaining(["opus", "opus[1m]", "claude-opus-5-5[1m]"]));
    expect(models[0].aliases).not.toContain("default");
    expect(models[3].aliases).toEqual(expect.arrayContaining(["haiku", "claude-haiku-4-5-20251001"]));
  });

  it("labels models from their ids and carries effort levels", () => {
    expect(models.map((m) => m.label)).toEqual(["Claude Opus 5.5", "Claude Fable 5.1", "Claude Sonnet 5", "Claude Haiku 4.5"]);
    expect(models[0].effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("ignores a default row that resolves to nothing", () => {
    expect(claudeCliRowsToModels([{ value: "default" }])).toEqual([]);
  });
});

describe("deriveClaudeModelLabel", () => {
  it("reads current id shapes and leaves others as they are", () => {
    expect(deriveClaudeModelLabel("claude-mythos-5-1")).toBe("Claude Mythos 5.1");
    expect(deriveClaudeModelLabel("claude-sonnet-5[1m]")).toBe("Claude Sonnet 5");
    expect(deriveClaudeModelLabel("claude-3-7-sonnet-20250219")).toBe("claude-3-7-sonnet-20250219");
  });
});

/**
 * A stand-in for the `claude` binary that speaks just enough of the
 * stream-json control protocol. FAKE_MODE picks its behaviour.
 */
const FAKE_CLI = `
const mode = process.env.FAKE_MODE;
if (mode === "fail") {
  process.stderr.write("Invalid API key \\u00b7 Please run /login\\n");
  process.exit(1);
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    const message = JSON.parse(line);
    if (mode === "silent") continue;
    process.stdout.write(JSON.stringify({ type: "system", subtype: "noise" }) + "\\n");
    process.stdout.write("not json at all\\n");
    process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "someone-else", response: {} } }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: {
          models: ${JSON.stringify(ROWS)},
          account: { email: "user@example.com", subscriptionType: "Claude Max", apiProvider: process.argv.slice(2).join(" ") },
        },
      },
    }) + "\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
setInterval(() => {}, 1000);
`;

describe("readClaudeCliModels against a stand-in CLI", () => {
  let dir: string;
  let command: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fake-claude-"));
    await fs.writeFile(path.join(dir, "fake-claude.mjs"), FAKE_CLI, "utf8");
    if (process.platform === "win32") {
      command = path.join(dir, "fake-claude.cmd");
      await fs.writeFile(command, `@"${process.execPath}" "%~dp0fake-claude.mjs" %*\r\n`, "utf8");
    } else {
      command = path.join(dir, "fake-claude");
      await fs.writeFile(command, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-claude.mjs" "$@"\n`, "utf8");
      await fs.chmod(command, 0o755);
    }
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reads the model rows and account from the handshake, sending no prompt", async () => {
    const listing = await readClaudeCliModels({ command, env: { FAKE_MODE: "ok" } });
    expect(listing.rows.map((r) => r.value)).toEqual(["default", "opus[1m]", "claude-fable-5-1[1m]", "sonnet", "haiku"]);
    expect(listing.account?.email).toBe("user@example.com");
    // The stand-in echoes its arguments: print mode, stream-json both ways, no MCP servers.
    expect(listing.account?.apiProvider).toBe(
      "-p --input-format stream-json --output-format stream-json --verbose --strict-mcp-config",
    );
  });

  it("rejects with the CLI's own words when it exits without answering", async () => {
    await expect(readClaudeCliModels({ command, env: { FAKE_MODE: "fail" } })).rejects.toThrow(/Please run \/login/);
  });

  it("gives up after the timeout when the CLI never answers", async () => {
    await expect(readClaudeCliModels({ command, env: { FAKE_MODE: "silent" }, timeoutMs: 1_500 })).rejects.toThrow(
      /did not report its models within 2s/,
    );
  });

  it("rejects when the CLI is not installed", async () => {
    await expect(readClaudeCliModels({ command: path.join(dir, "no-such-claude") })).rejects.toThrow();
  });
});
