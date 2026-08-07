/**
 * Vitest global teardown: leave no postgres behind.
 *
 * Nearly every database-backed test file starts its own embedded PostgreSQL
 * cluster, and the per-file cleanup handles the ordinary case. What it cannot
 * handle is a file that never reaches its cleanup - a hook that times out, a
 * worker vitest kills, a run someone cancels. Those clusters are simply
 * abandoned, and on Windows the workers keep running: 28 of them had piled up
 * on the machine this was written for, holding temp directories open and making
 * the next run fail before it started.
 *
 * So the end of the run sweeps whatever is left. Only orphans are in scope -
 * anything whose parent process is still alive belongs to somebody, including
 * the operator's own paperclip instance running on the same machine.
 */
import {
  orphanedEmbeddedPostgres,
  systemProcessTools,
} from "./embedded-postgres-processes.js";

export async function teardown(): Promise<void> {
  let leftovers: number[];
  try {
    leftovers = orphanedEmbeddedPostgres(await systemProcessTools.list(), systemProcessTools.isAlive);
  } catch {
    return;
  }
  if (leftovers.length === 0) return;

  console.log(
    `[vitest] ending ${leftovers.length} embedded PostgreSQL process(es) abandoned by this run`,
  );
  for (const pid of leftovers) {
    await systemProcessTools.kill(pid);
  }
}
