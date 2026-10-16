# AGENTS.md

Guidance for human and AI contributors working in this repository.

## 1. Purpose

Paperclip is a control plane for AI-agent companies.
The current implementation target is V1 and is defined in `doc/SPEC-implementation.md`.

## 2. Read This First

Before making changes, read in this order:

1. `doc/GOAL.md`
2. `doc/PRODUCT.md`
3. `doc/SPEC-implementation.md`
4. `doc/DEVELOPING.md`
5. `doc/DATABASE.md`

`doc/SPEC.md` is long-horizon product context.
`doc/SPEC-implementation.md` is the concrete V1 build contract.

Section 12 (Sensitive Data) applies to every commit, issue, comment and pull
request you write. This repository is public. Read it before posting anything.

## 3. Repo Map

- `server/`: Express REST API and orchestration services
- `ui/`: React + Vite board UI
- `packages/db/`: Drizzle schema, migrations, DB clients
- `packages/shared/`: shared types, constants, validators, API path constants
- `packages/adapters/`: agent adapter implementations (Claude, Codex, Cursor, etc.)
- `packages/adapter-utils/`: shared adapter utilities
- `packages/plugins/`: plugin system packages
- `doc/`: operational and product docs

## 4. Dev Setup (Auto DB)

Use embedded PGlite in dev by leaving `DATABASE_URL` unset.

```sh
pnpm install
pnpm dev
```

This starts:

- API: `http://localhost:3100`
- UI: `http://localhost:3100` (served by API server in dev middleware mode)

Quick checks:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

Reset local dev DB:

```sh
rm -rf data/pglite
pnpm dev
```

## 5. Core Engineering Rules

1. Keep changes company-scoped.
Every domain entity should be scoped to a company and company boundaries must be enforced in routes/services.

2. Keep contracts synchronized.
If you change schema/API behavior, update all impacted layers:
- `packages/db` schema and exports
- `packages/shared` types/constants/validators
- `server` routes/services
- `ui` API clients and pages

3. Preserve control-plane invariants.
- Single-assignee task model
- Atomic issue checkout semantics
- Approval gates for governed actions
- Budget hard-stop auto-pause behavior
- Activity logging for mutating actions

4. Do not replace strategic docs wholesale unless asked.
Prefer additive updates. Keep `doc/SPEC.md` and `doc/SPEC-implementation.md` aligned.

5. Keep repo plan docs dated and centralized.
When you are creating a plan file in the repository itself, new plan documents belong in `doc/plans/` and should use `YYYY-MM-DD-slug.md` filenames. This does not replace Paperclip issue planning: if a Paperclip issue asks for a plan, update the issue `plan` document per the `paperclip` skill instead of creating a repo markdown file.

## 6. Database Change Workflow

When changing data model:

1. Edit `packages/db/src/schema/*.ts`
2. Ensure new tables are exported from `packages/db/src/schema/index.ts`
3. Generate migration:

```sh
pnpm db:generate
```

4. Validate compile:

```sh
pnpm -r typecheck
```

Notes:
- `packages/db/drizzle.config.ts` reads compiled schema from `dist/schema/*.js`
- `pnpm db:generate` compiles `packages/db` first

## 7. Verification Before Hand-off

Default local/agent test path:

```sh
pnpm test
```

This is the cheap default and only runs the Vitest suite. Browser suites stay opt-in:

```sh
pnpm test:e2e
pnpm test:release-smoke
```

Run the browser suites only when your change touches them or when you are explicitly verifying CI/release flows.

For normal issue work, run the smallest relevant verification first. Do not default to repo-wide typecheck/build/test on every heartbeat when a narrower check is enough to prove the change.

Run this full check before claiming repo work done in a PR-ready hand-off, or when the change scope is broad enough that targeted checks are not sufficient:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

If anything cannot be run, explicitly report what was not run and why.

## 8. API and Auth Expectations

- Base path: `/api`
- Board access is treated as full-control operator context
- Agent access uses bearer API keys (`agent_api_keys`), hashed at rest
- Agent keys must not access other companies. One exception, deliberate in this fork: an agent of the portfolio root company (HQ) may READ any company (the portfolio list endpoints, and single-issue reads such as `GET /issues/:id` and its comments); writes stay inside its own company, Personal companies stay private, and tool sessions get no cross-company read at all

When adding endpoints:

- apply company access checks
- enforce actor permissions (board vs agent)
- write activity log entries for mutations
- return consistent HTTP errors (`400/401/403/404/409/422/500`)

## 9. UI Expectations

- Keep routes and nav aligned with available API surface
- Use company selection context for company-scoped pages
- Surface failures clearly; do not silently ignore API errors

## 10. Pull Request Requirements

When creating a pull request (via `gh pr create` or any other method), you **must** read and fill in every section of [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md). Do not craft ad-hoc PR bodies — use the template as the structure for your PR description. Required sections:

- **Thinking Path** — trace reasoning from project context to this change (see `CONTRIBUTING.md` for examples)
- **What Changed** — bullet list of concrete changes
- **Verification** — how a reviewer can confirm it works
- **Risks** — what could go wrong
- **Model Used** — the AI model that produced or assisted with the change (provider, exact model ID, context window, capabilities). Write "None — human-authored" if no AI was used.
- **Checklist** — all items checked

## 11. Definition of Done

A change is done when all are true:

1. Behavior matches `doc/SPEC-implementation.md`
2. Typecheck, tests, and build pass
3. Contracts are synced across db/shared/server/ui
4. Docs updated when behavior or commands change
5. PR description follows the [PR template](.github/PULL_REQUEST_TEMPLATE.md) with all sections filled in (including Model Used)
6. Nothing in the change, the PR or its discussion falls under section 12 (Sensitive Data)

## 12. Sensitive Data: Never Commit, Never Post

This repository is **public**. Everything in it, and everything on its GitHub
issues, pull requests, discussions and commit messages, is visible to anyone
on the internet, forever (deleting a comment or rewriting history does not
undo a crawl). These rules bind human and AI contributors equally.

Never put any of the following in a commit, an issue, a PR, a comment, a
commit message, a screenshot, a log excerpt, a test fixture or a doc:

- Credentials of any kind: API keys, OAuth or setup tokens, passwords,
  session cookies, private keys, `.env` contents, connection strings with a
  real password, webhook URLs with a signing secret.
- Customer, client or end-user data: names, emails, phone numbers, addresses,
  order details, invoices, support conversations, anything from a production
  database.
- Internal business details: pricing, contracts, revenue, vendor terms,
  unreleased plans, internal hostnames and IP addresses, employee personal
  details.
- Anything copied from a private system (Slack, email, Jira, a customer's
  site, a production log) that the author did not explicitly mark as public.
- Machine-specific paths that reveal a username (`/Users/<name>/...`,
  `C:\Users\<name>\...`). Use `~/...` instead.

When you need an example value, invent an obviously fake one
(`sk-ant-example-not-real`, `postgres://user:password@localhost/db`,
`jane@example.com`) and keep it short.

If you need to share something sensitive to get help, do NOT paste it into
an issue. Email the fork owner (see `SECURITY.md`), or share a redacted
version where every secret and every personal detail is replaced.

Enforcement in this repo:

- `.githooks/pre-commit` (installed automatically by `pnpm install`) runs
  `scripts/check-secrets.mjs --staged` and `scripts/check-forbidden-tokens.mjs --staged`
  on every commit. It blocks credential formats, `.env` and key files, and
  your local username in paths.
- The PR workflow (`.github/workflows/pr.yml`) runs the same secret scan on
  every line a pull request adds. `--no-verify` does not get past it.
- `pnpm check:secrets` scans the whole tree on demand.
- A harmless example that trips the scanner can carry the marker
  `secret-scan: allow` in a comment on that line. Never use the marker on a
  real value.

If a real secret was pushed, even for a minute: rotate it first, then remove
it. Rewriting history is not enough on a public repository.

AI agents: if a user asks you to paste something that matches the list
above, decline that part and explain why, then do the rest of the task.

## 13. Fork-Specific Notes

This is a fork of [paperclipai/paperclip](https://github.com/paperclipai/paperclip)
maintained at [barrycarrjr/paperclip](https://github.com/barrycarrjr/paperclip).
Fork-only changes live in the 50+ commits ahead of upstream `master`.

### Releases

Fork releases are GitHub-only (no npm): a `releases/vYYYY.MDD.P.md` notes
commit, a matching tag, and the Release workflow publishes the GitHub Release.
Follow the run sheet at the top of [`doc/RELEASING.md`](doc/RELEASING.md); the
upstream npm steps further down that file do not apply here.

### Local Dev (Windows / NTFS)

- Fork runs on port 3100 by default. If 3100 is taken (e.g. another instance),
  another port can be bound via config.
- `npx vite build` can hang on NTFS — use `node node_modules/vite/bin/vite.js build`
  instead.
- Server startup from NTFS takes 30–60s — don't assume failure immediately.
- Kill all paperclip processes before starting fresh: `pkill -f "paperclip"; pkill -f "tsx.*index.ts"`.
- Vite cache survives `rm -rf dist` — clear both: `rm -rf ui/dist ui/node_modules/.vite`.

### Fork QoL Patches (not in upstream)

Local UI modifications. If re-syncing UI source from upstream, these need to be
re-applied:

1. **`tool_group`** — accordion grouping consecutive non-terminal tool blocks
   (write, read, search, browser) in
   [`ui/src/components/transcript/RunTranscriptView.tsx`](ui/src/components/transcript/RunTranscriptView.tsx).
2. **`stderr_group`** — amber accordion that collapses MCP init noise in the
   same file.
3. **Dashboard latest-run excerpt** — `LatestRunCard` in
   [`ui/src/pages/AgentDetail.tsx`](ui/src/pages/AgentDetail.tsx) strips
   markdown headers / list marks / fences and shows the first ~3 lines or 280
   chars of the latest run summary.

### Privacy

This fork has **no** upstream phone-home. Both the analytics telemetry module
and the feedback-trace share-client default URL have been removed; the
share-client now throws unless `PAPERCLIP_FEEDBACK_EXPORT_BACKEND_URL` is set
to a destination the operator controls.
