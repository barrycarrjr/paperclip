/**
 * Run one operation over many items without melting the thing on the other
 * end, and report honestly on what happened.
 *
 * Nothing in this app batches: every triage action is one HTTP call for one
 * conversation, and Help Scout allows 200 requests a minute per account with
 * no retry on the far side. Clearing a screenful of noise is therefore a
 * fan-out from the browser, and the two ways to get it wrong are to fire all
 * fifty at once, or to let the first failure look like total failure.
 *
 * So: a fixed number in flight, every item's outcome recorded, and one
 * special case - when the far end says we are going too fast, stop starting
 * new work rather than turning one rate-limit error into forty.
 */

export interface BulkFailure<T> {
  item: T;
  error: unknown;
}

export interface BulkRunResult<T> {
  succeeded: T[];
  failed: BulkFailure<T>[];
  /** Items never attempted, because the run stopped early. */
  skipped: T[];
  /** True when the far end asked us to slow down and we stopped. */
  stoppedForRateLimit: boolean;
}

export interface BulkRunOptions<T> {
  /** How many items may be in flight at once. */
  concurrency?: number;
  /** Called as each item settles, for progress. */
  onSettled?: (item: T, error: unknown | null) => void;
  /** Stop starting new work. Items in flight are still awaited. */
  signal?: AbortSignal;
}

/**
 * Three requests per item is the worst case here (tag is a read then a write,
 * and auto-noise then closes), so three at a time keeps the burst well inside
 * a 200-per-minute budget that may be shared with a running agent.
 */
export const DEFAULT_BULK_CONCURRENCY = 3;

/**
 * The plugin surfaces a rate limit as a bracketed code inside the message,
 * and the HTTP status is 502 like every other worker failure, so the message
 * is the only thing that distinguishes it.
 */
export function isRateLimitError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return message.includes("EHELP_SCOUT_RATE_LIMIT") || message.includes("429");
}

export async function runBulk<T>(
  items: readonly T[],
  run: (item: T) => Promise<unknown>,
  options: BulkRunOptions<T> = {},
): Promise<BulkRunResult<T>> {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_BULK_CONCURRENCY));
  const succeeded: T[] = [];
  const failed: BulkFailure<T>[] = [];
  let stoppedForRateLimit = false;
  let nextIndex = 0;

  const shouldStop = () => stoppedForRateLimit || options.signal?.aborted === true;

  async function worker(): Promise<void> {
    for (;;) {
      if (shouldStop()) return;
      const index = nextIndex++;
      if (index >= items.length) return;
      const item = items[index]!;
      try {
        await run(item);
        succeeded.push(item);
        options.onSettled?.(item, null);
      } catch (error) {
        failed.push({ item, error });
        options.onSettled?.(item, error);
        // Pressing on would turn one "slow down" into one per remaining item,
        // and none of them would succeed either.
        if (isRateLimitError(error)) stoppedForRateLimit = true;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );

  const attempted = new Set<T>([...succeeded, ...failed.map((f) => f.item)]);
  const skipped = items.filter((item) => !attempted.has(item));

  return { succeeded, failed, skipped, stoppedForRateLimit };
}

/** One line an operator can read without opening anything. */
export function summarizeBulkRun<T>(
  result: BulkRunResult<T>,
  verb: string,
): { tone: "success" | "warning" | "error"; message: string } {
  const done = result.succeeded.length;
  const failedCount = result.failed.length;
  const skipped = result.skipped.length;

  if (failedCount === 0 && skipped === 0) {
    return { tone: "success", message: `${verb} ${done} ${done === 1 ? "conversation" : "conversations"}.` };
  }

  if (result.stoppedForRateLimit) {
    return {
      tone: "warning",
      message:
        `${verb} ${done}, then Help Scout asked us to slow down. `
        + `${failedCount + skipped} left untouched. Try again in a minute.`,
    };
  }

  if (done === 0) {
    // `verb` is past tense ("Closed"), so the sentence is built around it
    // rather than trying to conjugate it back.
    // Count the untouched ones too. Stopping a run early leaves most of the
    // selection in `skipped`, and reporting only the failures made the
    // sentence contradict the count still on screen beside it.
    return {
      tone: "error",
      message: `None of the ${failedCount + skipped} selected could be ${verb.toLowerCase()}.`,
    };
  }

  return {
    tone: "warning",
    message: `${verb} ${done}. ${failedCount} failed${skipped > 0 ? `, ${skipped} untouched` : ""}.`,
  };
}
