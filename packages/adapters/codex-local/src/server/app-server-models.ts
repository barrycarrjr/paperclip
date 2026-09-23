import { spawn } from "node:child_process";
import os from "node:os";
import {
  buildSpawnChildEnv,
  killWindowsProcessTree,
  resolveLocalSpawnCommand,
} from "@paperclipai/adapter-utils/server-utils";

/**
 * Asks the installed Codex CLI which models the signed-in account can use,
 * through `codex app-server`'s `model/list` method.
 *
 * This is the list the Codex CLI itself works from, for ChatGPT sign-ins and
 * API keys alike, and it costs nothing to ask. It also carries what no other
 * source gives: the provider's default, models it hides from pickers, and for
 * a retiring model the date it stops working and the model to move to.
 *
 * @module codex-local/server/app-server-models
 */

export interface CodexAppServerModel {
  id: string;
  displayName?: string;
  description?: string;
  /** Codex keeps these out of its own picker; they still run. */
  hidden: boolean;
  isDefault: boolean;
  effortLevels?: string[];
  supportsImages?: boolean;
  /** The model Codex says to move to, for a retiring model. */
  upgradeTo?: string;
  /** When Codex stops serving the model (ISO timestamp). */
  retiresAt?: string;
  /** Codex's own retirement notice, e.g. "GPT-5.5 retires on October 14, 2026. ..." */
  notice?: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_PAGES = 10;

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Parse one page of `model/list` results, skipping anything malformed. */
export function parseCodexAppServerModels(value: unknown): CodexAppServerModel[] {
  if (!Array.isArray(value)) return [];
  const out: CodexAppServerModel[] = [];
  for (const item of value) {
    const record = readRecord(item);
    if (!record) continue;
    const id = readString(record.model) ?? readString(record.id);
    if (!id) continue;
    const efforts = Array.isArray(record.supportedReasoningEfforts)
      ? record.supportedReasoningEfforts
          .map((entry) => readString(readRecord(entry)?.reasoningEffort))
          .filter((effort): effort is string => Boolean(effort))
      : [];
    const modalities = Array.isArray(record.inputModalities)
      ? record.inputModalities.filter((m): m is string => typeof m === "string")
      : null;
    const upgradeInfo = readRecord(record.upgradeInfo);
    const retirementAt = typeof upgradeInfo?.retirementAt === "number" ? upgradeInfo.retirementAt : null;
    out.push({
      id,
      displayName: readString(record.displayName),
      description: readString(record.description),
      hidden: record.hidden === true,
      isDefault: record.isDefault === true,
      effortLevels: efforts.length > 0 ? efforts : undefined,
      supportsImages: modalities ? modalities.includes("image") : undefined,
      upgradeTo: readString(upgradeInfo?.model) ?? readString(record.upgrade),
      // Codex sends epoch seconds.
      retiresAt: retirementAt !== null ? new Date(retirementAt * 1000).toISOString() : undefined,
      notice: readString(upgradeInfo?.migrationMarkdown),
    });
  }
  return out;
}

/**
 * Start `codex app-server`, page through `model/list`, and stop it. Rejects
 * when Codex is missing, not signed in, or does not answer in time, so the
 * caller can fall back to another source.
 */
export async function listCodexAppServerModels(opts: {
  command?: string;
  /** Extra environment for the child, e.g. a CODEX_HOME for a specific account. */
  env?: Record<string, string>;
  /** Include models Codex hides from its own picker. */
  includeHidden?: boolean;
  timeoutMs?: number;
} = {}): Promise<CodexAppServerModel[]> {
  const env = buildSpawnChildEnv(process.env, opts.env);
  const cwd = os.tmpdir();
  // No sandbox or approval flags: listing models runs nothing, and their
  // accepted values change between Codex releases (0.156 rejects
  // `-a untrusted`), which would break the listing for no benefit.
  const target = await resolveLocalSpawnCommand(opts.command?.trim() || "codex", ["app-server"], env, cwd);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<CodexAppServerModel[]>((resolve, reject) => {
    const child = spawn(target.command, target.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const collected: CodexAppServerModel[] = [];
    let nextId = 1;
    let listRequestId = -1;
    let pages = 0;
    let settled = false;
    let buffer = "";
    let stderr = "";

    const send = (message: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const requestPage = (cursor?: string) => {
      listRequestId = nextId++;
      pages += 1;
      send({
        id: listRequestId,
        method: "model/list",
        params: { includeHidden: opts.includeHidden === true, ...(cursor ? { cursor } : {}) },
      });
    };
    const kill = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === "win32" && child.pid) killWindowsProcessTree(child.pid, true);
      else child.kill("SIGTERM");
    };
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        child.stdin.end();
      } catch {
        // Already closed.
      }
      kill();
      if (error) reject(error);
      else resolve(collected);
    };
    const timeout = setTimeout(
      () => finish(new Error(`Codex did not report its models within ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs,
    );

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4_000) stderr += chunk;
    });
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("{")) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (message.id === 1) {
          if (message.error) {
            finish(new Error(`Codex refused to start: ${JSON.stringify(message.error).slice(0, 300)}`));
            return;
          }
          send({ method: "initialized", params: {} });
          requestPage();
          continue;
        }
        if (message.id !== listRequestId) continue;
        if (message.error) {
          finish(new Error(`Codex refused the model list request: ${JSON.stringify(message.error).slice(0, 300)}`));
          return;
        }
        const result = readRecord(message.result) ?? {};
        collected.push(...parseCodexAppServerModels(result.data));
        const cursor = readString(result.nextCursor);
        if (cursor && pages < MAX_PAGES) requestPage(cursor);
        else finish(null);
      }
    });
    child.on("error", (err) => finish(err));
    child.on("exit", (code) => {
      finish(
        new Error(
          `Codex exited (code ${code ?? "none"}) before reporting its models${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ""}`,
        ),
      );
    });

    nextId = 2;
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "paperclip", version: "0.0.0" } } });
  });
}
