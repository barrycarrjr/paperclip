# COB-1260: what actually happened (2026-09-09)

Investigated against the live instance DB (port 54329) and the run logs in
`~/.paperclip/instances/default/data/run-logs/`.

## 1. The Slack DM to Brandon WAS sent

Approval `8eb37c06-a13a-481e-9051-42ccf7fbb803`, activity log:

- 16:11:17 `approval.created` (slack-tools:slack_send_dm, target Slack user U5EU3BQCE)
- 16:11:48 `approval.approved` by the operator
- 16:11:48 `approval.executed` `{ ok: true, hadError: false }`

So the send succeeded. There is no bug in the send path.

The reason nothing looks sent:

- `linkedIssueIds` on both the approval and the wake was `[]`. The draft gate
  (`server/src/services/tool-draft-gate.ts`) never links the approval to the issue
  it came from, so COB-1260's Activity tab has no record of the draft or the send.
- The post-approval chat wake targets `payload.chatSessionId`, which for an agent
  run is the synthetic string `heartbeat:<runId>`, not a real chat session.
  `appendApprovedDraftResultToChatSession` therefore skips, and the agent is never
  told the outcome. Four minutes later the same agent still believed the DM was
  "pending your approval".
- The agent's own comment at 16:11:42 says "Reached out to Brandon Carr via Slack DM"
  when at that moment it had only queued a draft. That is the line on screen and it
  was not true when written.

## 2. "Waiting to be picked up" is accurate but unreachable

`issue_email_delegations` row `9e3d5d20`: `status = delegated`, `acknowledged_at = null`.

The only things that can move it to `acknowledged` are the UI button and the MCP tools
`paperclipAcknowledgeEmailHandoff` / `paperclipResolveEmailHandoff` in
`packages/mcp-server/src/tools.ts`. Nothing auto-acknowledges when the handoff wake fires,
and (see §3) the agent does not have those tools.

## 3. The root cause behind most of this: the agent has almost no write tools

The only MCP server wired into a `claude_local` agent run is the plugin bridge
(`packages/adapters/claude-local/src/server/execute.ts:592`), named `paperclip`.
It serves plugin tools plus `listChatToolSpecs()` — 14 core tools:

  add_comment, broadcast_directive, cancel_reminder, create_issue, create_reminder,
  get_agent, get_company, get_issue, list_agents, list_companies, list_issues,
  list_reminders, preview_directive, web_fetch

`@paperclipai/mcp-server` (which has `paperclipUpdateIssue`, `paperclipCheckoutIssue`,
and all four email-handoff tools) is never mounted for this adapter. So the agent
cannot change issue status and cannot acknowledge a handoff. Its only write tools are
`add_comment` and `create_issue`.

## 4. The documented REST fallback is broken: PAPERCLIP_API_URL has no port

The agent is told to fall back to the REST API via `$PAPERCLIP_API_URL`. Its value in
the run was `http://localhost` — no port. Paperclip listens on 3100; port 80 on
that host is a different web server that 301-redirects to `http://store.localhost`,
which does not resolve. Verified:

    curl http://localhost/api/health      -> 301 -> http://store.localhost/api/health
    curl http://localhost:3100/api/health -> 200

Chain: `.env` line 6 `BETTER_AUTH_URL=http://localhost` becomes `authPublicBaseUrl`
(`server/src/config.ts:189`), and `choosePrimaryRuntimeApiUrl` (`server/src/runtime-api.ts:47-54`)
returns `new URL(...).origin` for an explicit base URL, dropping the port. The
allowed-hostnames branch below it would have appended `:3100` correctly. Note
`buildRuntimeApiCandidateUrls` does produce the correct `http://localhost:3100`
candidate, but only the primary is exported as `PAPERCLIP_API_URL`.

Two candidate fixes:
- Narrow: set `BETTER_AUTH_URL=http://localhost:3100` in `.env`.
- Real: in `choosePrimaryRuntimeApiUrl`, if the explicit base URL has no explicit port
  and its hostname is in `allowedHostnames`, append the listen port.

## 5. Live consequence: a 30-second heartbeat loop burning money

Because status is stuck at `in_progress`, the harness fires `issue_continuation_needed`
every ~30 seconds. As of 16:21 there were 18 runs and 18 comments on COB-1260, the last
twelve of them literally "No new context. No-op. Exiting." Run costs seen in the logs:
$0.286 for the first, ~$0.05 each thereafter, roughly $6/hour and still running.

Stopping it: set COB-1260 to `blocked` (or `done`) on the board. That is exactly what the
agent's second, still-pending draft (`80d6dee4`) is asking the operator to do.

---

# What was changed (2026-09-09)

## Immediate

COB-1260 set to `blocked` in the database. The loop stopped: no runs after 16:24:39,
against one every ~30 seconds before it. Done by direct DB update because the board API
token in `~/.paperclip/auth.json` **expired at 15:47 UTC that same day**, 34 minutes
before this. Re-run `paperclipai auth login --instance-admin` before any CLI or REST work
against the instance; it needs a browser click, so it is the operator's to do.

## Code

**1. `server/src/runtime-api.ts` — the port is put back on.**
`reachableRuntimeOrigin` corrects an explicit public base URL that cannot reach this
process: `http:` scheme, no written port, we are not on 80, and the hostname is one we
serve. All four conditions must hold, so an `https:` proxy address, a written-down port,
and a hostname we do not answer for are all left exactly as configured. Applied to both
the primary URL and the candidate list. `.env` was NOT edited — `BETTER_AUTH_URL` is still
`http://localhost`, which is right for browser auth callbacks; only the runtime
address needed correcting.

**2. `server/src/services/chat-tools.ts` — `update_issue`.**
Status and priority, with an optional comment. Deliberately narrow: reassigning and
retitling stay out. Also adds `attributionFor`, which splits the `agent:<uuid>` user id
a bridge session carries for an agent run back into agent attribution, so an agent's
edits and comments are not filed under a user who does not exist.

**3. `server/src/services/issue-email-delegations.ts` + `heartbeat.ts` — picked up at checkout.**
`acknowledgeOnCheckout` moves an open `delegated` handover to `acknowledged` when the
assigned agent checks the issue out. Someone else's handover is left alone; a handover
naming nobody is fair game. Called from the existing auto-checkout site in `heartbeat.ts`
and swallowed there, so a tracking row cannot take a live run down.

**4. `server/src/services/tool-draft-gate.ts` — drafts are linked to their issue.**
`issueIdForRun` reads the issue out of the run's own context snapshot, so nothing in the
SDK, the adapters or any plugin had to change. The issue page already renders linked
approvals (`IssueDetail.tsx:817`), so the draft and its approved state now show on the
issue itself.

**5. `server/src/services/tool-draft-gate.ts` — the drafted-result wording.**
Now says NOTHING HAS BEEN SENT and not to report having contacted anyone. The old wording
only said "wait for the approval.resolved wake", which the agent read as close enough to
done.

**6. `server/src/routes/approvals.ts` — the send is reported on the issue.**
After an approved draft runs, a comment goes on the linked issue: "Sent." or "Not sent."
with the reason. Non-fatal — a failed comment cannot turn a successful send into a 500.
The wake payload and context snapshot also carry `draftExecution` now, so the agent is
told the outcome rather than just "approved".

## Tests

- `runtime-api.test.ts` — 5 new (correction applied, and each of the three cases where it
  must not be)
- `issue-email-delegations-service.test.ts` — 5 new, against real embedded Postgres
- `chat-tools-update-issue.test.ts` — 9 new (new file)
- `tool-draft-gate.test.ts` — 4 new
- `approval-routes-idempotency.test.ts` — 3 new

## Not done, deliberately

- **`resolve` / `hand_back` for email handovers are still not reachable by an agent.**
  `resolve` sends a reply to the original sender and needs the tool dispatcher threaded
  into chat-tools; `hand_back` is state-only and would be cheap. So an agent still cannot
  finish or return a handed-over email, only pick it up.
- The `@paperclipai/mcp-server` package is still not mounted for `claude_local` runs. This
  fixes the specific gap that stranded the run rather than that larger question.

---

# Second pass: restart, and three tests that were already failing

## Three pre-existing test failures, each confirmed against a stash of this work

**1 and 2. `chat-account-routing.test.ts` — the test was wrong.**
Its two "no accounts configured" assertions fell through to the Switchboard fallback,
which reads the developer's real `~/.codex` and `~/.claude`. They passed on a machine
without Switchboard and failed on one with it. Stubbed `../switchboard.js` at the module
boundary; unsetting an environment variable would not have done it, because
`switchboardAccountFor` also reaches for a CLI on PATH and a cached answer on disk.

**3. `claude-local-execute.test.ts` — the test was stale, the code is right.**
It expected `"You're out of extra usage"` to classify as `transient_upstream`.
`classifyClaudeFailure` checks the spent-plan wording BEFORE the transient wording, on
purpose and with a long comment saying why: "out of extra usage" means the paid overage is
gone, so a transient classification parks a finished subscription on a two-minute retry
ladder it cannot climb out of. `parse.test.ts:318` already asserts `plan_exhausted` for the
same family of wording, so the two files directly contradicted each other. Updated the
execute-level test to expect `claude_plan_exhausted` plus `planResetsAt`, and to assert
`transientRetryNotBefore` is absent.

## A fourth thing, found while trying to run the suite

**`pnpm test:run` could not run at all on Windows** (`scripts/run-vitest-stable.mjs`).
It spawned `pnpm` with no shell; on Windows that is `pnpm.cmd`, so it died with
`spawnSync pnpm ENOENT` — which reads like pnpm is missing when it is on PATH and working.
Naming `pnpm.cmd` explicitly is necessary but not sufficient: since the CVE-2024-27980
hardening Node refuses to spawn a `.cmd` without a shell and fails `EINVAL`. Both are now
applied, Windows only. Every whole-repo suite run on this machine before this was
impossible; suite runs were server-only and scoped by hand.

## The restart

The dev-service registry was stale — its recorded PIDs had been recycled onto unrelated
processes — and the real server (PID 42120, up since 10:28) was detached from any watcher,
so it had never picked up any edit. Stopping it left orphaned Postgres worker processes
holding port 54329 with a stale `postmaster.pid`, twice; startup hung on
`migration-status.ts` for about 20 minutes each time because the socket was accepted by a
child that could not serve. Cleared the orphans, removed the stale lock, and started
Postgres directly to read its log: `database system was not properly shut down; automatic
recovery in progress` followed by `redo is not required`. No data loss. Verified after:
3,030 issues, 12 companies, 69 agents, 71 approvals, 10,147 comments, COB-1260 still
`blocked`. The instance was down about 25 minutes.

**Correction to something believed earlier in this document's first half:** the startup
banner does NOT print `PAPERCLIP_API_URL`. It builds its own string from host and port
(`startup-banner.ts:101`), so it cannot verify the runtime-API fix.

**And the running server does not exercise that fix.** `dev-watch.ts:16` spawns the server
with its working directory set to `server/`, so `config.ts` never loads the repo-root
`.env` and never sees `BETTER_AUTH_URL=http://localhost`. `authPublicBaseUrl` is
therefore null and `PAPERCLIP_API_URL` resolves to `http://127.0.0.1:3100`, which is
reachable — the original symptom is gone on this process, but by launch path, not by the
fix. The agent that hit the bug saw `http://localhost`, so the previous server was
started from the repo root by some other route. Anyone restoring that launch path gets the
fix doing the actual work; the unit tests cover exactly that configuration.
