import { spawn } from "node:child_process";
import os from "node:os";
import {
  buildSpawnChildEnv,
  killWindowsProcessTree,
  resolveLocalSpawnCommand,
} from "@paperclipai/adapter-utils/server-utils";

/**
 * Asks the installed Claude Code CLI which models it offers the signed-in
 * account, the same list its own model picker shows.
 *
 * The CLI answers this in its stream-json `initialize` handshake: no prompt is
 * sent, so nothing is billed, and it takes about a second. The answer tracks
 * the account and the CLI version, so a new model appears here as soon as the
 * installed CLI knows about it, with no Paperclip change. It only lists the
 * current models (an alias per family plus the default); older models that
 * still run are not in it.
 *
 * @module claude-local/server/cli-models
 */

/** One row of the CLI's own model picker, as the initialize reply gives it. */
export interface ClaudeCliModelRow {
  /** What the CLI accepts for `--model`: an alias (`sonnet`, `opus[1m]`), an id, or `default`. */
  value: string;
  /** The concrete model the value resolves to right now, e.g. `claude-opus-5-5[1m]`. */
  resolvedModel?: string;
  displayName?: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsFastMode?: boolean;
}

export interface ClaudeCliAccount {
  email?: string;
  subscriptionType?: string;
  apiProvider?: string;
}

export interface ClaudeCliModelListing {
  rows: ClaudeCliModelRow[];
  account: ClaudeCliAccount | null;
}

/** A CLI row turned into a model entry: one per concrete model. */
export interface ClaudeCliModel {
  id: string;
  label: string;
  isDefault: boolean;
  aliases: string[];
  effortLevels?: string[];
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** How long to let the CLI exit on its own after stdin closes before killing it. */
const EXIT_GRACE_MS = 3_000;

const CLI_ARGS = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  // No MCP servers: the handshake needs none, and starting a project's servers
  // just to read a model list would be slow and could have side effects.
  "--strict-mcp-config",
];

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
  return out.length > 0 ? out : undefined;
}

/** Parse the `models` array of an initialize reply, skipping anything malformed. */
export function parseClaudeCliModelRows(value: unknown): ClaudeCliModelRow[] {
  if (!Array.isArray(value)) return [];
  const rows: ClaudeCliModelRow[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const rowValue = readString(record.value);
    if (!rowValue) continue;
    rows.push({
      value: rowValue,
      resolvedModel: readString(record.resolvedModel),
      displayName: readString(record.displayName),
      description: readString(record.description),
      supportsEffort: typeof record.supportsEffort === "boolean" ? record.supportsEffort : undefined,
      supportedEffortLevels: readStringArray(record.supportedEffortLevels),
      supportsFastMode: typeof record.supportsFastMode === "boolean" ? record.supportsFastMode : undefined,
    });
  }
  return rows;
}

function stripContextSuffix(id: string): string {
  return id.replace(/\[[^\]]*\]$/, "");
}

const SNAPSHOT_DATE_RE = /-(?:20\d{2})(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/;

/**
 * "Claude Opus 5.5" from `claude-opus-5-5`, "Claude Haiku 4.5" from
 * `claude-haiku-4-5`. Falls back to the id for shapes it cannot read, such as
 * the old `claude-3-7-sonnet-20250219` naming.
 */
export function deriveClaudeModelLabel(id: string): string {
  const match = /^claude-([a-z]+)-(\d+(?:-\d+)?)$/.exec(stripContextSuffix(id).replace(SNAPSHOT_DATE_RE, ""));
  if (!match) return id;
  const family = match[1].charAt(0).toUpperCase() + match[1].slice(1);
  return `Claude ${family} ${match[2].replace("-", ".")}`;
}

/**
 * One entry per concrete model the CLI offers. The `default` row only marks
 * which model is the default; aliases such as `opus` and dated snapshot ids are
 * kept on the entry so a saved alias still matches the model it means.
 */
export function claudeCliRowsToModels(rows: ClaudeCliModelRow[]): ClaudeCliModel[] {
  const byId = new Map<string, ClaudeCliModel>();
  const order: string[] = [];
  for (const row of rows) {
    const resolved = row.resolvedModel ?? (row.value === "default" ? undefined : row.value);
    if (!resolved) continue;
    const bare = stripContextSuffix(resolved);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(bare)) continue;
    const id = bare.replace(SNAPSHOT_DATE_RE, "");
    let entry = byId.get(id);
    if (!entry) {
      entry = { id, label: deriveClaudeModelLabel(id), isDefault: false, aliases: [] };
      byId.set(id, entry);
      order.push(id);
    }
    if (row.value === "default") entry.isDefault = true;
    for (const alias of [row.value, stripContextSuffix(row.value), resolved, bare]) {
      if (alias === "default" || alias === id || entry.aliases.includes(alias)) continue;
      entry.aliases.push(alias);
    }
    if (!entry.effortLevels && row.supportedEffortLevels) entry.effortLevels = row.supportedEffortLevels;
  }
  return order.map((id) => byId.get(id)!);
}

/**
 * Run the CLI's initialize handshake and return its model rows. Rejects when
 * the CLI is missing, not signed in, or does not answer in time, so callers
 * can fall back to another source.
 */
export async function readClaudeCliModels(opts: {
  command?: string;
  /** Extra environment for the child, e.g. the account's CLAUDE_CODE_OAUTH_TOKEN. */
  env?: Record<string, string>;
  timeoutMs?: number;
} = {}): Promise<ClaudeCliModelListing> {
  const env = buildSpawnChildEnv(process.env, opts.env);
  // A neutral folder, so no project's settings, hooks or instructions load.
  const cwd = os.tmpdir();
  const target = await resolveLocalSpawnCommand(opts.command?.trim() || "claude", CLI_ARGS, env, cwd);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestId = `paperclip-models-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  return new Promise<ClaudeCliModelListing>((resolve, reject) => {
    const child = spawn(target.command, target.args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    let stdoutBuffer = "";
    let stderr = "";

    const stop = () => {
      try {
        child.stdin.end();
      } catch {
        // Already closed.
      }
      const killTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        if (process.platform === "win32" && child.pid) killWindowsProcessTree(child.pid, true);
        else child.kill("SIGTERM");
      }, EXIT_GRACE_MS);
      killTimer.unref?.();
    };

    const finish = (error: Error | null, listing?: ClaudeCliModelListing) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stop();
      if (error) reject(error);
      else resolve(listing!);
    };

    const timeout = setTimeout(() => {
      finish(new Error(`Claude Code did not report its models within ${Math.round(timeoutMs / 1000)}s`));
      if (process.platform === "win32" && child.pid) killWindowsProcessTree(child.pid, true);
      else child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4_000) stderr += chunk;
    });
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newline: number;
      while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line.startsWith("{")) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (message.type !== "control_response") continue;
        const response = (message.response ?? {}) as Record<string, unknown>;
        if (response.request_id !== requestId) continue;
        if (response.subtype !== "success") {
          finish(new Error(`Claude Code refused the model list request: ${readString(response.error) ?? "unknown error"}`));
          return;
        }
        const body = (response.response ?? {}) as Record<string, unknown>;
        const account =
          typeof body.account === "object" && body.account !== null
            ? {
                email: readString((body.account as Record<string, unknown>).email),
                subscriptionType: readString((body.account as Record<string, unknown>).subscriptionType),
                apiProvider: readString((body.account as Record<string, unknown>).apiProvider),
              }
            : null;
        finish(null, { rows: parseClaudeCliModelRows(body.models), account });
        return;
      }
    });
    child.on("error", (err) => finish(err));
    child.on("exit", (code) => {
      finish(
        new Error(
          `Claude Code exited (code ${code ?? "none"}) before reporting its models${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ""}`,
        ),
      );
    });

    child.stdin.write(
      `${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } })}\n`,
    );
  });
}
