import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  buildInvocationEnvForLogs,
  ensurePathInEnv,
  resolveCommandForLogs,
  runChildProcess,
  stringifyPaperclipApprovedRulesPayload,
  stringifyPaperclipWakePayload,
} from "../utils.js";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, onLog, onMeta } = ctx;
  const command = asString(config.command, "");
  if (!command) throw new Error("Process adapter missing command");

  const wake = parseObject(ctx.context.paperclipWake);
  const reportingRetryReason = asString(wake.runCountsRetryReason, "");
  if (["missing_issue_comment", "missing_run_counts", "invalid_run_counts"].includes(reportingRetryReason)) {
    await onLog(
      "stderr",
      "Skipped the configured process command because this run may only correct its prior report.\n",
    );
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      resultJson: {
        reportingCorrectionSkipped: true,
        retryReason: reportingRetryReason,
      },
    };
  }

  const args = asStringArray(config.args);
  const cwd = asString(config.cwd, process.cwd());
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") env[k] = v;
  }
  // This adapter has no model prompt or native instruction role. Deliver
  // control-plane context as structured, server-owned environment values so a
  // custom runner can keep it separate from untrusted task input. Apply these
  // after user config so adapterConfig cannot replace trusted wake/rule data.
  delete env.PAPERCLIP_WAKE_PAYLOAD_JSON;
  delete env.PAPERCLIP_APPROVED_RULES_JSON;
  const wakePayloadJson = stringifyPaperclipWakePayload(ctx.context.paperclipWake);
  const approvedRulesJson = stringifyPaperclipApprovedRulesPayload(ctx.context);
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  if (approvedRulesJson) env.PAPERCLIP_APPROVED_RULES_JSON = approvedRulesJson;
  const inheritedRuntimeEnv = { ...process.env };
  delete inheritedRuntimeEnv.PAPERCLIP_WAKE_PAYLOAD_JSON;
  delete inheritedRuntimeEnv.PAPERCLIP_APPROVED_RULES_JSON;
  const runtimeEnv = ensurePathInEnv({ ...inheritedRuntimeEnv, ...env });
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 15);

  if (onMeta) {
    await onMeta({
      adapterType: "process",
      command: resolvedCommand,
      cwd,
      commandArgs: args,
      env: loggedEnv,
    });
  }

  const proc = await runChildProcess(runId, command, args, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onLog,
  });

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
    };
  }

  if ((proc.exitCode ?? 0) !== 0) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage: `Process exited with code ${proc.exitCode ?? -1}`,
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
      },
    };
  }

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    resultJson: {
      stdout: proc.stdout,
      stderr: proc.stderr,
    },
  };
}
