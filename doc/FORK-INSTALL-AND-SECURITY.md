# Fork installation and security ports

This checkout is `barrycarrjr/paperclip`. The published `paperclipai` npm package
is upstream; installing that package does not install this fork.

## macOS

Install Git, Node.js 24.11 or newer, pnpm 9.15.4, Rust through rustup, and the
Apple command line tools (`xcode-select --install`). The runner pins Rust in
`packages/paperclip-runner/rust-toolchain.toml`; rustup downloads that version.

```bash
git clone https://github.com/barrycarrjr/paperclip.git
cd paperclip
bash scripts/launchers/macos/install-paperclip.command
```

The installer builds the runtime including `paperclip-runnerd`, initializes or
migrates the database, records the checkout, and creates
`~/Applications/Paperclip.app`. Open that app to start Paperclip in Terminal.
You can also double-click the `.command` launchers after installation, or run
them with Bash. This is a source installer with an app shortcut, not a signed,
self-contained DMG. It requires the checkout and installed build tools.
Installers use `onboard --yes --setup-only` so configuration completes before
database migration and install-marker recording; onboarding does not start a
server halfway through the installation.

## Linux

Use the same Node, pnpm, Git, and rustup requirements, plus a C compiler and
linker (for example `build-essential` on Debian/Ubuntu).

```bash
git clone https://github.com/barrycarrjr/paperclip.git
cd paperclip
bash scripts/launchers/unix/install-paperclip.sh
bash scripts/launchers/unix/launch-paperclip.sh
```

On either platform, `stop-paperclip`, `restart-paperclip`, `update-paperclip`,
and `rebuild-paperclip` are in `scripts/launchers/unix/`; macOS also has Finder
entry points for install, launch, stop, update, and rebuild. Stop targets the
managed process for this checkout and config, rather than killing processes
by port. Ctrl-C in the launch terminal stops the managed server.

Data defaults to `~/.paperclip/instances/default`. `PAPERCLIP_HOME`,
`PAPERCLIP_INSTANCE_ID`, and `PAPERCLIP_CONFIG` can select another installation.
The Mac app records those selections when it is created. Set these variables
consistently when running the shell launchers. A fresh install binds to loopback.
The managed server starts from its config directory so a checkout's development
`.env` cannot silently redirect it to another installation's database.
Use `pnpm paperclipai configure` to change settings afterward.

Updates require a clean `master` checkout and a fast-forward from `origin/master`.
Update and rebuild check the checkout and build tools first, then stop the
managed server, create a database backup, build, migrate, and relaunch only
after success. A failed check leaves the old server running. A failure after
the server has stopped leaves it stopped and keeps the old install marker: fix
the reported error, then rerun rebuild.

The Settings UI can update, rebuild, and restart a server started by these
launchers. It runs the same checks before anything stops (`update-paperclip.sh
--check`, `rebuild-paperclip.sh --check`) and shows the reason if one fails, or
if the server was not started by these launchers. Once a run starts, its output
goes to `$PAPERCLIP_HOME/logs/maintenance.log`. On macOS, a run started from the
UI reopens the server in a new Terminal window when it succeeds, with the same
environment the old server had, so Ctrl-C there stops it as usual. If the run
itself fails, a macOS alert names the failed step, says whether Paperclip is
still running, and says how to recover; a problem that starts only in the new
Terminal window shows in that window. On Linux, a run started from the UI
relaunches the server in the background with its output in the maintenance log.

Windows retains `scripts/launchers/windows/*.bat` and its tray launcher. Full
runtime builds now also require Rust and a C toolchain there: either MSVC in a
Developer shell, or GCC on PATH and the pinned GNU Rust toolchain. With GCC,
the binary builder reports the required `rustup toolchain install` command
when that toolchain is missing. It respects `RUSTUP_TOOLCHAIN` and
`CARGO_BUILD_JOBS` overrides.

## Security changes

The following upstream changes were ported locally on 2026-10-03:

| Upstream commit | Local behavior |
| --- | --- |
| `1cfed0c0f` | Invite tokens contain 256 random bits. Invite-token routes share a 20 requests/minute per-IP sliding window and return HTTP 429 plus Retry-After. Raw forwarded-IP headers cannot reset the budget. |
| `70357b961` | Agent JWTs use a company-derived HMAC signing key. The fork retains human tool-session attribution and its 48-hour default TTL. |
| `57a7da81e` | Signing keys also depend on the instance ID, and tokens carry `instance_id`. New tokens cannot downgrade to master-key verification. |
| `05bcd3ce8` | Plugin entities, logs, job runs, and webhook deliveries have company foreign keys with cascading deletion. Entity lookups, upserts, and filtered lists use tenant scope. |

For compatibility, pre-upgrade JWTs lacking `instance_id` can still use the old
master signature. After the longest previously configured token TTL has elapsed
(48 hours by default), set `PAPERCLIP_AGENT_JWT_DISABLE_LEGACY_FALLBACK=true` and
restart. Set it immediately if all active runs/tool sessions can receive fresh
credentials. Strict issuer/audience checks remain in force.

Migration `0105_plugin_company_id_tenant_isolation.sql` preserves existing rows.
It backfills entity ownership from existing company/project/workspace/agent/
issue/goal/run scopes. Unattributable rows and legacy logs/jobs/webhooks remain
instance-scoped; new writers should supply `companyId`. Entity writes infer
ownership from their host scope and reject a conflicting explicit company.
Two unique indexes enforce company and instance deduplication while preserving
multiple anonymous entities with no external ID. This is a deliberate
compatibility adjustment to upstream's NULLS NOT DISTINCT constraint.

The invite limiter is in-memory per server process, matching the upstream port.
Multiple server replicas need a shared proxy or rate-limit service for a single
instance-wide request budget. Express only uses forwarded IPs when the operator
has explicitly configured trusted proxies.

## Runner and upstream maintenance

`pnpm build:runtime` includes both the native runner and eval-kernel. Windows LF
checkout rules, missing skill references, capability inventories, and a Windows
file-URL imports and the contract generator entry point were repaired. Refresh source-derived inventories with:

```bash
pnpm --filter @paperclipai/paperclip-runner exec node scripts/generate-capability-inventory.mjs --local-sources
```

This preserves the reviewed external eval corpus; replacing that corpus still
requires `PAPERCLIP_EVALS_ROOT`. The runner is built as a standalone package.
This does not replace the fork's adapter-based orchestration with upstream's
new native-runtime integration. The package build validates its own regression
references; `check-runner-workflow-traceability.mjs --with-app` also requires
upstream App integration tests that this fork does not contain. Windows provider
execution still has the runner's upstream limitations; compiling its binary
does not establish macOS/Linux provider parity on Windows.

`.github/workflows/unix-runtime.yml` builds and smoke-tests fresh installations
on macOS and Ubuntu when these changes are pushed. Local Windows verification
cannot certify actual Finder behavior or macOS provider execution.

`.github/workflows/upstream-security-watch.yml` checks upstream daily after it
is published on the fork's default branch. It reports candidate auth/plugin
changes and security-related subjects in the Actions summary, and fails visibly
when review is needed. It performs no merges or automatic patches. This reduces
the chance of missing a fix; the fork still needs maintenance and the classifier
is not a complete vulnerability audit. Review and port/test candidates before
advancing `scripts/upstream-security-baseline.json`.

The fork's removed analytics and default external feedback export remain removed.

## Local verification on 2026-10-03

- `pnpm -r typecheck` and `pnpm build` passed, including the pinned Rust runner binary.
- 108 targeted tests passed across the security, plugin SDK, update-check,
  maintenance-route, and onboarding suites. Ten Node tests passed for Mac
  app generation, capability inventory/contract validation, direct CLI execution,
  and upstream review detection. One upstream guidance test is skipped because
  its section is absent from the fork skill sources.
- All new Bash/Finder launcher scripts passed Bash syntax validation.
- A temporary installation on Windows booted on port 3199, returned a healthy
  API response, detected a duplicate launch, and stopped through the managed
  service. It used an isolated data home; the operator's database was not migrated.
- `pnpm test:run` was attempted. It stops at 32 failures in 11 existing UI
  suites (routing/tab expectations, runtime defaults, and outdated mocks).
  A separate broad server run also found existing adapter/skill-sync/import
  expectation failures and a database startup timeout under concurrency.
  The changed security and maintenance suites pass. The repository-wide suite
  is not green, and browser suites were not run.
- The security migration is numbered `0105` after the merged memory-folder
  migration. A database-upgrade regression verifies ownership backfill while
  preserving the memory table.
- A fresh checkout needs `pnpm install --no-frozen-lockfile` because the fork
  owns lockfile updates in CI; the new Unix workflow follows this policy.
- Initial macOS/Ubuntu CI runs exposed a contract generator entry point that
  silently skipped Windows validation. Its file-URL check and fork MCP mappings
  are repaired, with a direct CLI regression test; reruns remain pending.
- Docker dependency-stage manifest coverage includes the fork adapters, runner,
  and eval-kernel. `node scripts/check-docker-deps-stage.mjs` and an actual
  `docker build --target deps` passed. The image resolves its copied manifests
  into an image-local lockfile before the frozen installation; repository
  lockfile updates remain CI-managed. Verification covers the dependency stage.
- Actual Mac installation has not been verified.
