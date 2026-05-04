import picomatch from "picomatch";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";

/**
 * Layer 3 of the Steward self-modification ban: server-side defense in depth.
 * Called from any code path that creates a write on behalf of an agent (PR
 * creation, file mutation, etc.). Throws `[EFORBIDDEN_WRITE_PATH]` if any
 * candidate path matches a glob in the agent's `forbiddenWritePaths` list.
 *
 * Phase 1 is propose-only — Steward never reaches a write path — but the
 * helper ships now so Phase 2's github-tools PR creation already has the
 * backstop in place.
 */
export interface ForbiddenPathMatch {
  path: string;
  pattern: string;
}

export class ForbiddenWritePathError extends Error {
  matches: ForbiddenPathMatch[];
  constructor(matches: ForbiddenPathMatch[]) {
    const summary = matches
      .map((m) => `${m.path} matches ${m.pattern}`)
      .join("; ");
    super(`[EFORBIDDEN_WRITE_PATH] ${summary}`);
    this.name = "ForbiddenWritePathError";
    this.matches = matches;
  }
}

export async function assertWriteAllowed(
  db: Db,
  agentId: string,
  candidatePaths: string[],
): Promise<void> {
  if (candidatePaths.length === 0) return;

  const row = await db
    .select({ forbidden: agents.forbiddenWritePaths })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0] ?? null);

  if (!row) {
    throw new Error(`[EFORBIDDEN_WRITE_PATH] agent ${agentId} not found`);
  }

  const patterns = Array.isArray(row.forbidden) ? row.forbidden : [];
  if (patterns.length === 0) return;

  const matchers = patterns.map((pattern) => ({
    pattern,
    matcher: picomatch(pattern, { dot: true }),
  }));

  const matches: ForbiddenPathMatch[] = [];
  for (const path of candidatePaths) {
    for (const { pattern, matcher } of matchers) {
      if (matcher(path)) {
        matches.push({ path, pattern });
        break;
      }
    }
  }

  if (matches.length > 0) {
    throw new ForbiddenWritePathError(matches);
  }
}
