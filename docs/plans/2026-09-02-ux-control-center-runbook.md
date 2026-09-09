# UX control center — local runbook and rollback

Created: 2026-09-02. [Project entry point](2026-09-02-ux-control-center.md).

## Known checkout state

- Main checkout: `~/paperclip`.
- User's fork: `barrycarrjr/paperclip`.
- Local branch created for this work: `ux-control-center`.
- Baseline commit: `558f0096faa8fbb1caee01dede0de231568f7ee5`.
- Intended normal operating URL: `http://paperclip.local:3100`.
- No server restart, instance change, migration, install, build or application edit was performed during plan preparation.
- The running process's actual code/instance binding still needs verification in P0. A branch switch at the same commit is not proof that an already-running server changed its boot metadata or serves the intended checkout.

## P0 verification results (2026-09-02)

Confirmed live, read-only, before any change was made. See the handoff ledger for the dated entry; this section is the durable reference other agents should re-check before their own first action.

**Checkout / branch.** `git status --short` showed only the untracked `docs/plans/2026-09-02-ux-control-center*` planning files; zero modified tracked files. `ux-control-center` and `master` both point at `558f0096` (identical, no divergence yet). A stray unrelated worktree exists at `.claude/worktrees/bold-hugle-9fff22` (branch `claude/bold-hugle-9fff22`, clean, own unrelated feature) from a prior session — left untouched, does not affect this checkout.

**Running process.** Port 3100 is held by PID 3588 (parent 28300, grandparent 31036 `cmd`), started 2026-09-02 00:17:35, launched as `tsx ... src/index.ts run` from `cli/` — this is the `paperclipai run` CLI command (bootstrap + doctor + start), **not** `pnpm dev`/`dev:watch`. It does not file-watch server code; a server-side source change needs a real restart to take effect. `importServerEntry()` in `cli/src/commands/run.ts` sets `PAPERCLIP_UI_DEV_MIDDLEWARE=true` automatically when it resolves the dev entry (`server/src/index.ts`), so the UI is very likely served through Vite's dev middleware (live source, HMR) rather than a prebuilt `ui/dist` — not yet visually confirmed since no authenticated session was available (see below).

`pnpm dev:list`'s managed-runner registry is **stale**: it reports two `paperclip-dev-watch` entries (port 3100 pid=18832, port 3199 pid=51136), and every one of those four PIDs (18832/10468/51136/53656) is dead. Do not trust `dev:list` alone to decide whether a runner is live; cross-check with `Get-NetTCPConnection -LocalPort 3100` and the owning PID's actual command line.

**Instance / config.** Instance `default`, config at `~/.paperclip/instances/default/config.json` (updated 2026-08-07). `deploymentMode: authenticated`, `exposure: private`, `bind: lan`, `host: 0.0.0.0`, port 3100, `allowedHostnames` includes `paperclip.local`. `paperclip.local` resolves via real DNS to `192.168.27.50`, which matches this machine's LAN address that PID 3588 is bound to — the documented trial URL works as-is, no hosts-file trick needed. `bootstrapStatus: ready`, `bootstrapInviteActive: false` — this is Barry's already-onboarded real instance, not a fresh bootstrap.

**Database.** Embedded PostgreSQL, data dir `~/.paperclip/instances/default/db`, port 54329, live postmaster PID 52164 plus its worker/backend children. Storage provider `local_disk` at `~/.paperclip/instances/default/data/storage`. Secrets provider `local_encrypted`.

**Migration status — checked read-only, applied nothing.** Called the server's own `inspectMigrations()` (exported from `@paperclipai/db`) directly against the live embedded DB with no follow-up mutating call. Result: **`status: "upToDate"`**, 92 tables, all 95 migrations (`0000`…`0094`) applied. Zero pending migrations as of this check. Reusable read-only check (safe to rerun any time, touches nothing):

```powershell
pnpm --filter @paperclipai/server exec tsx <path-to-a-throwaway-.mjs-that-imports-inspectMigrations-from-'file:///~/paperclip/packages/db/src/index.ts'-and-prints-the-JSON-result>
```

**The actual restart risk, found by reading the code, not documentation:** both `pnpm dev` and `pnpm dev:once` run through `scripts/dev-runner.ts`, which sets `PAPERCLIP_MIGRATION_AUTO_APPLY ??= "true"` and `PAPERCLIP_MIGRATION_PROMPT ??= "never"` — so either command **silently applies any pending migration** on that restart, no confirmation possible, by design. Separately, even outside dev-runner, the server's own `promptApplyMigrations()` (`server/src/index.ts`) defaults to **auto-apply when stdin/stdout is not a TTY** — and no tool-driven shell here presents a real TTY, so *any* agent-initiated restart against a database with pending migrations would apply them by default unless `PAPERCLIP_MIGRATION_PROMPT=never` is explicitly set first (which makes it refuse to start instead, the safe failure mode). **Rule going forward: before any restart, always rerun the read-only `inspectMigrations` check above first. If it is not `upToDate`, do not restart via `pnpm dev`/`dev:once`/`run` without first setting `PAPERCLIP_MIGRATION_PROMPT=never` and getting Barry's explicit approval for the specific pending migration list.**

**Live UI verification is credential-gated.** Opening `http://paperclip.local:3100` in the agent's browser tool shows the Sign In form (Email/Password) — no persisted session. `/api/companies` returns `401` anonymously, confirming the auth boundary is enforced (expected in `authenticated` mode). No credentials were entered or guessed, per policy. Consequence: this agent cannot visually click through Barry's live authenticated pages for verification; P0/P1 route and behavior verification instead relied on reading source directly (see the reconciliation results folded into `2026-09-02-ux-control-center-preservation.md`). Browser-based acceptance testing (A01-A26) needs either Barry's own signed-in session or an explicitly-approved test account — flag this when a phase reaches that gate.

**Baseline automated tests.** `pnpm test` (the documented default) fails in this environment before any real test runs, on a Windows-specific bug: `scripts/run-vitest-stable.mjs` calls `spawnSync("pnpm", [...])` with no `shell:true`, and on this box Node's spawn resolution fails with `ENOENT` even though `pnpm.cmd` exists on PATH (reproduced in total isolation with a two-line Node script — this is not a Paperclip logic bug, it's Node's Windows executable resolution getting confused by the coexisting extension-less `pnpm` POSIX shim in the same npm global directory; likely to hit any Windows contributor with a similar global npm install, and it also crashes at least two test files that themselves shell out to a bare `"pnpm"` — `cli/src/__tests__/company-import-export-e2e.test.ts` confirmed). Worked around for baseline purposes with direct top-level `pnpm exec vitest run --project <name> [...]` calls per project instead (each invoked directly by the calling shell, not through Node's `spawnSync`, so it never hits the broken resolution path). Worth a short bug report to Barry independent of this project; not fixed here since it's test-infra, not UX-project scope.

Full baseline, captured 2026-09-02, zero application code changed at the time of capture:

| Project | Files | Tests | Result |
|---|---|---|---|
| `@paperclipai/shared` | 13 | 72 | all pass |
| `@paperclipai/db` | 5 | 54 | all pass (slow: ~106s, spins up real embedded-postgres instances) |
| `@paperclipai/adapter-utils` | 6 | 39 | 34 pass, 1 fail, 4 skipped |
| `@paperclipai/adapter-codex-local` | 6 | 21 | all pass |
| `@paperclipai/adapter-opencode-local` | 4 | 10 | all pass |
| `@paperclipai/ui` | 180 | 1205 | 1204 pass, 1 skipped, **0 failures** |
| `paperclipai` (cli) | 21 | 120 | 115 pass, 4 fail (one file), 1 skipped, plus 1 file crashes on the pnpm-shim bug above |
| `@paperclipai/server` | 256 | 1943 | 1670 pass, **2 fail** (reproduced identically across two separate runs), 271 skipped; **40 files additionally report as failed** but that is a false signal — see below |

Every failure traced to a specific, understood, pre-existing cause, none touching code this project has changed:

- `adapter-utils`: `src/sandbox-managed-runtime.test.ts > syncs workspace and assets through a provider-neutral sandbox client` — the test shells to `tar` with a Windows path (`C:\Users\...`), which a POSIX-style `tar`/`sh` reads as a `host:path` remote spec ("tar: Cannot connect to C: resolve failed"). Windows-path-vs-POSIX-tooling assumption baked into the test, not a logic bug.
- `paperclipai` (cli): all 4 `worktree.test.ts` failures are the same class — hardcoded POSIX expectations (`/tmp/paperclip-worktrees`, `/Users/example/...`, a `fs.statSync(...).mode & 0o111` POSIX-executable-bit check) that cannot pass against this platform's real (correct) Windows-shaped output. `company-import-export-e2e.test.ts` fails on the pnpm-shim `ENOENT` bug above (the test itself calls `spawn("pnpm", ["paperclipai", "run", ...])`).
- `@paperclipai/server`: the 40 file-level "failures" are **all** `beforeAll` hook timeouts (`Error: Hook timed out in 20000ms`) inside `startEmbeddedPostgresTestDatabase(...)` — confirmed by rerunning the full project twice, once forcing `--pool=forks --poolOptions.forks.isolate=true` and once with vitest's plain defaults; both produced the identical 40-file/2-test failure signature. Running all 256 server test files in one invocation apparently exceeds this box's spare capacity for concurrent embedded-Postgres spin-up within the default 20s hook budget (this machine was already carrying roughly 150 unrelated `node.exe` processes from other scheduled tasks at the time — see the process listing earlier in this doc). Not reproducible as a code defect; only ever showed up as a timeout, never a real assertion failure, and disappeared when projects were run individually earlier in this same session. Re-verify per-file or in smaller batches rather than trusting a single full-project run on this box.
- `@paperclipai/server` genuine (non-timeout) failures, reproduced identically both times: (1) `claude-local-execute.test.ts > classifies Claude 'out of extra usage' failures as transient upstream errors` expects `errorCode: "claude_transient_upstream"`, gets `"claude_plan_exhausted"` — an adapter error-classification test, unrelated to this project. (2) `chat-account-routing.test.ts > leaves an adapter with no accounts on its existing sign-in` expects `resolveActiveAccountEnv("claude_local")` to return `null` when the test's isolated DB has no configured account, but got a real, live account object back — **`resolveActiveAccountEnv` has an unmocked fallback path that reads this machine's actual local Claude Code credential** (`~/.claude`'s live OAuth token) instead of the test's isolated fixture state. This is a genuine test-isolation gap: on any machine with a real Claude Code login configured, running this test both fails it and writes a real credential into cleartext test output. Not caused by or in scope for this project; flagged separately (see below) rather than fixed here. The two scratchpad log files that captured the real token value during this investigation were deleted immediately after use — nothing sensitive was committed or persisted into this repo or its docs.

Net: the `@paperclipai/server` baseline anyone should trust going forward is **1670/1943 real assertions passing, exactly 2 known pre-existing failures, both unrelated to this project's code**. Do not re-run the full 256-file project as a single invocation to "double check" — re-derive per-project or per-file to avoid the timeout noise reproducing.

## Before continuing

```powershell
Set-Location '~/paperclip'
git status --short
git branch --show-current
git log -1 --oneline
pnpm dev:list
```

These Git checks are read-only. `dev:list` is the repository's documented managed-runner inspection command; it was not executed for this planning step. Compare the actual runner/source location with this checkout. Do not copy credentials/config bodies into documentation.

If another branch is checked out or there are overlapping changes, inspect and preserve them. Do not blindly switch, stash, reset, rebase or clean. Uncommitted/untracked plans are not safely stored in branch history; keep them intact and follow the commit approval process when asked.

## Before starting or restarting the app

1. Identify the exact listener/runner for port 3100 and whether it is dev-watch, dev-once, a built UI or a managed service. Do not assume a documented default describes Barry's running instance.
2. Verify effective config/instance and database/storage locations without exposing secrets. Repo docs mention both old PGlite defaults and current embedded PostgreSQL behavior; inspect the actual runtime instead of resetting a guessed directory.
3. Inspect pending migrations and startup behavior. `pnpm dev:once` is documented to auto-apply pending local migrations. A restart is therefore not automatically schema-neutral.
4. Check whether a restart would interrupt active agent work. Use the repository's managed/restart-safe path and coordinate meaningful downtime with Barry. Do not broadly kill all Node/Paperclip processes or pause unrelated agents.
5. Reuse the existing hostname, port, auth mode, allowed-hostname configuration and instance. Do not change public exposure or substitute a fresh empty database to make the UI appear healthy.
6. If schema work is required, explain impact, backup and rollback plan and obtain approval before live migration. UI-only phases should avoid it.

After those checks, documented commands are:

```powershell
pnpm dev
```

`pnpm dev` uses the managed watch runner; `pnpm dev:once` is the no-watch alternative. Both are documented as idempotent for a matching repo/instance and may return an existing process. That means issuing a start command alone does not prove a stale process was replaced.

`pnpm dev:stop` is the documented managed stop command; use only after confirming the intended runner and safe interruption. It is not a planning verification command. Preserve original launch arguments and environment when restarting.

Read-only health check, once the intended instance is confirmed:

```powershell
Invoke-RestMethod 'http://paperclip.local:3100/api/health'
```

Also verify the actual browser URL, company data, shell revision and a known source change. Health alone does not prove the UI is serving the branch. Respect authentication; do not bypass it.

## Windows and dependencies

- Existing package scripts require Node and pnpm; recheck versions and installed workspace links before installing anything.
- Do not modify the lockfile for this project without need. Current repo policy assigns `pnpm-lock.yaml` updates to CI; do not add lockfile churn to a future PR.
- Startup from NTFS can take 30–60 seconds. Use bounded status checks; do not repeatedly start duplicate runners.
- If Vite build hangs through `npx`, the documented workaround is direct Node execution of the installed Vite entry. Confirm the actual path and retain the TypeScript build step; a bundle-only run is not a full UI build.
- Do not clear caches or build directories as a routine first step. Any cleanup requires explicit, resolved, narrowly scoped paths; never delete the database or broad workspace directories.

## Reference mockups

The three HTML references are archived under `docs/plans/2026-09-02-ux-control-center-reference/`. They contain sample-only interaction logic and optional guarded host helpers. They can be inspected as ordinary HTML; missing host icons/design controls do not turn them into production code or require an AI provider.

To preview them with a local static server, if needed, use a separate free port and serve only the reference directory—not the live application or the entire home directory. Do not reuse port 3100 or add mockups to app routes. Stop the helper when finished.

## Rollback and recovery

The exact UI fallback mechanism is a P0/P1 decision. Before changing the shell, record how to select the prior shell or return to the verified code state without discarding work.

- Preserve working changes and branch history; no `reset --hard`, forced checkout, broad deletion, or automatic stash.
- Returning code to `master` is not a database rollback. Never assume an older binary understands newly migrated data.
- If a migration has occurred, follow its approved compatibility/backup/recovery plan. Do not restore over Barry's database just to fix a navigation regression.
- Do not run two servers against the same embedded data directory. An isolated test instance must not resume copied production agents/routines or reach real outbound providers.
- For a failed UI slice, use the documented shell fallback first when available; record the failure and affected acceptance checks, then correct locally.

## External publication remains gated

Nothing in this runbook authorizes push, PR, merge, extension release, deployment, or provider/account changes. Barry approves publication only after local use is satisfactory. Follow the required secret-gated commit/push workflow and PR template at that later point.
