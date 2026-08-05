import type { LiveRunForIssue } from "../api/heartbeats";
import { describeRunRetryState } from "./runRetryState";
import { formatDateTime } from "./utils";

/**
 * The one-line answer to "what is this agent doing right now?" for a run
 * card. The inputs (nextAction, livenessState, outputSilence, retry fields)
 * are all on the live-runs payload already; until now only the deep issue
 * ledger rendered any of them. Label vocabulary mirrors IssueRunLedger.
 */
export interface RunNowLine {
  text: string;
  tone: "live" | "ok" | "warn" | "err" | "muted";
  /** Longer explanation for a title/tooltip, when one exists. */
  title?: string;
}

const FINISHED_LIVENESS_LINES: Record<
  string,
  { text: string; tone: RunNowLine["tone"]; title: string }
> = {
  completed: {
    text: "Finished the issue",
    tone: "ok",
    title: "The issue reached a terminal state.",
  },
  advanced: {
    text: "Made real progress",
    tone: "ok",
    title: "The run produced concrete evidence of progress.",
  },
  plan_only: {
    text: "Only planned, took no action",
    tone: "warn",
    title: "The run described future work without concrete action evidence.",
  },
  empty_response: {
    text: "Finished without useful output",
    tone: "warn",
    title: "The run finished without useful output.",
  },
  blocked: {
    text: "Blocked",
    tone: "warn",
    title: "The run or issue declared a blocker.",
  },
  failed: {
    text: "Failed",
    tone: "err",
    title: "The run ended unsuccessfully.",
  },
  needs_followup: {
    text: "Needs follow-up",
    tone: "warn",
    title: "The run produced useful output but did not prove concrete progress.",
  },
};

function quietDuration(sinceIso: string | Date | null | undefined, now: number): string | null {
  if (!sinceIso) return null;
  const since = new Date(sinceIso).getTime();
  if (!Number.isFinite(since)) return null;
  const minutes = Math.max(1, Math.round((now - since) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
}

export function runNowLine(
  run: Pick<
    LiveRunForIssue,
    | "status"
    | "livenessState"
    | "livenessReason"
    | "outputSilence"
    | "retryOfRunId"
    | "scheduledRetryAt"
    | "scheduledRetryAttempt"
    | "scheduledRetryReason"
  >,
  now = Date.now(),
): RunNowLine | null {
  // Self-healing runs say so, with the retry time: previously they were
  // indistinguishable from silence.
  if (run.status === "scheduled_retry") {
    const retry = describeRunRetryState(run);
    const when = run.scheduledRetryAt ? formatDateTime(run.scheduledRetryAt) : null;
    return {
      text: when ? `Will retry ${when}` : "Will retry on its own",
      tone: "warn",
      title: retry?.detail ?? undefined,
    };
  }

  if (run.status === "running") {
    const silence = run.outputSilence;
    if (silence && (silence.level === "suspicious" || silence.level === "critical")) {
      const quiet = quietDuration(silence.silenceStartedAt, now);
      return {
        text: quiet ? `Quiet for ${quiet}` : "Quiet for a while",
        tone: silence.level === "critical" ? "err" : "warn",
        title:
          silence.level === "critical"
            ? "No output for a long time. The run may be stuck."
            : "No output recently. Keeping an eye on it.",
      };
    }
    // Note: nextAction is only written when a run ENDS (it is the agent's
    // declared follow-up), so it must not be shown as a live "doing now"
    // line here.
    return null;
  }

  if (run.status === "queued") {
    return { text: "Waiting for a free slot", tone: "muted" };
  }

  // Finished runs: the liveness classification, in plain words.
  if (run.livenessState) {
    const line = FINISHED_LIVENESS_LINES[run.livenessState];
    if (line) {
      return { ...line, title: run.livenessReason ?? line.title };
    }
  }
  return null;
}

export const RUN_NOW_LINE_TONE_CLASSES: Record<RunNowLine["tone"], string> = {
  live: "text-cyan-700 dark:text-cyan-300",
  ok: "text-emerald-700 dark:text-emerald-300",
  warn: "text-amber-700 dark:text-amber-400",
  err: "text-red-700 dark:text-red-400",
  muted: "text-muted-foreground",
};
