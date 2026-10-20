import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  sanitizeInheritedPaperclipEnv,
  renderTemplate,
  renderPaperclipApprovedRules,
  renderPaperclipWakePrompt,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  redactEnvForLogs,
} from "@paperclipai/adapter-utils/server-utils";
import {
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import {
  DEFAULT_AIDER_LOCAL_MODEL,
  DEFAULT_AIDER_LOCAL_OLLAMA_BASE_URL,
} from "../index.js";
import { classifyAiderFailure, extractAiderSummary, parseAiderUsage } from "./parse.js";
import { ensureAiderInstalled, ensureOllamaModelPulled } from "./prepare.js";
import { appendSourceEvidenceInstructions } from "@paperclipai/adapter-utils/source-evidence";
import { runCountsPromptForWake } from "@paperclipai/adapter-utils/run-counts";
import { loadEphemeralProcedures, requireCompleteEphemeralProcedures, EphemeralProcedureError } from "@paperclipai/adapter-utils/ephemeral-skills";
import { procedureModuleDir, stageAiderProcedures } from "./skills.js";

interface AiderRuntime {
  command: string;
  cwd: string;
  args: string[];
  env: Record<string, string>;
  /** Merged env (process.env + adapter env, with PATH normalized) for prep helpers. */
  runtimeEnv: NodeJS.ProcessEnv;
  prompt: string;
  timeoutSec: number;
  graceSec: number;
  model: string;
  ollamaBaseUrl: string;
}

async function buildAiderRuntime(input: {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  authToken?: string;
  procedureReadPaths?: string[];
}): Promise<AiderRuntime> {
  const { agent, config, context } = input;
  const command = asString(config.command, "aider");
  const model = asString(config.model, DEFAULT_AIDER_LOCAL_MODEL);
  const ollamaBaseUrl = asString(config.ollamaBaseUrl, DEFAULT_AIDER_LOCAL_OLLAMA_BASE_URL);
  const editFormat = asString(config.editFormat, "").trim();
  const maxChatHistoryTokens = asNumber(config.maxChatHistoryTokens, 0);
  const autoCommits = asBoolean(config.autoCommits, false);
  const yesAlways = asBoolean(config.yesAlways, true);
  const restoreChatHistory = asBoolean(config.restoreChatHistory, true);
  // Resolve cwd in this priority order:
  //   1. Paperclip-supplied workspace (the per-run sandbox the runtime preps).
  //   2. User-configured `cwd` on the agent.
  //   3. A paperclip-managed per-agent fallback dir (~/.paperclip/agent-cwds/<agentId>/).
  //
  // The previous code defaulted to `process.cwd()` when neither workspace nor
  // explicit cwd was set — which on a developer machine is the paperclip
  // source tree itself, and Aider with --yes-always would happily edit
  // server source files. Never use process.cwd() as the fallback.
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "").trim();
  const configuredCwd = asString(config.cwd, "").trim();
  let cwd: string;
  if (workspaceCwd.length > 0) {
    cwd = path.resolve(workspaceCwd);
  } else if (configuredCwd.length > 0) {
    cwd = path.resolve(configuredCwd);
  } else {
    cwd = path.resolve(os.homedir(), ".paperclip", "agent-cwds", agent.id);
  }
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  // Belt-and-braces: even if cwd was configured, refuse to run inside the
  // paperclip server's own working directory. Aider with --yes-always treats
  // every file in cwd (and recursive descendants) as fair game for editing,
  // and a misconfigured agent should never be able to chew through server
  // source. If this triggers, the agent's adapterConfig.cwd is wrong.
  const serverCwd = path.resolve(process.cwd());
  const cwdRel = path.relative(serverCwd, cwd);
  const cwdIsServerTree =
    cwd === serverCwd || (!cwdRel.startsWith("..") && !path.isAbsolute(cwdRel));
  if (cwdIsServerTree) {
    throw new Error(
      `aider_local refused to run: resolved cwd "${cwd}" is inside the Paperclip server's working directory ` +
        `("${serverCwd}"). Aider with --yes-always could edit Paperclip's own source. ` +
        `Set adapter config "cwd" to an absolute path outside the server tree, or rely on a Paperclip-managed workspace.`,
    );
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  // Aider reads OLLAMA_API_BASE for ollama/* models. Set it before the user
  // env so explicit env-config values still win.
  env.OLLAMA_API_BASE = ollamaBaseUrl;
  env.PAPERCLIP_RUN_ID = input.runId;
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  if (input.authToken && !env.PAPERCLIP_API_KEY) {
    env.PAPERCLIP_API_KEY = input.authToken;
  }

  const args: string[] = [];
  args.push("--model", model);
  if (editFormat) args.push("--edit-format", editFormat);
  if (maxChatHistoryTokens > 0) args.push("--max-chat-history-tokens", String(maxChatHistoryTokens));
  if (yesAlways) args.push("--yes-always");
  args.push(autoCommits ? "--auto-commits" : "--no-auto-commits");
  if (restoreChatHistory) args.push("--restore-chat-history");
  args.push("--no-pretty"); // human-readable but no ANSI; cleaner stdout capture
  args.push("--no-stream"); // batch responses; easier to parse the trailer
  args.push("--no-show-model-warnings"); // silence Aider's third-party-model nags
  // Headless-friendly flags. By default Aider opens the user's browser on
  // first run to show release notes / an analytics-consent page. That's
  // catastrophic for a Paperclip heartbeat — the agent runs in the background
  // and any browser pop-up surprises the user. Disable every "phone home"
  // and "open browser" surface explicitly:
  args.push("--analytics-disable"); // do not send anonymous usage events
  args.push("--no-show-release-notes"); // do not display release notes (which used to open a browser)
  args.push("--no-check-update"); // do not contact PyPI for version checks
  args.push("--message-file", "-"); // read prompt from stdin
  for (const file of input.procedureReadPaths ?? []) args.push("--read", file);
  for (const extra of asStringArray(config.extraArgs)) {
    args.push(extra);
  }

  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const wake = context.paperclipWake ?? context;
  const approvedRules = renderPaperclipApprovedRules(context);
  const wakePrompt = renderPaperclipWakePrompt(wake);
  const templateRendersWake = /{{\s*paperclipWake\s*}}/.test(promptTemplate);
  const renderedPrompt = renderTemplate(promptTemplate, {
    paperclipWake: wakePrompt,
    agentName: agent.name,
    agentId: agent.id,
    companyId: agent.companyId,
    runId: input.runId,
  });
  // Custom templates may omit the wake token, but cannot omit required reporting.
  const countsInstructions = wakePrompt ? "" : runCountsPromptForWake(wake);
  // Aider's message-file mode has no system or rules role. Keep the bounded,
  // board-provenance block before all task text as the explicit fallback.
  const prompt = appendSourceEvidenceInstructions([
    approvedRules,
    templateRendersWake ? "" : wakePrompt,
    renderedPrompt,
    countsInstructions,
  ].filter(Boolean).join("\n\n"));

  const runtimeEnv = ensurePathInEnv({ ...sanitizeInheritedPaperclipEnv(process.env), ...env });
  // Resolution check is deferred to ensureAiderInstalled() so we can attempt
  // an auto-install when the binary is missing rather than failing the run
  // outright. The original ensureAdapterExecutionTargetCommandResolvable call
  // here would throw before any onLog stream existed, leaving the user with
  // just "Command not found in PATH" and no idea what to do next.

  return {
    command,
    cwd,
    args,
    env,
    runtimeEnv,
    prompt,
    timeoutSec: asNumber(config.timeoutSec, 0),
    graceSec: asNumber(config.graceSec, 20),
    model,
    ollamaBaseUrl,
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, context } = ctx;

  const procedures = await loadEphemeralProcedures(config, procedureModuleDir);
  requireCompleteEphemeralProcedures(procedures);
  if (procedures.procedures.length && ((ctx.executionTarget && ctx.executionTarget.kind !== "local") || (parseObject(context.paperclipEnvironment).driver && parseObject(context.paperclipEnvironment).driver !== "local"))) throw new EphemeralProcedureError("procedure_environment_unsupported", "Aider attached procedures support local execution only.");
  const staged = await stageAiderProcedures(procedures.procedures);
  try {
    return await executeWithProcedureReads(ctx, staged.paths);
  } finally { await staged.cleanup(); }
}

async function executeWithProcedureReads(ctx: AdapterExecutionContext, procedureReadPaths: string[]): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const runtime = await buildAiderRuntime({
    runId,
    agent,
    config,
    context,
    authToken,
    procedureReadPaths,
  });

  await onMeta?.({
    adapterType: "aider_local",
    command: runtime.command,
    cwd: runtime.cwd,
    commandArgs: runtime.args,
    env: redactEnvForLogs(runtime.env),
    prompt: runtime.prompt,
  });

  // Auto-prep: install aider if missing, pull the configured Ollama model if
  // missing. Both stream progress to onLog so the run UI shows what's happening
  // ("Installing Aider…", "Pulling llama3.1:8b 47%…") rather than a cryptic
  // "command not found" failure that the user has no obvious way to fix.
  await ensureAiderInstalled({
    command: runtime.command,
    cwd: runtime.cwd,
    env: runtime.runtimeEnv,
    onLog,
  });
  // ensureAiderInstalled may have prepended a managed-venv bin dir to
  // runtimeEnv.PATH (when it had to install aider into ~/.paperclip/aider-venv/
  // because pipx and pip --user weren't viable). Propagate that PATH to the
  // spawn env so `aider` resolves to the venv's binary at spawn time.
  if (runtime.runtimeEnv.PATH) {
    runtime.env.PATH = runtime.runtimeEnv.PATH;
  }
  await ensureOllamaModelPulled({
    aiderModel: runtime.model,
    ollamaBaseUrl: runtime.ollamaBaseUrl,
    onLog,
  });

  const proc = await runAdapterExecutionTargetProcess(runId, null, runtime.command, runtime.args, {
    cwd: runtime.cwd,
    env: runtime.env,
    timeoutSec: runtime.timeoutSec,
    graceSec: runtime.graceSec,
    stdin: runtime.prompt,
    onLog,
    onSpawn,
  });

  const usage = parseAiderUsage(proc.stdout);
  const failure = classifyAiderFailure({
    exitCode: proc.exitCode,
    stdout: proc.stdout,
    stderr: proc.stderr,
  });
  const summary = extractAiderSummary(proc.stdout);

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: proc.timedOut,
    errorMessage: failure?.errorMessage ?? null,
    errorCode: failure?.errorCode ?? null,
    usage:
      usage.inputTokens != null || usage.outputTokens != null
        ? {
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
          }
        : undefined,
    provider: "ollama",
    biller: "local",
    model: runtime.model,
    billingType: "subscription",
    costUsd: usage.messageCostUsd ?? 0,
    summary: summary || null,
    resultJson: {
      ollamaBaseUrl: runtime.ollamaBaseUrl,
      sessionCostUsd: usage.sessionCostUsd ?? null,
    },
  };
}
