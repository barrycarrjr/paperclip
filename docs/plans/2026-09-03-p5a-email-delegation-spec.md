# P5a specification: durable email delegation and handback

## Phase 2 is implemented (2026-09-03, later the same day)

Barry approved the migration and the restart, so the table is live and the
lifecycle is built. What exists now, beyond phase 1:

- **The table**, `issue_email_delegations`, migration
  `0095_issue_email_delegations.sql`. Applied to the running instance on
  restart; the SQL was run and rolled back against the live database first to
  confirm it parses and its references resolve.
- **The state machine**, `packages/shared/src/email-delegation-state.ts`.
  Pure and shared, so the server, the UI and the tests read one set of rules.
  It allows skipping forward (an agent that finishes in one turn never passes
  through the middle states), allows review to send work back, and forbids
  everything else. `done` on the issue deliberately does NOT resolve the
  delegation, because resolution can send a message to a real person and must
  be an explicit act rather than a side effect of tidying a board.
- **The service**, `server/src/services/issue-email-delegations.ts`. Answers
  §4.2 (idempotent on the source email, not the issue, so a retried click
  cannot hand the same message over twice — the partial unique index settles
  genuine races), §4.3 (version check inside the UPDATE's own WHERE, so a
  stale resolve cannot overwrite a fresher handback) and §4.6 (companyId on
  every read and write, no unscoped lookup exists).
- **Resolution**, `server/src/services/email-handoff-resolution.ts`, wired to
  Barry's decision below. The delegation is marked resolved BEFORE the reply
  is attempted, and the reply's outcome is recorded separately in
  `replyState`, so a failed send is visible rather than silently undoing the
  record that the work was finished.

### The open questions, and how they were answered

- **§2 source key**: Message-Id preferred, `(mailbox, folder, uid)` as the
  documented fallback. Settled in phase 1.
- **§3 what resolution causes**: option (c), auto-send, plus a control Barry
  asked for afterwards (see below).
- **§4.1 one transaction or two steps**: **two steps, with a sweep.** Making
  issue creation fail because a tracking row could not be written would take
  a reliable action and make it less reliable, and the issue is the thing
  that carries the actual work. So the delegation is allowed to be missing,
  and `listIssuesMissingDelegation` finds the gaps so they are visible
  instead of silent — the same shape as the wake-failure fix one layer down.
- **§4.5 stale delegations**: the recommendation was taken.
  `listStale` returns open handovers nobody has picked up, for the existing
  attention queue rather than a second "things are stuck" surface. Only
  `delegated` counts: once an agent has acknowledged, slowness is the issue's
  problem to report, not the handover's.

### The approval control (Barry, 2026-09-03, correcting the note below)

The note below reads his decision as "no new approval gate". He then
corrected it: **"I didn't just mean the auto reply I meant the approval of
the auto reply"** — the approval requirement for these replies should itself
be controllable.

Built as `emailHandoffReplyApproval`, three states, in instance general
settings under the existing outbound toggle:

- `inherit` (default) follows `outboundToolDraftMode`, so someone who turns
  the outbound hold off does not find this one message still waiting with no
  explanation.
- `always` holds the reply even when nothing else is held.
- `never` sends it even when everything else is held.

Deliberately NOT a second approval mechanism. The existing draft gate still
does all the holding; the only new thing is a `forceDraftGate` flag on the
dispatcher, the mirror image of the `bypassDraftGate` that already existed,
so a caller whose policy is stricter than the instance default can say so.
Forcing does not make an ungated tool draftable, because nothing would know
how to replay it after approval. Both reply tools are already in
`OUTBOUND_TOOL_DRAFT_GATE`, and a test asserts they stay there — if one ever
leaves, "always ask me first" would quietly stop holding these.

Every unclear input resolves to requiring approval: a missing setting, an
unrecognised value, or an unreadable settings row all hold the reply. The
dangerous direction is a message reaching a customer that the operator
expected to see first.

### Still not built

- No route or agent tool calls `resolve` yet, so nothing sends today. The
  service is tested and ready; wiring it to a caller is the next step.
- The attention queue does not yet read `listStale`, and no job calls
  `listIssuesMissingDelegation`. Both are written and tested; neither is
  scheduled.
- §4.3(b), a human replying to the original email outside the app, remains
  unsolved and still needs the plugin's own event model, which this work has
  not gone into `paperclip-extensions` to inspect.

---

## Decisions and progress (updated 2026-09-03)

**Barry's decision, 2026-09-03: "Auto-send a reply, no new outbound approval
gate needed."** Recorded as §3's option (c). Read as: resolving a delegation
may send a reply through the *existing* email tool path, and no NEW approval
mechanism gets built — because the existing one
(`outboundToolDraftMode`, "Hold outbound messages for approval," which its own
settings copy says already covers agent emails) already intercepts that path.
So with that setting on (its default) a resolution reply lands in Approvals
first; with it off it sends immediately, exactly like any other agent email
today. **If he actually meant "bypass the existing approval too," that is a
different and much more consequential change — it would mean deliberately
routing around a safety mechanism that exists — and has NOT been built.**

**Phase 1 is implemented (2026-09-03) and needed no migration at all.** Two
findings while checking the real schema changed the plan for the better:

1. `issues.originKind` is a plain `text` column with a default, **not a
   Postgres enum** (`packages/db/src/schema/issues.ts:45`) — so a new origin
   kind costs no schema change. And `issues_company_origin_idx` on
   `(companyId, originKind, originId)` already exists, so looking these up is
   already indexed. The `ISSUE_ORIGIN_KINDS` constant in shared is already
   not authoritative: `harness_liveness_escalation`,
   `stranded_issue_recovery` and the portfolio-directive kind are all real,
   in use, and absent from it — they live beside their own features (e.g.
   `server/src/services/recovery/origins.ts`). This work follows that same
   pattern instead of pretending the list is complete.
2. **A client could not set origin fields at all.** `createIssueSchema` didn't
   include them, and `validate()` does `req.body = schema.parse(req.body)` —
   zod strips unknown keys — so anything the UI sent was silently discarded.
   Wiring the UI alone would have looked right and done nothing.

What Phase 1 actually shipped:

- `packages/shared/src/email-handoff-origin.ts` — a versioned, URI-encoded,
  parseable source key (`email:v1:msgid:…` preferred, `email:v1:uid:…`
  fallback), mirroring the existing `recovery/origins.ts` key-builder pattern.
- A **narrow** `origin` field on `createIssueSchema`, typed as a `z.literal`
  of the email-handoff kind only. Deliberately not the open enum: origin kinds
  drive real partial unique indexes and recovery classification, so a client
  that could claim `routine_execution` or `harness_liveness_escalation` could
  collide with those indexes or confuse the recovery sweeps. Every other kind
  stays server-set-only. Covered by a test that asserts each reserved kind is
  rejected.
- Both handoff paths (the shared `useEmailMessageActions.ts` one and
  `Email.tsx`'s own separate copy) now record it, and hand off *without* an
  origin rather than failing when a message has nothing stable to key on.

That means an email-originated issue is now identifiable and traceable back
to its exact source message, which is the foundation everything below needs —
with no new table, no migration, and no behavior change to anything else.

**Still not built, still gated:** the delegation lifecycle state machine (§3),
its table (§5), and the auto-reply-on-resolve wiring his decision above
authorizes. Those need the remaining open questions answered — and the table
needs a migration, which on this instance is **not** an inert act: pending
migrations auto-apply on server start in a non-interactive context
(`server/src/index.ts:185` → `promptApplyMigrations` returns true when
`!stdin.isTTY`), which is how this server runs. Committing a migration file
therefore schedules a live schema change at next restart. That is exactly what
this phase's gate is for, so nothing of the sort has been written.

---

Status of the rest of this document: **specification, not implemented.** Per
this project's own P5 gate, this phase is "written decisions for each
addition... not permission to perform migrations or public actions."

## 1. What exists today (verified against real, current source)

Email → agent handoff exists, and works, but is a **one-shot, untyped
creation** with no durable link back to its source and no lifecycle beyond
"issue exists now." Confirmed by reading the two real implementations (this
session fixed a bug in both, so their current shape is accurate as of
2026-09-03):

- `ui/src/components/email/useEmailMessageActions.ts`'s `handOff` mutation and
  `ui/src/pages/Email.tsx`'s own separate `handoffMutation` (two independent
  copies, not one shared path — see this file's own P2 audit note) both do
  the same three things: create a plain issue whose `description` is the
  email body pasted in as markdown text, `agentsApi.wakeup()` the assignee,
  and `markRead` the source message.
- The created issue's `originKind`/`originId`/`originRunId`/`originFingerprint`
  fields (`packages/shared/src/types/issue.ts:248-251`) are **never set** for
  an email handoff — they're populated only for `routine_execution` today
  (`server/src/services/routines.ts:982-985`). An email-originated issue is
  therefore indistinguishable, in the data model, from an issue a human typed
  by hand.
- There is no reference anywhere from the issue back to the mailbox/folder/
  message/thread it came from. Once the issue exists, the only surviving
  link to the original email is whatever text got pasted into the
  description at creation time.
- Resolution has no defined meaning. `issue.status` reaching `"done"` doesn't
  reply to the sender, doesn't reopen the mailbox thread, doesn't notify
  anyone the delegation is complete. Read/unread (already a documented rule
  in this project — see F08/A09) is explicitly not resolution or assignment,
  and nothing enforces that boundary at the delegation-tracking level because
  there's no delegation record to enforce it on.
- Wake failures are already handled honestly (fixed this session, P2): the
  toast says so, the issue still exists. But there's no retry, no
  idempotency guarantee beyond `idempotencyKey: `email-handoff:${issue.id}`\`
  on the wake call itself (which is real and correct — it prevents *that one*
  wake from double-firing, but says nothing about re-delegating later).

## 2. Source identity (what a delegation must record)

A delegation record needs to name the source precisely enough to survive the
message moving, and precisely enough that "was this email already delegated"
is answerable without re-parsing text:

| Field | Source | Notes |
|---|---|---|
| `pluginId` | the email/Help Scout plugin instance | Email Tools and Help Scout are different plugins with different message shapes — this can't be unified into one generic "email id." |
| `companyId` | the company the mailbox belongs to | Already the authorization boundary everywhere else in the app. |
| `mailboxKey` | e.g. `"personal"`, or a Help Scout mailbox id | Whatever the plugin already uses as its own mailbox identifier (`EmailMessageTarget.mailbox` today). |
| `folder` | IMAP folder, when applicable | Help Scout doesn't have folders in the same sense — this field is nullable per plugin. |
| `messageId` | the provider's own message id | For IMAP, the message's own `Message-Id` header value (stable across moves) is a better key than a UID (which is folder- and mailbox-relative and changes on move — a real, cited risk item below). |
| `conversationId` | Help Scout conversation id, or an email thread key | Handoffs are often about a whole thread, not one message. |

**Decision needed from Barry:** should a delegation key on the provider's
`Message-Id` (survives moves, but some providers don't expose it uniformly)
or on `(mailboxKey, folder, uid)` (matches what today's code already uses
everywhere, but breaks the moment the message is moved to another folder —
which `useEmailMessageActions.ts`'s own `handOff` mutation does immediately
after creating the issue, via `markRead`, though not a move; a *later* human
filing the email away would break a uid-based reference). This spec
recommends `Message-Id` where the plugin can supply it, falling back to
`(mailboxKey, folder, uid)` captured at delegation time with a documented
staleness caveat, but this is Barry's call, not a default to assume.

## 3. Delegation lifecycle (the actual state machine)

Proposed states, distinct from `issue.status` (which tracks the *work*, not
the *delegation*):

```
delegated → acknowledged → in_progress → needs_review → resolved
                                       ↘ handed_back ↗
                                       ↘ re_delegated (to a different agent)
```

- **delegated**: issue created, agent woken (or wake failed — tracked
  separately, see §4).
- **acknowledged**: the agent's first real action on the issue (first
  comment, first status change away from the initial one) — an existing
  signal (`issue.updatedAt` moving past `createdAt` isn't enough on its own,
  since automated fields can touch `updatedAt`; this needs a real "first
  meaningful agent action" event, which may already exist in the activity
  log this project has elsewhere — worth checking before inventing a new
  one).
- **in_progress / needs_review**: mirrors `issue.status`'s own `in_progress`/
  `in_review`, kept as a separate field only so the delegation's own history
  (who delegated, when, why) survives independently of whatever the issue's
  status does later (an issue can be reopened, reassigned to someone
  unrelated to the original delegation, etc. — the delegation record should
  not silently follow that and claim credit/blame for work it didn't
  originate).
- **handed_back**: the agent (or an automated stale-check) determines it
  cannot or should not continue — explicitly distinct from `resolved`. Must
  carry a required reason.
- **re_delegated**: a handback (or an operator's own decision) results in a
  *new* delegation to a different agent, referencing the previous one (a
  chain, not a silent overwrite — so "who touched this and when" stays
  answerable after several re-delegations).
- **resolved**: terminal. What "resolved" *causes* (a reply sent to the
  original sender? a note posted to the Help Scout conversation? nothing
  automatic at all, just a marker?) is explicitly **not decided here** — this
  is exactly the kind of behavior this project's standing rule says needs
  Barry's explicit product confirmation, not an inferred default. Options,
  roughly in order of how much new capability they need: (a) resolution is
  purely internal bookkeeping, no outbound action; (b) resolution optionally
  triggers the *existing* reply/note tools the agent already has, same as if
  a human clicked Reply — no new capability, just a suggested next action;
  (c) resolution can auto-send a reply the agent drafted, gated behind the
  same outbound-review policy this project already has for other agent sends.
  **Verified, not just assumed:** this policy is real —
  `ui/src/pages/InstanceGeneralSettings.tsx:143,251-266`,
  `outboundToolDraftMode`, "Hold outbound messages for approval," and its own
  description explicitly names "agent emails" as covered. When on (the
  default), any agent-sent email already waits in Approvals — so option (c)
  costs less than it first looks: it doesn't need a new gate, only wiring
  resolution to call the tool the agent would use anyway, which the existing
  policy already intercepts.

## 4. Failure, concurrency, and integrity — the risks this record actually has to survive

The project's own instruction for this bullet says to design for: "partial
handoff/wake failures, retries/idempotency, concurrent human/agent actions,
source deletion/moves, stale state and unauthorized access." Concretely,
against the real system:

1. **Partial failure, already partially solved.** The wake-failure case is
   already handled (P2, this session) at the *issue* level. A delegation
   record adds one more failure point: writing the delegation row itself. If
   the issue creation succeeds but the delegation-row write fails (a crash
   between the two, or a second write in the same transaction rolling back
   for an unrelated reason), the issue exists with no delegation tracking it
   — the same "invisible failure" class this session fixed for wake, now one
   layer up. **Decision needed:** should issue-create and delegation-row
   write be one transaction (issue creation fails if the delegation write
   would fail — a bigger blast radius, since issue creation is otherwise
   reliable today) or two steps with a reconciliation sweep (a periodic job
   that finds issues with an email origin marker but no delegation row, and
   either backfills or flags them)? This project's existing heartbeat/
   recovery services (`server/src/services/recovery/service.ts`) may already
   have an established pattern for this class of problem — worth reading
   before designing a new one.
2. **Idempotency beyond the single wake call.** The existing
   `idempotencyKey: \`email-handoff:${issue.id}\`` only protects one wake.
   Re-delegation, handback, and a retried delegation attempt after a network
   error all need their own idempotency keys, ideally derived from the
   *source* identity (§2) rather than the issue id, so that "did we already
   delegate this exact email" is answerable even before an issue exists yet
   (preventing a genuine double-create from a retried click, not just a
   double-wake of an issue that already exists).
3. **Concurrent human/agent actions.** Two real races: (a) a human resolves
   the issue in the UI at the same moment the agent posts a comment that
   would have moved the delegation to `needs_review` — last-write-wins on
   `issue.status` already exists and is a separate, unrelated concern; the
   delegation record's OWN state needs the same kind of optimistic-concurrency
   guard (a version/updatedAt check on write) so a stale `resolved` doesn't
   silently overwrite a fresher `handed_back`. (b) a human manually replies to
   the original email (outside the app's own agent flow) while a delegation is
   still open — the delegation has no way to know this happened unless the
   plugin's own poll/webhook path surfaces it as an event the delegation
   record can react to. **Not solved here** — needs the plugin's own event
   model checked (which this spec deliberately hasn't gone into
   `paperclip-extensions` to inspect, per this project's cross-repo
   coordination rule).
4. **Source deletion or moves.** If the original email is deleted or moved to
   Trash after delegation (a human decides it's noise, unrelated to the
   agent's work on the issue), the delegation record's source reference goes
   stale. This should be a **non-fatal, visible** state — "source
   unreachable" shown on the issue, not a silent broken reference and not a
   deletion of the delegation record itself (the issue and its work are
   real regardless of what happened to the source email).
5. **Stale state.** A delegation stuck in `delegated` (never acknowledged)
   for longer than some threshold is exactly the shape of problem this
   project's existing attention-queue service already solves for other
   sources (`server/src/services/attention-queue.ts`, confirmed this session
   to already correctly distinguish waiting/failed/review states from real
   evidence) — a stale delegation should very likely surface there rather
   than inventing a second "things are stuck" surface. **Recommendation, not
   a decision:** extend the attention queue rather than build a parallel one.
6. **Unauthorized access.** The delegation record's `companyId` is the
   authorization boundary already used everywhere else (confirmed this
   session, extensively, across every file this bug class was found in) — a
   delegation must inherit the SAME company-scoped access check the issue
   and the mailbox both already have, not a fourth copy of that logic.

## 5. What reuses existing data vs. what needs a migration

**Reuses, no migration:**
- `issues.originKind` / `originId` / `originRunId` / `originFingerprint` — a
  new `originKind` value (e.g. `"email_handoff"`) fits the existing enum
  shape (`packages/shared/src/constants.ts:180`, `ISSUE_ORIGIN_KINDS`) with
  no schema change, same pattern `routine_execution` already uses. This
  alone would answer "is this issue from an email" and "which mailbox," but
  NOT the lifecycle state machine in §3 — that needs somewhere to live that
  `originId` (a single string) can't hold on its own.
- The existing attention-queue service, if §4.5's recommendation is taken,
  for surfacing stale delegations — no new surface, a new row-source inside
  an existing one.
- The existing outbound-review policy (`outboundToolDraftMode`,
  `InstanceGeneralSettings.tsx` — confirmed to already cover agent-sent
  email) for §3's resolution-triggers-a-reply option (c). No new gate needed
  if that option is chosen.

**Needs a migration (new table, working name `issue_email_delegations`):**
- id, issueId (FK), companyId, pluginId, source identity fields (§2),
  delegation state (§3), delegatedByUserId/AgentId, delegatedAt,
  acknowledgedAt, resolvedAt, resolutionNote, previousDelegationId (nullable,
  for the re-delegation chain), a version/updatedAt column for the
  concurrency guard in §4.3.
- This is additive only (a new table, no changes to existing tables) — lower
  risk than an alter-in-place migration, and reversible by simply dropping
  the new table if this whole feature needs to be rolled back, without
  touching `issues` or any plugin's own tables at all.

**Explicitly not proposed:** any change to how the plugin itself stores or
polls mail. This spec only concerns the host app's own delegation-tracking
layer.

## 6. What this spec is NOT deciding

Per this project's standing rule ("Decline wrong functionality... separate a
genuine bug/restore from net-new behavior and confirm product changes
explicitly"), none of the following are assumed, and none should be built
without Barry answering them first:

- Whether resolution ever sends anything automatically (§3's option c).
- Whether `Message-Id` or `(mailbox, folder, uid)` is the source key (§2).
- Whether issue-create and delegation-write should be one transaction or two
  steps with reconciliation (§4.1).
- Whether stale delegations join the existing attention queue or get their
  own surface (§4.5, recommended but not decided).
- Timeline, priority relative to P3/P4's remaining flagged items, or whether
  P5a should happen before P5b/P5c.

## Next step

This document is the "specify" and "design" bullets of P5a's checklist. The
next P5a bullet — "decide what can reuse vs needs migration, present for
approval" — is §5 above, already presented. Implementation does not start
until Barry has read this and either approved it, corrected it, or told this
project to drop the idea.
