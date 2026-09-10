# P5b specification: plain-language Start work to a reviewed plan

Status (2026-09-06): **built in the working tree, tested, and checked end to
end on a throwaway instance. NOT yet live.** The live instance on port 3100
still runs the code from before this feature (its `/start-work/plan` route
answers `404 API route not found`, checked 2026-09-06), and migration 0097 has
not been applied to it. Both need a server restart that the operator must approve
(see "What goes live when, and what needs the restart" below).

## The one thing to decide, stated plainly for the operator

Drafting a plan writes two rows BEFORE anyone accepts anything: one **request
issue** (the container) and one **plan card** (a `suggest_tasks` interaction)
hanging off it. Nothing else. No task, no agent run, no wake, no routine.

That is a labelled exception to "nothing is created until a board user
accepts", and the reason is mechanical: a reviewable card must belong to an
issue (`issue_thread_interactions.issue_id` is NOT NULL with a foreign key),
so a card cannot exist on its own. The container is inert by verified code:

- it is created with status `backlog` and no assignee
  (`server/src/services/start-work.ts:702`), and
  `server/src/services/issue-assignment-wakeup.ts:31` returns early when the
  assignee is null or the status is backlog;
- the continuation wake after a decision returns when the issue has no
  assignee (`server/src/routes/issues.ts:217-240`);
- the PATCH wake block requires status not backlog
  (`server/src/routes/issues.ts:2733`); nothing polls unassigned backlog
  issues.

Rejecting cancels the container. Accepting hands it to the company's lead.
The screen never claims "nothing was created": the plan header says a request
issue exists and links to it.

If the operator does not want even the container written before accept, the only
alternative is a nullable `issue_id` migration on the interaction table, which
touches the pinned accept path and is the less reversible choice. That is why
this spec went the other way.

## What shipped (working tree, 2026-09-06)

Everything below is real, current code, cited by file and line.

### Shared building blocks

- `packages/shared/src/start-work.ts:25` `START_WORK_ORIGIN_KIND = "start_work"`.
  Deliberately NOT added to `ISSUE_ORIGIN_KINDS` and NOT client-declarable
  (`clientDeclarableIssueOriginSchema` stays limited to the email handoff
  kind), following the email handoff pattern from P5a. Only the plan route can
  mint a container with this kind.
- `packages/shared/src/start-work.ts:33` `MAX_START_WORK_TASKS = 12`;
  `:44` `startWorkInteractionIdempotencyKey(requestKey)` = `start-work:<key>`.
- `packages/shared/src/validators/start-work.ts:12-15` the request body
  (`text` 3 to 2000 characters, `requestKey` uuid; no `companyId`, so a body
  cannot point the plan at another company); `:27-35` the only shape the
  planner model may return (`clientKey`, `parentClientKey`, `title`, `why`,
  `priority`, `assigneeAgentId`, `needsPlugins`; nothing maps to
  `hiddenInPreview`, `parentId`, `projectId`, `goalId`, `billingCode`,
  `labels` or `assigneeUserId`); `:39-43` the output schema capped at 12
  tasks; `:70-108` the response body the dialog renders from.
- `packages/shared/src/validators/text.ts:22-26` `stripDashes`: every em or en
  dash in model text becomes a comma and a space, applied at the one point
  model text enters the database (`start-work.ts:193-200`, `:515`).

### Server

- **Route** `POST /companies/:companyId/start-work/plan`,
  `server/src/routes/start-work.ts:25-36`, mounted right after the starter
  catalog routes (`server/src/app.ts:266`). Company binding is the path
  parameter and nothing else. Access: `assertCompanyAccess(req, companyId,
  "write")` then `assertBoard(req)` (`:30-31`), the same order the accept route
  uses, so agents, tool sessions, viewers and foreign companies get 403 before
  the service runs. 201 for a fresh plan, 200 for a repeated request key
  (`:35`).
- **Service** `server/src/services/start-work.ts`. In order:
  1. Existing plan for this key: found through `issues_company_origin_idx`
     (companyId, originKind `start_work`, originId = requestKey) and returned
     unchanged with no second AI call (`findContainer` `:340`, `findExisting`
     `:445`). The header facts that cannot be rebuilt from the card, the
     left out list and the recurring note, are read back from the plan's own
     activity row (`storedPlanNotes` `:419`), so a repeat of the same key
     shows the same header the first answer showed. Only the model name is
     deliberately blank, because a repeat calls no model.
  2. Rate limit: at most 10 fresh drafts per person per company per ten
     minutes, counted in memory. Over that answers 429 (`assertPlanRateLimit`
     `:94`, called at `:635`, message at `:67`). A repeat of a request key
     never reaches it, because a repeat never calls the model.
  3. Usable roster: agents not paused, terminated or waiting for approval,
     the same shared list `pickAssigneeForCompany` uses
     (`UNASSIGNABLE_AGENT_STATUSES`,
     `server/src/services/starter-catalog.ts:96-100`; roster query at `:375`).
     Empty roster answers 422 before any AI call (`:638`, message at `:61`).
  4. Model: `pickOneShotModel()` (`server/src/services/chat-providers.ts:1569`,
     native anthropic, openai, gemini first, then
     `PAPERCLIP_CHAT_DEFAULT_MODEL` when its provider is configured, then
     discovered adapter models, null when nothing is set up). Null answers 503
     before any write (`:641`, message at `:63`).
  5. One model call through the shared `completeOnce`
     (`server/src/services/llm-one-shot.ts:63`), one repair round quoting the
     exact problems, then 422 (`:498-546`, message at `:65`). "Problems"
     covers the parent rules as well as the schema: a task naming a parent
     that does not exist, or a set of tasks sitting under each other in a
     loop, is quoted back to the model for its one repair round
     (`plannerParentProblem` `:220`). The prompt holds only this company's
     facts: name, usable roster with role, title and capabilities, ready
     plugin keys, routine titles, the seven starter cards and which ones the
     words match (`:276` onward).
  6. `normalisePlan` (`:556-627`): dashes stripped, whitelisted fields only,
     an assignee outside the roster replaced by the company's lead (`:586`),
     any task whose `needsPlugins` names a plugin that is not installed and
     ready is removed and listed under `leftOut` with the starter cards' own
     words (`blockersForPlugins`, `:570`), and the parent tree is checked
     again with `buildTaskCreationOrder` (`:620`), the same function accept
     uses (`server/src/services/issue-thread-interactions.ts:251`). Anything
     still failing here is the model failing twice, so it gets the same plain
     "could not turn that into a plan" sentence every other unusable answer
     gets, never `buildTaskCreationOrder`'s own developer wording.
  7. One activity row is written BEFORE the model is called
     (`issue.start_work.plan_requested` against the company, `:670`), so
     somebody driving this route hard is visible in the log even when every
     draft then fails.
  8. One transaction writes the container (backlog, nobody assigned,
     originKind `start_work`, originId = requestKey, title `Request: <first
     line>`, the operator's words as description; `:702`), the pending card
     (idempotency key `start-work:<key>`, `wake_assignee_on_accept`, a footer
     on every task naming the request identifier; `:715-729`), and the
     `issue.start_work.planned` activity row that carries the header facts a
     repeat has to be able to repeat (`:738`). One more activity row,
     `issue.thread_interaction_created`, is written after the commit (`:771`).
  9. Concurrency: a per-process in-flight map collapses simultaneous submits
     of one key onto one promise (`:164`, `:820-832`); a second container from
     another process trips the 0097 unique index (23505) and the first one is
     returned (`:204`).
- **Accept hook** `issue-thread-interactions.ts:1020-1057`, inside
  `acceptSuggestedTasks`, AFTER the once-only claim and after every child is
  created, in the same transaction: the container moves backlog to todo, is
  assigned to `pickAssigneeForCompany` evaluated now (a lead paused since
  drafting is never handed the request), and its description gains an
  `## Accepted plan` section listing every created identifier plus anything
  the reviewer unticked (`:210`). It comes back as `continuationIssue`, which
  the existing accept route already passes to the continuation wake and logs
  as `issue.updated` with source `start_work_accept`
  (`server/src/routes/issues.ts:3375-3380`; `request_confirmation_accept` is
  unchanged for request confirmations). A 409 or a failed child leaves the
  container in backlog and unassigned.
- **Reject hook** `issue-thread-interactions.ts:1113-1152`: reject runs in
  a transaction and cancels a start_work container (`:1144-1148`). No wake.
- **Both hooks fire only for the plan's own card** (`isStartWorkPlanCard`,
  `:193`): the card being decided must carry the idempotency key
  `start-work:<originId>` of the container it sits on, and the container must
  still be `backlog` with nobody assigned. Once the plan is accepted the lead
  keeps working on the request and its own later `suggest_tasks` cards land on
  the same issue; accepting one of those must not hand the request over a
  second time (resetting the status, replacing the assignee and dropping the
  running agent's lock) and rejecting one must not cancel the whole request
  out from under its live children. Any card that fails the test falls through
  to the ordinary `touchIssue` an ordinary issue gets. Ordinary
  `suggest_tasks` cards on ordinary issues are untouched by both hooks
  (`getStartWorkContainer`, `:160`, only matches originKind `start_work`).
- **Brief wording** `server/src/services/attention-queue.ts:226-260`: a
  pending card created by a person and not by an agent (`askedByPerson`,
  `:230`) reads "Plan waiting for your decision" when untitled (`:247-249`),
  is `waiting` not `stopped` (`:252`), and its consequence is "No tasks are
  created until you accept it. Waiting costs nothing." (`:255-260`). The
  wording is about the tasks, not the request: the request issue this row
  links to does exist already, so promising that "nothing is created" would be
  contradicted by the very link beside it. Agent created cards keep their
  existing wording.
- Helpers extracted so there is one copy: `pluginStateByKey`,
  `blockersForPlugins`, `pickAssigneeForCompany`, and the shared
  `UNASSIGNABLE_AGENT_STATUSES` list they all filter on
  (`server/src/services/starter-catalog.ts:110`, `:124`, `:159`, `:96`);
  `pickOneShotModel` (chat-providers) which the AI rewrite route now also
  uses (`server/src/routes/agents.ts:2302-2304`); `completeOnce` and
  `parseJsonObject` (llm-one-shot) which plugin `ai.complete` now calls;
  `serviceUnavailable` 503 helper (`server/src/errors.ts:42-44`).

### UI

- `ui/src/api/startWork.ts` posts the words plus a browser-minted
  `requestKey` to the plan route.
- `ui/src/lib/company-access.ts` `canWriteCompany`, lifted from the run
  ledger, hides "Draft a plan" and "Turn this on" from viewer-only members and
  shows "You can browse this company, but only members who can create work can
  start it." (`ui/src/components/StarterCatalogDialog.tsx:404`). The plan
  card's accept and reject buttons are left on screen and switched off rather
  than hidden, with "Your role in this company can read this plan but not
  accept or reject it. Ask an admin for a role that can create work."
  underneath (`:502-520`). The server refuses viewers regardless.
- The access answer has three states, not two (`:90-103`). While the check is
  still running the buttons stay on screen and disabled behind "Checking your
  access..." (`:398-406`). If the check fails the panel says "Could not check
  your access. Close and try again." (`:409-413`) and says nothing about the
  person's role. The browse-only sentence is only shown once the answer is
  really in and really says viewer.
- `ui/src/components/StarterCatalogDialog.tsx`: Enter and the "Draft a plan"
  button share one submit path (`:159-179`); the box and button are disabled
  behind "Drafting your plan. This can take up to a minute." (`:418`); the
  header lines are all server facts (`:562-630`); matched starter cards keep
  their ordinary "Turn this on" button (`:697`), which remains the only way a
  routine is created; the existing `IssueThreadInteractionCard` renders the
  plan with "Accept drafts" / "Accept selected drafts"
  (`ui/src/components/IssueThreadInteractionCard.tsx:526`) and "Reject"
  (`:535`); a 409 is shown as "Someone already decided this plan" only when
  the server's own words were "Interaction has already been resolved", and any
  other 409 is shown as the sentence the server actually sent (`:202-221`);
  503 and 422 show the server's words plus "Create it as one issue instead"
  (`:430-442`), which opens the normal New issue form with the words filled
  in; the receipt names the real owner read back from the container
  (`:245-282`).
- **Receipts.** Accepting shows "Plan accepted" with "Created N tasks under
  <identifier>" and then one owner line (`:253-286`). The owner line reads
  "Handed to <name>. It will pick this up on its next run.", or "Handed to
  <name>. <name> is paused by budget, so it will not start until the budget is
  raised." when the plan's warnings name that agent. It never says the agent
  has been woken, because the server queues the wake without waiting for it
  and the wake can still be refused. If nobody was handed the request the line
  reads "Nobody was handed the request; open <identifier> and assign it"; if
  the container could not be read back at all it reads "Nobody could be
  confirmed; open <identifier> to check who has it", so a read failure after a
  successful accept never reads as a failed accept. Rejecting shows its own
  receipt too: "Plan rejected" with "Request <identifier> was cancelled.
  Nothing was started." (`:306-317`).
- Copy: the card's skip notice now reads "will be skipped if you accept."
  (`ui/src/components/IssueThreadInteractionCard.tsx:509`); the dialog and the
  starter catalog service dropped their em dashes; no rendered string on this
  path says "interaction" or "delegation".

## Decisions (with the code that carries them)

- **Surface.** The existing "What do you want done?" dialog
  (`ui/src/components/Sidebar.tsx:58` opens `StarterCatalogDialog`) hosts
  typing, drafting and review. The plan is an ordinary `suggest_tasks` card,
  so the same card shows on the request issue's page and as a Brief row with
  no new UI. Clippy is out (its actor is a tool session that `assertBoard`
  rejects on every interaction route).
- **Who owns the request.** `pickAssigneeForCompany` (CEO, then an officer,
  then any agent that is not paused, terminated or waiting for approval), at
  plan time for the "Lead:" line and again at accept time inside the
  transaction. Waiting for approval counts as unusable because accept itself
  refuses such an agent with a 409, so offering one would draft a plan nobody
  could ever accept. If it returns null at accept time the container moves to
  todo unassigned and the receipt says "Nobody was handed the request; open
  <identifier> and assign it". A company with no usable agent is refused at
  plan time (422) before any AI call.
- **Which model, and with no model.** `pickOneShotModel`; null answers 503
  with "No AI model is set up yet, so a plan cannot be drafted. Add one under
  Instance settings, then try again. Nothing was created." before any write.
- **What the model is told.** Only this company's facts (roster, ready
  plugins, routine titles, starter cards). Open issue titles and other
  companies' data are excluded on purpose.
- **Making the output safe.** Fail closed: dash stripping, schema validation,
  whitelisted fields, cap of 12, roster check with replacement, plugin
  readiness check with `leftOut`, parent tree check. The one repair round
  covers the schema and the parent tree alike, so a made up parent or a loop
  is quoted back to the model rather than surfacing later as wording written
  for developers. The left out titles and count are written into the card
  summary so the issue page is honest too.
- **No editing before accept.** Untick or reject and retype. The accept
  schema is unchanged.
- **Routines and broadcasts are not created here.** The header carries a
  note with a real link to `/routines` when the request sounds recurring, and
  a line linking to `/portfolio-directives` when the company is the portfolio
  root. A "Make it repeat" button that could not do it would be a fake
  affordance.
- **Cost and consequences on screen.** "Starts the moment you accept, and
  runs once." "Creates N tasks in <company> under <identifier>." "Drafted by
  <model>. Drafting used one AI call; it is not charged to any agent budget."
  The outbound line reads `instanceSettingsService.getGeneral().outboundToolDraftMode`.
  One line per agent paused by budget (`budgets.getInvocationBlock`). No
  money estimate and no per-task outward claims, because those would come
  from the model's own say-so.
- **Idempotency, four layers.** Browser-minted key with the box disabled
  while pending; server lookup before the AI call; per-process in-flight map;
  migration 0097's partial unique index.
- **A ceiling on drafting, not real metering.** Ten fresh drafts per person
  per company per ten minutes, counted in memory, answering 429 with "You have
  asked for a lot of plans in a short time. Wait a few minutes and try again.
  Nothing was created." Each draft is up to two AI calls charged to the
  instance and not to any agent's budget, so without this any member who can
  create work can spend without limit. It is a speed bump against a script,
  not accounting; real per-call cost accounting stays deferred. Every plan
  request is also written to the activity log before the model is called, so
  heavy use is visible even when every draft then fails.
- **HTTP vocabulary.** 503 no model; 429 too many plans in ten minutes; 422 no
  usable agent or unusable plan; 400 validation; 403 agent, tool session,
  viewer or foreign company; 201 new; 200 repeated key. Accept and reject keep
  their statuses; a 409 is shown as "Someone already decided this plan" only
  when the server sent that exact refusal, and any other 409 is shown in the
  server's own words.

## Migration 0097 (presented for approval; not applied to the live instance)

File: `packages/db/src/migrations/0097_start_work_request_container.sql`,
journal entry idx 97, mirrored as `startWorkRequestIdx` in
`packages/db/src/schema/issues.ts:140-142`.

```sql
CREATE UNIQUE INDEX IF NOT EXISTS "issues_start_work_request_uq"
  ON "issues" USING btree ("company_id","origin_id")
  WHERE "origin_kind" = 'start_work'
    AND "origin_id" IS NOT NULL;
```

Rollback:

```sql
DROP INDEX IF EXISTS "issues_start_work_request_uq";
```

Additive only. It cannot fail on existing data because no `start_work` rows
exist anywhere yet. It deliberately ignores status and `hidden_at` (unlike
the recovery indexes in 0070) so a cancelled container keeps its key and a
retry after reject hands back the rejected plan instead of drafting again.
`pnpm generate` in packages/db reports no schema drift and the migration
numbering check passes.

Same warning as P5a: pending migrations auto-apply on server start in a
non-interactive context (`server/src/index.ts:185`,
`promptApplyMigrations` returns true when stdin is not a TTY), which is how
the live instance runs. So the next restart of the live server applies this
index. That is the approval being asked for.

## What goes live when, and what needs the restart

The live instance on port 3100 is started by `paperclipai run` through tsx
without a file watcher (the process command line is
`node cli/node_modules/tsx/dist/cli.mjs scripts/_run-with-clean-env.mjs`),
serves the UI through Vite dev middleware (`@vite/client` is in the served
HTML), and resolves `packages/*` from source.

- `ui/` and `packages/shared` changes are live now, no restart. The dialog
  already has "Draft a plan", but pressing it against the old server gets
  `404 API route not found`, which the dialog shows as its failure text.
- `server/` changes (route, service, accept and reject hooks, Brief wording)
  and migration 0097 need the server restarted. The operator approves that; nobody
  else restarts it, because the instance is shared and holds live
  workspaces.

## Runtime check (numbered; observed 2026-09-06, real identifiers)

The operator's rule is to check the running app, not just tests. This run happened
before the review described at the end of this document, so a few of the
sentences it saw on screen have since been reworded. The quotes below have
been brought back in line with what the code renders now, and the reworded
lines are listed under "What changed after the review". The live instance
cannot run these steps until it is restarted (step 0 proves it), so the
check was run against a throwaway instance started from this working tree:
`PAPERCLIP_HOME` under the session scratch directory, instance id
`p5bcheck`, server on **3199**, its own embedded Postgres on **54331**,
`deploymentMode` `local_trusted`. Nothing touched 3100 or 54329. Company
"P5b Check Co" (`c0ac2b1d-ceb5-4a2e-a950-219c81f9d48e`, prefix PBC) with two
agents on the `process` adapter running `node -e "console.log('noop run')"`
so accepting could wake them without spending any AI: Ada (CEO)
`16a8ae2a-ddcd-4221-91e1-0c55d079c2a0` and Bea (Writer)
`2fa8d69e-bc3f-42d8-835b-429219794cea`. The planner itself used a real
model through the Claude Code adapter (`adapter:claude_local:claude-opus-5`).

0. Live instance, before restart: `POST http://127.0.0.1:3100/api/companies/<any>/start-work/plan`
   answered `404 {"error":"API route not found"}`. `GET /api/health` 200.
   Confirms the live server runs the old code.
1. `POST /api/companies/c0ac2b1d.../start-work/plan` as the board user, text
   "Chase up the three customers whose invoices are more than 30 days late,
   and send me a short summary of what they said", requestKey
   `01dff1cf-5df3-4329-88a5-ab026cf2b27a`: **201 in 25.7 s**. Database:
   exactly one issue `PBC-1` (`df7fc3c1-f93f-469c-8882-56ea887db33f`), status
   `backlog`, `origin_kind` `start_work`, `origin_id` = the key, no assignee;
   exactly one card `1277f2fb-b486-4f18-b3f9-a669c2289fda`, `suggest_tasks`,
   `pending`, `wake_assignee_on_accept`, idempotency
   `start-work:01dff1cf-...`, `created_by_user_id` `local-board`; zero rows in
   `agent_wakeup_requests`. Response header facts: lead Ada (CEO), 5 tasks
   (four to Ada, one to Bea), leftOut empty, warnings empty, outboundHold
   true, soundsRecurring true with the note "Chasing overdue invoices is
   usually a monthly job, so this could run on a schedule.", matchedCards
   `confirm-backups-ran` and `monday-morning-brief`.
2. Same body and same key again: **200 in 0.013 s**, same issue id and same
   card id, still one container and one card. No second AI call (the log
   shows no planner activity for the repeat).
3. Same route with an agent API key for Ada and a fresh key
   `b04425f4-1de0-4c5c-b49f-a3c1a9dc768a`: **403 `Board access required`**,
   still one container and one card. The viewer case cannot be reproduced on
   a `local_trusted` instance (it has no memberships, every request is the
   implicit board user); it is pinned by
   `server/src/__tests__/start-work-routes.test.ts` (viewer membership gets
   403, service never called).
4. Browser, throwaway instance: sidebar "What do you want done?", typed "Get
   three quotes for a new office printer and tell me which one to buy",
   pressed Enter. The box and button greyed out behind "Drafting your plan.
   This can take up to a minute." and the catalog stepped aside. About 55 s
   later the panel showed three matched starter cards (each with "Turn this
   on"), then the header: "Lead: Ada (CEO). The lead tracks the whole
   request; each task goes to the agent named on it." / "Starts the moment
   you accept, and runs once." / "Creates 7 tasks in P5b Check Co under
   PBC-2." / "Drafted by adapter:claude_local:claude-opus-5. Drafting used
   one AI call; it is not charged to any agent budget." / "Emails, messages,
   calls and public posts the agents draft will wait for your approval
   first.", then the card (7 draft issues, "proposed by You"). Unticked
   "Draft the reply to the winning supplier and polite notes to the other
   two" ("6 of 7 draft issues selected"), clicked "Accept drafts". Receipt:
   "Plan accepted" / "Created 6 tasks under PBC-2" / "Handed to Ada (CEO). It
   will pick this up on its next run." / "Left out by you: 1". Database:
   children `PBC-3` to `PBC-8` under `PBC-2` with the tree the card showed (`PBC-5` and `PBC-6`
   under `PBC-4`, `PBC-8` under `PBC-7`), `PBC-5` assigned to Bea and the
   rest to Ada; activity log for `PBC-2`: `issue.updated`, source
   `start_work_accept`, `backlog` to `todo`, assignee Ada, at 04:33:18.058;
   `PBC-2`'s description gained "## Accepted plan" listing PBC-3 to PBC-8 and
   "Left out by the reviewer: Draft the reply to the winning supplier and
   polite notes to the other two"; `routines` count for the company 0 before
   and after; the Brief's "Awaiting your tap" dropped from 2 to 1 and the
   PBC-2 row was gone. Because the throwaway agents answer instantly, Ada's
   runs then picked the work up and moved `PBC-2` and the children to
   `in_progress` themselves within seconds; the accept itself set `todo`, as
   the activity row shows. Card `1eaeb6a7-a953-432c-8f59-6a898c8ee9f7` is
   `accepted`, key `e2c82f1d-6302-4bd0-abe6-bd19ff977f2a`.
5. Drafted a third plan ("Plan a small thank-you event for our ten best
   customers next month", 10 tasks, `PBC-9`, card
   `0a4d4d5b-c0c3-4563-b6d4-019deea6518e`, key
   `ab6b0b2f-e9d8-4e81-86e8-5e29db33145d`), closed the dialog with its X.
   Brief showed "2 waiting" with the row "Plan for: Plan a small thank-you
   event for our ten best customers next month" / "No tasks are created until
   you accept it. Waiting costs nothing." / "Nothing happens until you
   decide." / "Answer". Clicked the row: it opened
   `/PBC/issues/PBC-9#interaction-0a4d4d5b-...` with Status Backlog,
   Unassigned, and the same card with "Accept drafts" and "Reject". Clicked
   "Reject", then "Save rejection" (the reason box is optional). Status
   became Cancelled, the card "Rejected", "Resolved by You". This reject was
   done from the issue page, so no receipt appears; rejecting from inside the
   dialog now shows one (see step 7 of the click steps). Database:
   `PBC-9` `cancelled`, no assignee, zero children; card `rejected`;
   assignment wakes unchanged (Ada 5, Bea 1, all from step 4). Brief back to
   "1 waiting" (only PBC-1).
6. Extra, from the invariants: repeating `PBC-2`'s key after accept answered
   200 with the `accepted` card; repeating `PBC-9`'s key after reject
   answered 200 with the `rejected` card. Neither drafted again.

One thing seen during step 4 that is NOT this feature's code, recorded so it
is not lost: Ada was a brand-new agent and six wakes landed on her at once
(the container plus five tasks). Four of her first runs failed with
`duplicate key value violates unique constraint "agent_runtime_state_pkey"`.
`ensureRuntimeState` in `server/src/services/heartbeat.ts:2709-2723` is a
read-then-insert with no `ON CONFLICT`, so an agent's very first concurrent
runs race on that insert. The tasks stayed assigned and later runs succeeded.
Any accept that wakes several tasks for a never-run agent can hit this; it
is worth its own small fix (`onConflictDoNothing` plus a re-read).

## The operator's click steps on the live instance (after the restart he approves)

This is behavioural, not a redesign: the only visual difference is the new
"Draft a plan" button next to the box and what appears after it.

1. Left sidebar, under "New issue": click **"What do you want done?"**.
2. In the box (placeholder "Type it however you'd say it out loud") type what
   you want in your own words. Press **Enter** or click **"Draft a plan"**.
3. Wait while it shows "Drafting your plan. This can take up to a minute."
   (the box and button are greyed out; a second Enter does nothing).
4. Read the header lines ("Lead: ...", "Starts the moment you accept, and
   runs once.", "Creates N tasks in <company> under PBC-x.", "Drafted by
   ...", the approval line, and any "Left out, and why" list). Any matching
   ready-made starter sits above the plan with its own **"Turn this on"**
   button; typing and Enter never switch one on.
5. Untick anything you do not want (click the checkbox on the task; a parent
   unticks its children). Click **"Accept drafts"** (it reads **"Accept
   selected drafts"** once something is unticked).
6. The receipt reads "Plan accepted", "Created N tasks under PBC-x", then
   "Handed to <lead>. It will pick this up on its next run." and, if you
   unticked, "Left out by you: N". If that lead is paused by budget the middle
   line instead reads "Handed to <lead>. <lead> is paused by budget, so it
   will not start until the budget is raised." Click the PBC-x link to see the
   request issue with the children.
7. To reject instead: click **"Reject"**, optionally type a reason, click
   **"Save rejection"**. The receipt reads "Plan rejected" and "Request PBC-x
   was cancelled. Nothing was started." The request issue is cancelled and
   nothing else exists.
8. If you close the panel without deciding: sidebar **"Brief"**, under
   "Awaiting your tap" the row "Plan for: ..." with "No tasks are created
   until you accept it. Waiting costs nothing." Click the row (its label is
   "Answer") to open the request issue at the card; the same "Accept drafts"
   and "Reject" work there.
9. With no AI model set up the panel says "No AI model is set up yet, so a
   plan cannot be drafted. ..." and offers **"Create it as one issue
   instead"**, which opens the normal New issue form with your words filled
   in.

## Deferred (agreed not to build in v1)

- Editing a plan before accepting (retitle, reassign, reprioritise, reorder,
  due dates): needs a change to the accept schema or a reject-old-create-new
  pattern on a pinned primitive. Untick or reject and retype is the contract.
- "Me" (the accepting user) as a task or umbrella owner: v1 refuses to draft
  when the company has no usable agent and offers the New issue form.
- Creating routines or portfolio broadcasts on accept: a second accept path,
  non-transactional with task creation. The header links to `/routines` and
  `/portfolio-directives` instead.
- Per-task "this one sends email" lines: would come from the model's own
  declaration, which the agent is not bound by at run time.
- Metering or budgeting the planner call itself, beyond the cheap ten drafts
  per ten minutes ceiling: nothing meters Clippy turns or `ctx.ai.complete`
  either; the header says one AI call was made. Real per-call cost accounting
  stays for later.
- A dedicated "plan" attention kind with its own icon and dismiss label: v1
  rewrites the question row's wording only.
- Expiry of an undecided plan: an abandoned plan sits in the Brief until
  someone rejects it.
- Planner context beyond roster, plugins, routines and starter cards.
- The starter catalog activate route (`server/src/routes/starter-catalog.ts:46`)
  has no `assertBoard`, so an agent key can switch a card on; out of scope,
  worth its own small fix.
- `listForCompany`'s per-card routine detail queries: a performance
  follow-up.
- Adapter-routed planning speed: an instance with only `claude_local` spawns
  a CLI per draft (25 to 60 s observed here). Acceptable with the waiting
  message; a cached or streaming planner is later work.
- Moving the "Accepted plan" record into a thread comment: `addComment` is
  not transaction-aware; the description section is atomic.
- The `agent_runtime_state` first-run race noted in the runtime check.
- The shared catalog's "Daily phone report" card prose still carries an em
  dash; it predates this feature and lives outside its files.

## What changed after the review

The document above was written when the feature was first built. A review then
found problems, and five fixes were applied. In plain words:

- Agents waiting for approval now count as unusable, alongside paused and
  terminated ones, so one is never offered and never named as the lead.
- The receipt no longer says the lead "has been woken". It says the lead will
  pick it up on its next run, or that it is paused by budget, or that nobody
  could be confirmed.
- Rejecting from the dialog now shows its own receipt saying the request was
  cancelled, instead of the panel simply emptying.
- The Brief row now says "No tasks are created until you accept it", because
  the request issue it links to does exist.
- One person can now ask one company for at most ten plans in ten minutes, and
  every plan request is written to the activity log before the model is called.
- The header facts are stored with the plan, so re-sending the same request key
  shows the same header rather than a blank one.
- A bad parent or a loop in the model's answer now gets the repair round,
  instead of failing later with wording written for developers.
- Accepting or rejecting only hands over or cancels the request for the plan's
  own card, not for a later card the working lead raises on the same request.
- The panel now says when it is still checking your access, and when that check
  failed, instead of treating either as "you cannot start work here".
