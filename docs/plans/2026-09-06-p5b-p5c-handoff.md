# Handoff: P5b and P5c are built and unverified-in-parts, nothing is committed

Written 2026-09-06 for whoever picks this up next. Everything named here is
in the working tree of two repos and none of it is committed. The supporting
files live in `docs/plans/2026-09-06-p5b-p5c-handoff/`.

Read the run sheet first. The reasoning is below it.

## Run sheet

### Before you touch anything

1. `cd ~/paperclip && git status --short` and confirm 45 changed files plus
   `scripts/_run-with-clean-env.mjs` plus the checklist and this handoff folder.
2. `cd ~/paperclip-extensions && git status --short` and confirm 27 changed files
   on `master`.
3. **Never stage `scripts/_run-with-clean-env.mjs`.** It is the local server
   launcher and stays untracked forever.
4. Read `docs/plans/2026-09-06-p5b-p5c-handoff/fix-plan.md` before deciding
   anything. It is the list of review fixes, already scoped into eight items.

### Decide first: fix, then commit, or commit, then fix

5. Recommended: **fix first, commit once.** The review found real problems in
   the code as it stands, and two of them are on the public-post path. Committing
   a known-broken guard and fixing it in the next commit puts a bad version in
   the branch history for no gain, because nothing is pushed yet.
6. The prepared commit messages in `.../handoff/commits/` describe the code as
   it was BEFORE any fix. If you fix first, reread each `.gmsg` and correct the
   sentences that no longer describe the code. `C01.gmsg` in particular claims
   the bridge answers 400 on a mismatched `params.companyId`; fix H2 changes
   that to an access check.

### Applying the fixes

7. Host items H1 to H5 touch separate files and can run in parallel.
8. Plugin items E1, E2, E3 all touch `worker.ts` and must run **in order**.
9. Every item ships its tests. Run the touched package's own tests before
   moving on:
```bash
cd ~/paperclip/ui && pnpm exec vitest run
```
```bash
cd ~/paperclip/server && pnpm exec vitest run
```
```bash
cd ~/paperclip-extensions/plugins/gbp-reviews && npm test
```
10. The server suite takes about 16 minutes and has **3 pre-existing failures**
    that are not yours: `chat-account-routing` (2, Switchboard env) and
    `claude-local-execute` (1). Anything beyond those three is a regression.

### Committing

11. Thirteen groups, in order C01 to C11 (host), then E01, E02 (extensions).
    Each has a `.gmsg` (message) and a `.gfiles` (exact file list).
12. For each group, stage and commit with the SAME explicit pathspec, because
    `git commit` otherwise commits the whole index:
```bash
cd ~/paperclip && git add -- $(cat docs/plans/2026-09-06-p5b-p5c-handoff/commits/C01.gfiles) && git commit -F docs/plans/2026-09-06-p5b-p5c-handoff/commits/C01.gmsg -- $(cat docs/plans/2026-09-06-p5b-p5c-handoff/commits/C01.gfiles)
```
13. Replace the `Co-Authored-By:` line at the end of every `.gmsg` with the one
    your own system prompt gives you. The prepared files say Claude Fable 5.1
    because that was the attribution when they were written.
14. The pre-commit hook runs a forbidden-token check and a full workspace
    typecheck, so each commit takes a while and can fail on another session's
    unfinished code. That is expected, not a fault in your change.
15. The P6 trial checklist and this handoff folder are not in any group. Commit
    them separately, last.

### Deploying and releasing (order matters)

16. Restart the host. Migration 0097 applies on restart. Show the operator the SQL
    first; it is one additive partial unique index and rolls back with a DROP.
17. **Host first, plugin second.** The gbp-reviews handlers now require the
    host's `hostScope` stamp. A plugin released ahead of the host shows an
    access sentence on every screen.
18. Build and redeploy the plugin locally before releasing:
```bash
cd ~/paperclip-extensions/plugins/gbp-reviews && npm run build
```
19. Release as v0.77.0 (gbp-reviews 0.1.10) with the
    `release-paperclip-extensions` skill.
20. Push both repos. Pull request 8 is already open on the fork.

### Rollback

21. Nothing is pushed, so `git reset` is not needed; before any commit the
    fallback is simply not committing.
22. After commits, the only outward-facing steps are the push and the plugin
    release. Migration 0097 rolls back with
    `DROP INDEX issues_start_work_request_uq`.

## What was built

Two features, both designed through a reader pass and a judge panel before any
code, both specified in `docs/plans/2026-09-06-p5b-start-work-spec.md`.

**P5b, "What do you want done?"** the operator types a request in his own words in the
sidebar panel, a server-side one-shot model call drafts a plan, and he sees a
plain-words header (who leads it, that it starts on accept and runs once, how
many tasks in which company, which model drafted it, whether the agents'
outbound messages will wait for approval) above a checklist he can trim.
Nothing exists until he accepts, except one inert request issue in Backlog with
no assignee, which is cancelled if he rejects. Accepting creates the tasks and
hands the request to the company's lead inside one transaction.

**P5c, the Google review reply editor.** Each location card opens to its
reviews; clicking one opens an editor with a "Posts as" line naming the listing
and the Google account, taken from settings and never editable. Posting goes
through a confirm panel that shows the exact text and requires a public-post
tick, plus a second tick to replace a reply already on Google. Agents can never
replace a reply. One host change supports it: all four plugin bridge routes now
stamp the host-validated company and user onto the params the worker receives.

## What the review found

Six independent reviewers over both diffs produced 53 findings. The adversarial
verification stage was cut short twice by usage limits, so the findings fall
into three honest groups. All 53 are written up in full in
`docs/plans/2026-09-06-p5b-p5c-handoff/review-findings.md`.

**Confirmed by independent refuters (act on these):**

- The start-work hand-over and cancel hooks fire for ANY suggest_tasks card on
  the request issue, not only the plan card. Once the lead is working on the
  request and proposes follow-up work, accepting that proposal resets the
  request to Todo and evicts the running agent; rejecting it cancels the whole
  request while its tasks stay live. Three reviewers found this independently
  (correctness-1, correctness-2, security-2) and a working reproduction is at
  `.../handoff/repros/security-2-start-work-hooks.repro.ts`.
- A reply attempt whose outcome was lost (a dropped connection, a worker
  restart) leaves a row that hides the Post button for that review permanently.
  The page has no way back, because the retry key lives only in the browser tab
  that is gone (tests-002, high).
- Five smaller ones: a plan can name an agent that is still pending approval and
  then fail to accept (security-4); a failed audit write after a successful
  action is untested (tests-005); the viewer test proves nothing (tests-009); a
  refetch failure after a successful accept is shown as a failed accept
  (tests-010); the agent tool's location scoping is untested (tests-007); the
  access sentence shows before access is known (ux-honesty-04).

**Refuted, do not act:** tests-004 and security-7. The rate-limit suggestion in
particular was refuted on the grounds that a one-route limiter would not close
the exposure and would be the only limiter in the server.

**Found but never independently verified:** everything else, including two I
checked by hand and believe are real:

- The new 400 on a mismatched `params.companyId` breaks the email-tools and
  help-scout rule settings pages. Both deliberately send the mailbox's own
  company in params while the runtime sends the selected company in the body. I
  read both files and the comment in each says exactly that. Fix H2 turns the
  refusal into an access check.
- `pickOneShotModel` puts the environment variable ahead of a configured native
  provider; the code it replaced did the opposite on purpose, for speed. Fix H3.

Treat the rest as unverified leads, not as facts. Re-run verification on any
one you plan to act on.

## Test state as of this handoff

- ui: 1360 pass (196 files)
- shared: 121 pass
- gbp-reviews plugin: 128 pass, typecheck clean, bundle builds
- server: 2124 pass, 3 failures, all three pre-existing and listed above
- drizzle: no schema drift

## Two edits made after those runs

Both are trivial and both are inside existing commit groups:

- `plugins/gbp-reviews/src/manifest.ts` and `README.md`: removed the em dashes
  from the setup instructions shown on the plugin settings screen and from the
  README line this change added. Older release-note lines predate this work and
  were left alone. Folds into E02.
- `docs/plans/2026-09-06-p6-trial-checklist.md`: added Parts 6 and 7, eighteen
  new steps covering both features, taking the trial from 26 steps to 44. Step
  44 is the single attended live post to Google and is deliberately last.

## Things to know that are not in the code

- Migration 0097 has not been applied to the live instance. It applies on the
  next server restart.
- The live instance loads plugins from `~/.paperclip/installed-plugins/<key>`.
  Redeploy locally with
  `pnpm --filter paperclipai exec tsx src/index.ts plugin reinstall gbp-reviews --local-path <dir>`
  and an empty `DATABASE_URL` so the embedded Postgres on 54329 wins over the
  repo `.env`.
- P6 is the operator's own trial and cannot be run for him. The checklist is the
  deliverable, not a task to complete.
- The one thing in P5c that reaches the public internet is step 44 of that
  checklist. Everything else in the feature is a refusal or a confirm panel.

## Update 2026-09-06 later the same day: the fixes were applied, still nothing committed

The fix-first route in the run sheet was taken. All eight items in
`fix-plan.md` (H1 to H5 and E1 to E3) are applied in the working tree, each
with its own tests. Steps 5 and 6 of the run sheet are therefore done, and
the prepared commit messages have been reread and corrected: they now
describe the code as it stands after the fixes, and they carry the current
attribution line rather than the one they were written with.

Test state after the fixes:

- server: 2138 pass, 3 fail. The three are the same pre-existing ones as
  before, in the same two files (chat-account-routing 2, claude-local-execute
  1), confirmed by running those two files on their own.
- ui: 1366 pass (196 files)
- shared: 121 pass
- gbp-reviews plugin: 164 tests, 163 pass, 1 skipped. The skipped one is a new
  test file that needs a real Postgres connection string in
  GBP_REVIEWS_TEST_DATABASE_URL. It was run against the local embedded
  Postgres once and passed, and it skips with a printed reason when the
  variable is unset.
- workspace typecheck (what the pre-commit hook runs): clean across every
  package.
- plugin typecheck and bundle build: clean.

Three things changed outside the fix plan, all of them consequences of it:

- The P6 trial checklist quoted three sentences that these fixes reworded.
  Steps 30 and 32 now match what the screen says.
- `2026-09-06-p5b-start-work-spec.md` was written before the review, so it
  described the pre-fix behaviour in places. It has been corrected and carries
  a short "What changed after the review" section at the end.
- Two files were added to the E02 commit group: the plugin lock file and the
  new real-Postgres test, which arrived with a development-only dependency.

Still true from the original handoff: nothing is committed, nothing is pushed,
migration 0097 has not been applied, and the plugin must be released after the
host, not before.
