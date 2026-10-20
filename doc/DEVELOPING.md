# Developing

This project can run fully in local dev without setting up PostgreSQL manually.

## Deployment Modes

For mode definitions and intended CLI behavior, see `doc/DEPLOYMENT-MODES.md`.

Current implementation status:

- canonical model: `local_trusted` and `authenticated` (with `private/public` exposure)

## Prerequisites

- Node.js 20+
- pnpm 9+

## Dependency Lockfile Policy

GitHub Actions owns `pnpm-lock.yaml`.

- Do not commit `pnpm-lock.yaml` in pull requests.
- Pull request CI validates dependency resolution when manifests change.
- Pushes to `master` regenerate `pnpm-lock.yaml` with `pnpm install --lockfile-only --no-frozen-lockfile`, commit it back if needed, and then run verification with `--frozen-lockfile`.

## Start Dev

From repo root:

```sh
pnpm install
pnpm dev
```

This starts:

- API server: `http://localhost:3100`
- UI: served by the API server in dev middleware mode (same origin as API)

`pnpm dev` runs the server in watch mode and restarts on changes from workspace packages (including adapter packages). Use `pnpm dev:once` to run without file watching.

`pnpm dev:once` auto-applies pending local migrations by default before starting the dev server.

`pnpm dev` and `pnpm dev:once` are now idempotent for the current repo and instance: if the matching Paperclip dev runner is already alive, Paperclip reports the existing process instead of starting a duplicate.

## Storybook

The board UI Storybook keeps stories and Storybook config under `ui/storybook/` so component review files stay out of the app source routes.

```sh
pnpm storybook
pnpm build-storybook
```

These run the `@paperclipai/ui` Storybook on port `6006` and build the static output to `ui/storybook-static/`.

Inspect or stop the current repo's managed dev runner:

```sh
pnpm dev:list
pnpm dev:stop
```

`pnpm dev:once` now tracks backend-relevant file changes and pending migrations. When the current boot is stale, the board UI shows a `Restart required` banner. You can also enable guarded auto-restart in `Instance Settings > Experimental`, which waits for queued/running local agent runs to finish before restarting the dev server.

Tailscale/private-auth dev mode:

```sh
pnpm dev --bind lan
```

This runs dev as `authenticated/private` with a private-network bind preset.

For Tailscale-only reachability on a detected tailnet address:

```sh
pnpm dev --bind tailnet
```

Legacy aliases still map to the old broad private-network behavior:

```sh
pnpm dev --tailscale-auth
pnpm dev --authenticated-private
```

Allow additional private hostnames (for example custom Tailscale hostnames):

```sh
pnpm paperclipai allowed-hostname dotta-macbook-pro
```

## Test Commands

Use the cheap local default unless you are specifically working on browser flows:

```sh
pnpm test
```

`pnpm test` runs the Vitest suite only. For interactive Vitest watch mode use:

```sh
pnpm test:watch
```

Browser suites stay separate:

```sh
pnpm test:e2e
pnpm test:release-smoke
```

These browser suites are intended for targeted local verification and CI, not the default agent/human test command.

## One-Command Local Run

For a first-time local install, you can bootstrap and run in one command:

```sh
pnpm paperclipai run
```

`paperclipai run` does:

1. auto-onboard if config is missing
2. `paperclipai doctor` with repair enabled
3. starts the server when checks pass

## Docker Quickstart (No local Node install)

Build and run Paperclip in Docker:

```sh
docker build -t paperclip-local .
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

Or use Compose:

```sh
docker compose -f docker/docker-compose.quickstart.yml up --build
```

See `doc/DOCKER.md` for API key wiring (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) and persistence details.

## Docker For Untrusted PR Review

For a separate review-oriented container that keeps `codex`/`claude` login state in Docker volumes and checks out PRs into an isolated scratch workspace, see `doc/UNTRUSTED-PR-REVIEW.md`.

## Database in Dev (Auto-Handled)

For local development, leave `DATABASE_URL` unset.
The server will automatically use embedded PostgreSQL and persist data at:

- `~/.paperclip/instances/default/db`

Override home and instance:

```sh
PAPERCLIP_HOME=/custom/path PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```

No Docker or external database is required for this mode.

## Storage in Dev (Auto-Handled)

For local development, the default storage provider is `local_disk`, which persists uploaded images/attachments at:

- `~/.paperclip/instances/default/data/storage`

Configure storage provider/settings:

```sh
pnpm paperclipai configure --section storage
```

## Default Agent Workspaces

When a local agent run has no resolved project/session workspace, Paperclip falls back to an agent home workspace under the instance root:

- `~/.paperclip/instances/default/workspaces/<agent-id>`

This path honors `PAPERCLIP_HOME` and `PAPERCLIP_INSTANCE_ID` in non-default setups.

For `codex_local`, Paperclip also manages a per-company Codex home under the instance root and seeds it from the shared Codex login/config home (`$CODEX_HOME` or `~/.codex`):

- `~/.paperclip/instances/default/companies/<company-id>/codex-home`

If the `codex` CLI is not installed or not on `PATH`, `codex_local` agent runs fail at execution time with a clear adapter error. Quota polling uses a short-lived `codex app-server` subprocess: when `codex` cannot be spawned, that provider reports `ok: false` in aggregated quota results and the API server keeps running (it must not exit on a missing binary).

## Worktree-local Instances

When developing from multiple git worktrees, do not point two Paperclip servers at the same embedded PostgreSQL data directory.

Instead, create a repo-local Paperclip config plus an isolated instance for the worktree:

```sh
paperclipai worktree init
# or create the git worktree and initialize it in one step:
pnpm paperclipai worktree:make paperclip-pr-432
```

This command:

- writes repo-local files at `.paperclip/config.json` and `.paperclip/.env`
- creates an isolated instance under `~/.paperclip-worktrees/instances/<worktree-id>/`
- when run inside a linked git worktree, mirrors the effective git hooks into that worktree's private git dir
- picks a free app port and embedded PostgreSQL port
- by default seeds the isolated DB in `minimal` mode from the current effective Paperclip instance/config (repo-local worktree config when present, otherwise the default instance) via a logical SQL snapshot

Seed modes:

- `minimal` keeps core app state like companies, projects, issues, comments, approvals, and auth state, preserves schema for all tables, but omits row data from heavy operational history such as heartbeat runs, wake requests, activity logs, runtime services, and agent session state
- `full` makes a full logical clone of the source instance
- `--no-seed` creates an empty isolated instance

Seeded worktree instances quarantine copied live execution by default for both `minimal` and `full` seeds. During restore, Paperclip disables copied agent timer heartbeats, resets copied `running` agents to `idle`, blocks and unassigns copied agent-owned `in_progress` issues, and unassigns copied agent-owned `todo`/`in_review` issues. This keeps a freshly booted worktree from starting agents for work already owned by the source instance. Pass `--preserve-live-work` only when you intentionally want the isolated worktree to resume copied assignments.

After `worktree init`, both the server and the CLI auto-load the repo-local `.paperclip/.env` when run inside that worktree, so normal commands like `pnpm dev`, `paperclipai doctor`, and `paperclipai db:backup` stay scoped to the worktree instance.

`pnpm dev` now fails fast in a linked git worktree when `.paperclip/.env` is missing, instead of silently booting against the default instance/port. If that happens, run `paperclipai worktree init` in the worktree first.

Provisioned git worktrees also pause seeded routines that still have enabled schedule triggers in the isolated worktree database by default. This prevents copied daily/cron routines from firing unexpectedly inside the new workspace instance during development without disabling webhook/API-only routines.

That repo-local env also sets:

- `PAPERCLIP_IN_WORKTREE=true`
- `PAPERCLIP_WORKTREE_NAME=<worktree-name>`
- `PAPERCLIP_WORKTREE_COLOR=<hex-color>`

The server/UI use those values for worktree-specific branding such as the top banner and dynamically colored favicon.
Authenticated worktree servers also use the `PAPERCLIP_INSTANCE_ID` value to scope Better Auth cookie names.
Browser cookies are shared by host rather than port, so this prevents logging into one `127.0.0.1:<port>` worktree from replacing another worktree server's session cookie.

Print shell exports explicitly when needed:

```sh
paperclipai worktree env
# or:
eval "$(paperclipai worktree env)"
```

### Worktree CLI Reference

**`pnpm paperclipai worktree init [options]`** — Create repo-local config/env and an isolated instance for the current worktree.

| Option | Description |
|---|---|
| `--name <name>` | Display name used to derive the instance id |
| `--instance <id>` | Explicit isolated instance id |
| `--home <path>` | Home root for worktree instances (default: `~/.paperclip-worktrees`) |
| `--from-config <path>` | Source config.json to seed from |
| `--from-data-dir <path>` | Source PAPERCLIP_HOME used when deriving the source config |
| `--from-instance <id>` | Source instance id (default: `default`) |
| `--server-port <port>` | Preferred server port |
| `--db-port <port>` | Preferred embedded Postgres port |
| `--seed-mode <mode>` | Seed profile: `minimal` or `full` (default: `minimal`) |
| `--no-seed` | Skip database seeding from the source instance |
| `--force` | Replace existing repo-local config and isolated instance data |

Examples:

```sh
paperclipai worktree init --no-seed
paperclipai worktree init --seed-mode full
paperclipai worktree init --from-instance default
paperclipai worktree init --from-data-dir ~/.paperclip
paperclipai worktree init --force
```

Repair an already-created repo-managed worktree and reseed its isolated instance from the main default install:

```sh
cd /path/to/paperclip/.paperclip/worktrees/PAP-884-ai-commits-component
pnpm paperclipai worktree init --force --seed-mode minimal \
  --name PAP-884-ai-commits-component \
  --from-config ~/.paperclip/instances/default/config.json
```

That rewrites the worktree-local `.paperclip/config.json` + `.paperclip/.env`, recreates the isolated instance under `~/.paperclip-worktrees/instances/<worktree-id>/`, and preserves the git worktree contents themselves.

For an already-created worktree where you want the CLI to decide whether to rebuild missing worktree metadata or just reseed the isolated DB, use `worktree repair`.

**`pnpm paperclipai worktree repair [options]`** — Repair the current linked worktree by default, or create/repair a named linked worktree under `.paperclip/worktrees/` when `--branch` is provided. The command never targets the primary checkout unless you explicitly pass `--branch`.

| Option | Description |
|---|---|
| `--branch <name>` | Existing branch/worktree selector to repair, or a branch name to create under `.paperclip/worktrees` |
| `--home <path>` | Home root for worktree instances (default: `~/.paperclip-worktrees`) |
| `--from-config <path>` | Source config.json to seed from |
| `--from-data-dir <path>` | Source `PAPERCLIP_HOME` used when deriving the source config |
| `--from-instance <id>` | Source instance id when deriving the source config (default: `default`) |
| `--seed-mode <mode>` | Seed profile: `minimal` or `full` (default: `minimal`) |
| `--no-seed` | Repair metadata only when bootstrapping a missing worktree config |
| `--allow-live-target` | Override the guard that requires the target worktree DB to be stopped first |

Examples:

```sh
# From inside a linked worktree, rebuild missing .paperclip metadata and reseed it from the default instance.
cd /path/to/paperclip/.paperclip/worktrees/PAP-1132-assistant-ui-pap-1131-make-issues-comments-be-like-a-chat
pnpm paperclipai worktree repair

# From the primary checkout, create or repair a linked worktree for a branch under .paperclip/worktrees/.
cd /path/to/paperclip
pnpm paperclipai worktree repair --branch PAP-1132-assistant-ui-pap-1131-make-issues-comments-be-like-a-chat
```

For an already-created worktree where you want to keep the existing repo-local config/env and only overwrite the isolated database, use `worktree reseed` instead. Stop the target worktree's Paperclip server first so the command can replace the DB safely.

**`pnpm paperclipai worktree reseed [options]`** — Re-seed an existing worktree-local instance from another Paperclip instance or worktree while preserving the target worktree's current config, ports, and instance identity.

| Option | Description |
|---|---|
| `--from <worktree>` | Source worktree path, directory name, branch name, or `current` |
| `--to <worktree>` | Target worktree path, directory name, branch name, or `current` (defaults to `current`) |
| `--from-config <path>` | Source config.json to seed from |
| `--from-data-dir <path>` | Source `PAPERCLIP_HOME` used when deriving the source config |
| `--from-instance <id>` | Source instance id when deriving the source config |
| `--seed-mode <mode>` | Seed profile: `minimal` or `full` (default: `full`) |
| `--yes` | Skip the destructive confirmation prompt |
| `--allow-live-target` | Override the guard that requires the target worktree DB to be stopped first |

Examples:

```sh
# From the main repo, reseed a worktree from the current default/master instance.
cd /path/to/paperclip
pnpm paperclipai worktree reseed \
  --from current \
  --to PAP-1132-assistant-ui-pap-1131-make-issues-comments-be-like-a-chat \
  --seed-mode full \
  --yes

# From inside a worktree, reseed it from the default instance config.
cd /path/to/paperclip/.paperclip/worktrees/PAP-1132-assistant-ui-pap-1131-make-issues-comments-be-like-a-chat
pnpm paperclipai worktree reseed \
  --from-instance default \
  --seed-mode full
```

**`pnpm paperclipai worktree:make <name> [options]`** — Create `~/NAME` as a git worktree, then initialize an isolated Paperclip instance inside it. This combines `git worktree add` with `worktree init` in a single step.

| Option | Description |
|---|---|
| `--start-point <ref>` | Remote ref to base the new branch on (e.g. `origin/main`) |
| `--instance <id>` | Explicit isolated instance id |
| `--home <path>` | Home root for worktree instances (default: `~/.paperclip-worktrees`) |
| `--from-config <path>` | Source config.json to seed from |
| `--from-data-dir <path>` | Source PAPERCLIP_HOME used when deriving the source config |
| `--from-instance <id>` | Source instance id (default: `default`) |
| `--server-port <port>` | Preferred server port |
| `--db-port <port>` | Preferred embedded Postgres port |
| `--seed-mode <mode>` | Seed profile: `minimal` or `full` (default: `minimal`) |
| `--no-seed` | Skip database seeding from the source instance |
| `--force` | Replace existing repo-local config and isolated instance data |

Examples:

```sh
pnpm paperclipai worktree:make paperclip-pr-432
pnpm paperclipai worktree:make my-feature --start-point origin/main
pnpm paperclipai worktree:make experiment --no-seed
```

**`pnpm paperclipai worktree env [options]`** — Print shell exports for the current worktree-local Paperclip instance.

| Option | Description |
|---|---|
| `-c, --config <path>` | Path to config file |
| `--json` | Print JSON instead of shell exports |

Examples:

```sh
pnpm paperclipai worktree env
pnpm paperclipai worktree env --json
eval "$(pnpm paperclipai worktree env)"
```

For project execution worktrees, Paperclip can also run a project-defined provision command after it creates or reuses an isolated git worktree. Configure this on the project's execution workspace policy (`workspaceStrategy.provisionCommand`). The command runs inside the derived worktree and receives `PAPERCLIP_WORKSPACE_*`, `PAPERCLIP_PROJECT_ID`, `PAPERCLIP_AGENT_ID`, and `PAPERCLIP_ISSUE_*` environment variables so each repo can bootstrap itself however it wants.

## New Agent Run Limits

New local agents created through the API or UI, and local agents imported from company packages, receive a 300-second run timeout and a 100-turn cap when those settings are missing. Adapters that support a turn cap consume `maxTurnsPerRun`; every local process receives the timeout. CLI-backed Clippy turns receive a 300-second timeout and the same 12-turn setting as native chat. Claude and Hermes enforce that turn setting; other CLI adapters enforce the timeout.

Explicit saved or imported values, including `0` for no cap, remain unchanged. Existing agents are not rewritten. Hermes keeps its computed timeout, which scales with its configured turn cap; gateway and cloud adapters retain their own defaults.

## Tiered Default Instruction Bundles

New default and CEO instruction bundles compose a role entry with shared core rules and source-evidence guidance. This entry stays in the wake prompt. Detailed coordination, capability, messaging, leadership and memory procedures remain separate files with task-specific reading triggers, rather than an instruction to read every file on every wake. Existing saved or custom bundles are not rewritten.

Memory and knowledge guidance starts from the relevant summary or plan section. Indexes are opened for discovery, and individual notes are opened for the evidence the task needs. A summary or search hit is not proof that its underlying source was read. This controls instruction loading and gives reading guidance; it does not enforce model obedience or implement a knowledge-base storage plugin.

References are relative to the managed instruction bundle. A runtime without mounted companion files can use the existing authenticated `GET /api/agents/{id}/instructions-bundle/file?path={relative-path}` endpoint when it has an HTTP tool, its own company-scoped agent credentials and a reachable API URL. Managed reads reject linked paths escaping their root. External folders still require instance administrator access. Remote runtimes are not guaranteed these tools or credentials; if a required reference cannot be loaded, the agent must stop the affected work and explain the missing access.

## Memory Folder Checks

Markdown notes in a configured memory folder require `name`, `kind` and `updated` frontmatter fields. A read-only check runs after each manual or scheduled memory-folder run and reports malformed headers, broken relative links, orphan notes, open gaps and active notes older than 90 days. Notes whose flat frontmatter `record_type` value is exactly `decision` or `outcome` (case-sensitive) skip only stale-active and orphan findings to avoid recommending edits to dated records; immutability is a convention, not an enforced guard. The **Rebuild index** action can replace `MEMORY.md` without running an import or export; normal exports continue to refresh it too. Exports retain obsolete Paperclip-owned notes and warn the operator to review and remove them manually. Drive file IDs are currently checked for valid syntax only when a note declares one; Paperclip does not contact Drive to confirm that the file exists.

The existing pure header and document-reference checks are exported from `@paperclipai/shared` for reuse without filesystem or network access. Logical document paths use slash separators; server wrappers retain host case matching and normal working-directory behavior. On Node versions that preserve a leading double slash in `path.posix.resolve(".")`, normalization corrects previously broken Drive-link migration links from top-level notes when a Windows server starts in a network-share or device-path working directory. The path helpers `relativeDocumentTarget`, `documentPath` and `documentLink` operate on text and are not filesystem containment checks.

### Declared document links

Memory-folder settings have an optional **Drive-link mode**, disabled for existing folders and ordinary local or Dropbox folders. In this mode a document reference uses `[Readable name](relative/path.md) (Drive-ID: exact-file-id)`. A Markdown note declares its own identity in `drive_file_id` frontmatter; existing `drive_id`, `driveId` and `driveFileId` aliases can be read when they agree. Import and export preserve the nullable `driveFileId` memory field, and export emits the canonical header. An omitted header preserves a previously saved identity. PATCH `driveFileId: null` explicitly clears it. Invalid or conflicting declared identities block import and export of that note.

The paired ID is authoritative when the relative path disagrees. The validator reports missing, malformed, conflicting, ambiguous and unresolved identities, while retaining ordinary broken-path checks. These are declared identities and syntax checks, not proof of Drive existence, access, or byte equality. No Drive network calls occur. PDF, native Drive documents, or other references without a unique declared local Markdown target remain unresolved; filenames and cloud titles are never used to invent an identity or correspondence.

`GET /api/companies/{id}/memory-folder/links/preview` is read-only and returns deterministic proposed changes, skipped evidence, memory-update counts, and before/after findings. `POST /api/companies/{id}/memory-folder/links/apply` accepts that preview's `planHash`. Apply refuses changed folder or memory evidence, unsafe entries, validation errors, and newly introduced findings before creating a recovery record. Existing paired IDs are preserved; a path can be repaired only to one unambiguous local target for that exact ID. Inline, reference-style and wiki links are supported; code examples, comments, images and unrelated web links are not migrated. Note bytes outside changed references, including BOMs and line endings, stay intact. Files with unknown company memory IDs or file/database disagreements are skipped for explicit repair or import.

An encrypted pending apply receipt is committed before the first file write. A pending receipt blocks folder import, export, index replacement and settings changes, plus edits or deletion of affected memories and declared target memories. Retrying the same hash accepts only the exact original or produced file bytes and recorded memory versions, then updates the encrypted source memories and completes the receipt. Unrelated memory edits remain allowed. File replacement and database commits are not one atomic operation; a crash can leave migrated files alongside old database content until retry completes. Later edits are preserved and cause retry to refuse further writes. There is no automatic rollback: preserve later edits separately and restore conflicting files to their original or migration-produced bytes before retrying. Recovery is bounded to 100 changed notes, 8 MiB of item data, and a 32 MiB encrypted-record payload. The guarded writer rejects linked directories and observed directory identity changes, but Node path checks cannot make external filesystem renames atomic with database commits.

## Source Evidence Guidance

Default agent onboarding bundles and built-in language-model prompts include shared source-evidence guidance. Claims about money, dates and legal terms must cite a source document that the agent read and that supports the claim. Missing, unread, ambiguous or unsupported evidence means omitting the claim. Knowledge-base answers end with `Read:` (notes actually opened and read) and `Not covered:` (what those notes do not establish). Outside knowledge must be labelled or omitted and follows the same source requirement for money, dates and legal terms.

The guidance is added during prompt composition, including resumed sessions and custom prompt templates. Existing custom instruction text and saved agent instruction files are preserved. This is an instruction to the model, not automatic verification of generated answers or plugin writes. Arbitrary process and HTTP adapters do not compose language-model prompts and must supply equivalent guidance in their external runtimes.

## Attached Company Procedures

Ollama, Aider, OpenClaw Gateway, Hermes Gateway and Cursor Cloud report ephemeral procedure support. Select company procedures explicitly in the agent Skills tab; required company procedures are included even without a saved selection. Saving a selection validates the current source and reports it as configured for the next run, never installed on a local or remote runtime. Company storage is materialized on the Paperclip host for validation; this does not install anything in a remote environment. Existing native wake instructions remain in place, and bundled Paperclip skill bodies are not automatically expanded into local-model prompts.

The shared loader reads the complete selected `SKILL.md` and ordinary UTF-8 text resources in its source directory. It validates inline and reference-style Markdown local links and conventional backtick resource paths. Missing, escaping, linked, binary and executable resources stop the run before provider submission. Supported text extensions are `.md`, `.txt`, `.json`, `.yaml`, `.yml`, `.csv`, `.tsv`, `.xml` and `.html`. Limits are eight procedures, 64 filesystem entries, four directory levels, 64 KiB per file and 128 KiB combined. The reader stops on changed files and reads through short reads to EOF. These are text-loading checks, not an interpretation of arbitrary prose or a grant of tools, script execution or external-document retrieval. Web links are citations, not automatically opened resources.

Ollama keeps its compact native wake contract and adds complete selected procedure text to the system message. Attached-procedure runs require a stable Ollama release at least 0.14.0 and a running selected model with a positive `/api/ps` `context_length`. A cold, ambiguous, unknown or insufficient model context stops with an explanation. Admission counts all final prompt UTF-8 bytes, including source-evidence guidance, plus a conservative template allowance and output budget. This is an observation and conservative estimate, not an exact tokenizer count or memory reservation. Paperclip does not warm the model, change `num_ctx` or increase GPU memory. The request sets both `truncate: false` and `shift: false`; the provider's actual capacity refusal is authoritative. Runs without attached company procedures retain normal preparation and skip these probes. See the [Ollama running-model API](https://docs.ollama.com/api/ps), [context memory guidance](https://docs.ollama.com/context-length) and [pinned 0.14.0 implementation](https://github.com/ollama/ollama/blob/v0.14.0/server/routes.go).

Aider supports this through its native repeatable `--read` flag. Complete validated files are copied to a disposable directory outside the workspace, then removed after success, preparation failure, process failure or timeout. The adapter remains local only. Aider builds its final native prompt, workspace files and history internally, so Paperclip does not claim it can measure or reserve that final model context; Aider and its provider remain responsible for capacity errors. See [Aider options](https://aider.chat/docs/config/options.html).

Gateway and cloud adapters submit the same complete bounded procedure text through their existing prompt fields. They do not deploy remote packages, expose remote skill inventories, run local procedure scripts remotely or synchronize remote resource directories. Native remote installation and discovery remain unsupported until implemented against an actual runtime protocol. Arbitrary process and HTTP adapters remain unsupported for this procedure-loading contract.

## Claude Native Advisor

Claude local configuration has an optional `advisorModel` string in Advanced settings. Enter a model alias or full id to request a second model for advice, for example `{ "model": "sonnet", "advisorModel": "opus" }`. Blank or absent keeps Paperclip advice off, including an inherited native advisor setting. Creating an agent leaves this field empty; clearing it in the editor removes only that setting. Existing Claude settings files are preserved.

The runtime passes the native `--advisor` flag on fresh and resumed invocations. Use this field instead of `extraArgs` for the flag. Advice remains experimental and depends on the installed CLI, account, provider and compatible model pair; an explicit selection is a request, not proof of availability or consultation. Native disable policies remain respected. The CLI may omit this flag from `--help`.

Advisor calls have no separate call cap and consume provider usage or plan limits. The main model and run timeout/turn limits remain unchanged. Reported native per-model usage can contain provider estimates; missing advisor consumption stays unknown. Automatic model routing and forced consultation are outside this setting. See [Claude Code advisor requirements, behavior and cost](https://code.claude.com/docs/en/advisor).

## Quick Health Checks

In another terminal:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

Expected:

- `/api/health` returns `{"status":"ok"}`
- `/api/companies` returns a JSON array

## Reset Local Dev Database

To wipe local dev data and start fresh:

```sh
rm -rf ~/.paperclip/instances/default/db
pnpm dev
```

## Optional: Use External Postgres

If you set `DATABASE_URL`, the server will use that instead of embedded PostgreSQL.

## Automatic DB Backups

Paperclip can run automatic DB backups on a timer. Defaults:

- enabled
- every 60 minutes
- retain 30 days
- backup dir: `~/.paperclip/instances/default/data/backups`

Configure these in:

```sh
pnpm paperclipai configure --section database
```

Run a one-off backup manually:

```sh
pnpm paperclipai db:backup
# or:
pnpm db:backup
```

Environment overrides:

- `PAPERCLIP_DB_BACKUP_ENABLED=true|false`
- `PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES=<minutes>`
- `PAPERCLIP_DB_BACKUP_RETENTION_DAYS=<days>`
- `PAPERCLIP_DB_BACKUP_DIR=/absolute/or/~/path`

## Secrets in Dev

The shared local child-process helper drops the server's `BETTER_AUTH_SECRET`,
`DATABASE_URL` and `DATABASE_MIGRATION_URL` from its inherited environment.
Intentional agent bindings for these names must be supplied explicitly through
adapter/run `env` (prefer secret references for credentials); explicit values,
including empty strings, are kept. Callers that merge the server environment
before launching (including Hermes execution, Pi and OpenCode execution/model
discovery/diagnostics, and Aider preparation) sanitize inherited values with the
shared helper before adding explicit bindings. Windows matches these three
inherited names without regard to case. SSH still forwards only the explicit
run environment. Native Linux/macOS launch behavior needs separate verification.
Subprocesses that bypass this helper are not covered, including status, version,
auth and model probes and execution-workspace provision, teardown, runtime-service
and job commands. These can still inherit some or all three server credentials;
covering these paths is a separate #132 follow-up.

This only prevents accidental credential inheritance. Same-account filesystem
access, other inherited provider credentials, saved output and per-agent secret
scope remain separate concerns; this does not enforce machine isolation.

Agent env vars now support secret references. By default, secret values are stored with local encryption and only secret refs are persisted in agent config.

- Default local key path: `~/.paperclip/instances/default/secrets/master.key`
- Override key material directly: `PAPERCLIP_SECRETS_MASTER_KEY`
- Override key file path: `PAPERCLIP_SECRETS_MASTER_KEY_FILE`

Strict mode (recommended outside local trusted machines):

```sh
PAPERCLIP_SECRETS_STRICT_MODE=true
```

When strict mode is enabled, sensitive env keys (for example `*_API_KEY`, `*_TOKEN`, `*_SECRET`) must use secret references instead of inline plain values.

CLI configuration support:

- `pnpm paperclipai onboard` writes a default `secrets` config section (`local_encrypted`, strict mode off, key file path set) and creates a local key file when needed.
- `pnpm paperclipai configure --section secrets` lets you update provider/strict mode/key path and creates the local key file when needed.
- `pnpm paperclipai doctor` validates secrets adapter configuration and can create a missing local key file with `--repair`.

Migration helper for existing inline env secrets:

```sh
pnpm secrets:migrate-inline-env         # dry run
pnpm secrets:migrate-inline-env --apply # apply migration
```

## Company Deletion Toggle

Company deletion is intended as a dev/debug capability and can be disabled at runtime:

```sh
PAPERCLIP_ENABLE_COMPANY_DELETION=false
```

Default behavior:

- `local_trusted`: enabled
- `authenticated`: disabled

## CLI Client Operations

Paperclip CLI now includes client-side control-plane commands in addition to setup commands.

Quick examples:

```sh
pnpm paperclipai issue list --company-id <company-id>
pnpm paperclipai issue create --company-id <company-id> --title "Investigate checkout conflict"
pnpm paperclipai issue update <issue-id> --status in_progress --comment "Started triage"
```

Set defaults once with context profiles:

```sh
pnpm paperclipai context set --api-base http://localhost:3100 --company-id <company-id>
```

Then run commands without repeating flags:

```sh
pnpm paperclipai issue list
pnpm paperclipai dashboard get
```

See full command reference in `doc/CLI.md`.

The built-in chat tools exposed through the internal MCP bridge accept either an issue UUID or a readable issue key such as `ABC-12` in `issueId` for `get_issue`, `update_issue`, and `add_comment`. Keys are case-insensitive and surrounding whitespace is ignored. Company access and read-only viewer permissions still apply.

An agent run can use these tools inside its own Personal company, matching REST API access. The bridge derives the agent's company from its run session; a user id that resembles an agent does not grant access. Other agents and users, including instance administrators, cannot access someone else's Personal company.

## OpenClaw Invite Onboarding Endpoints

Agent-oriented invite onboarding now exposes machine-readable API docs:

- `GET /api/invites/:token` returns invite summary plus onboarding and skills index links.
- `GET /api/invites/:token/onboarding` returns onboarding manifest details (registration endpoint, claim endpoint template, skill install hints).
- `GET /api/invites/:token/onboarding.txt` returns a plain-text onboarding doc intended for both human operators and agents (llm.txt-style handoff), including optional inviter message and suggested network host candidates.
- `GET /api/skills/index` lists available skill documents.
- `GET /api/skills/paperclip` returns the Paperclip heartbeat skill markdown.

## OpenClaw Join Smoke Test

Run the end-to-end OpenClaw join smoke harness:

```sh
pnpm smoke:openclaw-join
```

What it validates:

- invite creation for agent-only join
- agent join request using `adapterType=openclaw`
- board approval + one-time API key claim semantics
- callback delivery on wakeup to a dockerized OpenClaw-style webhook receiver

Required permissions:

- This script performs board-governed actions (create invite, approve join, wakeup another agent).
- In authenticated mode, run with board auth via `PAPERCLIP_AUTH_HEADER` or `PAPERCLIP_COOKIE`.

Optional auth flags (for authenticated mode):

- `PAPERCLIP_AUTH_HEADER` (for example `Bearer ...`)
- `PAPERCLIP_COOKIE` (session cookie header value)

## OpenClaw Docker UI One-Command Script

To boot OpenClaw in Docker and print a host-browser dashboard URL in one command:

```sh
pnpm smoke:openclaw-docker-ui
```

This script lives at `scripts/smoke/openclaw-docker-ui.sh` and automates clone/build/config/start for Compose-based local OpenClaw UI testing.

Pairing behavior for this smoke script:

- default `OPENCLAW_DISABLE_DEVICE_AUTH=1` (no Control UI pairing prompt for local smoke; no extra pairing env vars required)
- set `OPENCLAW_DISABLE_DEVICE_AUTH=0` to require standard device pairing

Model behavior for this smoke script:

- defaults to OpenAI models (`openai/gpt-5.2` + OpenAI fallback) so it does not require Anthropic auth by default

State behavior for this smoke script:

- defaults to isolated config dir `~/.openclaw-paperclip-smoke`
- resets smoke agent state each run by default (`OPENCLAW_RESET_STATE=1`) to avoid stale provider/auth drift

Networking behavior for this smoke script:

- auto-detects and prints a Paperclip host URL reachable from inside OpenClaw Docker
- default container-side host alias is `host.docker.internal` (override with `PAPERCLIP_HOST_FROM_CONTAINER` / `PAPERCLIP_HOST_PORT`)
- if Paperclip rejects container hostnames in authenticated/private mode, allow `host.docker.internal` via `pnpm paperclipai allowed-hostname host.docker.internal` and restart Paperclip
