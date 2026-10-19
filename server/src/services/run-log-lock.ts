import path from "node:path";

const pending = new Map<string, Promise<void>>();

/** Serialize one local log file with its append and finalize operations. Never acquire a database lock inside this callback. */
export async function withRunLogFileLock<T>(basePath: string, logRef: string, work: () => Promise<T>, timeoutMs?: number): Promise<T> {
  const key = path.resolve(basePath, logRef);
  const previous = pending.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  pending.set(key, next);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (timeoutMs === undefined) await previous;
    else await Promise.race([previous, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Run log lock deadline exceeded")), Math.max(0, timeoutMs));
    })]);
  } catch (error) {
    // A cancelled waiter must not let later writers overtake the current owner.
    void previous.then(() => {
      release();
      if (pending.get(key) === next) pending.delete(key);
    });
    throw error;
  } finally { if (timer) clearTimeout(timer); }
  try { return await work(); }
  finally {
    release();
    if (pending.get(key) === next) pending.delete(key);
  }
}
