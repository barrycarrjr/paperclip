/**
 * Turns an agent's `forbiddenWritePaths` globs into Claude Code permission
 * deny rules, so the spawned CLI refuses to edit those files itself. The
 * server-side `assertWriteAllowed` helper cannot cover this adapter: the CLI
 * writes to disk directly, never through a Paperclip route.
 *
 * `Edit(...)` rules cover every built-in file-editing tool (Edit, Write,
 * MultiEdit, NotebookEdit) and hold even with --dangerously-skip-permissions.
 * They do not stop the agent writing through a shell command.
 *
 * Claude reads an unanchored pattern relative to the working directory. Each
 * one is also emitted a second time, anchored at the filesystem root, so a
 * matching file in an --add-dir folder or elsewhere on disk is denied too.
 * That is broader than the pattern alone, which is the safe side for a ban.
 */
export interface ClaudeForbiddenPathRules {
  denyRules: string[];
  /** Patterns left out because they cannot be written as a rule. */
  skipped: string[];
}

function isAnchored(pattern: string): boolean {
  return pattern.startsWith("/") || pattern.startsWith("~/");
}

function stripRelativePrefix(pattern: string): string {
  let rest = pattern;
  for (;;) {
    if (rest.startsWith("./")) rest = rest.slice(2);
    else if (rest.startsWith("**/")) rest = rest.slice(3);
    else return rest;
  }
}

export function buildClaudeForbiddenPathRules(patterns: unknown): ClaudeForbiddenPathRules {
  const denyRules: string[] = [];
  const skipped: string[] = [];
  if (!Array.isArray(patterns)) return { denyRules, skipped };

  const add = (rule: string) => {
    if (!denyRules.includes(rule)) denyRules.push(rule);
  };

  for (const raw of patterns) {
    if (typeof raw !== "string") continue;
    const pattern = raw.trim();
    if (!pattern) continue;
    // A parenthesis would end the rule early and change what it matches.
    if (pattern.includes("(") || pattern.includes(")")) {
      skipped.push(pattern);
      continue;
    }
    add(`Edit(${pattern})`);
    if (isAnchored(pattern)) continue;
    const rest = stripRelativePrefix(pattern);
    if (rest) add(`Edit(//**/${rest})`);
  }

  return { denyRules, skipped };
}

/** The value for `claude --settings`, or null when there is nothing to deny. */
export function buildClaudeForbiddenPathSettings(denyRules: string[]): string | null {
  if (denyRules.length === 0) return null;
  return JSON.stringify({ permissions: { deny: denyRules } });
}
